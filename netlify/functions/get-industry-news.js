// /netlify/functions/get-industry-news.js
// Node 18+ (fetch is built-in). No env vars needed.

const FEEDS = [
  // Canadian trucking industry (long-form posts)
  { name: "TruckNews", url: "https://www.trucknews.com/feed/?post_type=blog", weight: 2 },
  // Regional / Atlantic
  { name: "CTV Atlantic", url: "https://atlantic.ctvnews.ca/rss/ctv-news-atlantic-public-rss-1.822315", weight: 2 },
  { name: "Global Halifax", url: "https://globalnews.ca/halifax/feed/", weight: 2 },
  { name: "CBC Nova Scotia", url: "https://rss.cbc.ca/lineup/canada-novascotia.xml", weight: 3 },
  // Official provincial advisories (useful for closures/incidents)
  { name: "NS Traffic Advisories", url: "https://novascotia.ca/news/rss/traffic.asp", weight: 1 },
];

// Prefer Atlantic terms when picking articles
const ATLANTIC_TERMS = [
  "cape breton","sydney","nova scotia","halifax","dartmouth","antigonish",
  "newfoundland","new brunswick","pei","prince edward island","atlantic canada",
  "cbrm","port hawkesbury","glace bay","stellarton","truro","bridgewater","yarmouth"
];

export async function handler(event) {
  try {
    const limit = clampInt((event.queryStringParameters||{}).limit, 10, 1, 20);

    // 1) Fetch & parse feeds in parallel
    const rawItems = (await Promise.all(
      FEEDS.map(async f => {
        try {
          const res = await fetch(f.url, { headers: { "User-Agent": "NetlifyFunction/1.0" } });
          if (!res.ok) throw new Error(`${res.status}`);
          const xml = await res.text();
          const items = parseRSS(xml).map(it => ({ ...it, _source: f.name, _feedUrl: f.url, _weight: f.weight }));
          return items;
        } catch {
          return [];
        }
      })
    )).flat();

    if (!rawItems.length) return json(200, { data: [] });

    // 2) Normalize + try to ensure 2+ paragraph excerpts (fetch page if short)
    const enriched = await enrichItems(rawItems);

    // 3) Rank: prefer Atlantic mentions; then by recency
    const now = Date.now();
    const scored = enriched.map(it => {
      const hay = `${it.title} ${stripTags(it.excerptHtml)}`.toLowerCase();
      const atlHits = ATLANTIC_TERMS.reduce((n, term) => n + (hay.includes(term) ? 1 : 0), 0);
      const recencyDays = Math.max(1, (now - (new Date(it.dateIso||now)).getTime())/86400000);
      const score = (atlHits*10) + it._weight - Math.log(recencyDays+1);
      return { ...it, score };
    });

    // 4) Sort by score desc, then date desc; uniq by URL; cap to limit
    const uniq = [];
    const seen = new Set();
    for (const it of scored.sort((a,b)=> b.score - a.score || ((new Date(b.dateIso)) - (new Date(a.dateIso))))) {
      const key = (it.url||'').split('?')[0].toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      uniq.push(pickClientFields(it));
      if (uniq.length >= limit) break;
    }

    // Cache ~5 minutes
    return json(200, { data: uniq }, { "Cache-Control": "public, max-age=300" });
  } catch (e) {
    return json(500, { error: "Server error", details: String(e) });
  }
}

/* ---------------- helpers ---------------- */

function clampInt(v, def, min, max){
  const n = parseInt(v ?? def, 10);
  return isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

function stripTags(html=''){
  return html.replace(/<script[\s\S]*?<\/script>/gi,'')
             .replace(/<style[\s\S]*?<\/style>/gi,'')
             .replace(/<\/?[^>]+>/g,' ')
             .replace(/\s+/g,' ')
             .trim();
}

function firstParagraphs(html='', minParas=2, maxParas=4){
  // Grab the first few <p> tags from HTML
  const out = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < maxParas){
    const txt = m[1].trim();
    // ignore super-short/useless paragraphs
    if (stripTags(txt).length >= 40) out.push(txt);
  }
  // If still too short, fall back to splitting by periods
  if (out.length < minParas){
    const text = stripTags(html);
    const parts = text.split(/(?<=[.!?])\s+/).slice(0, 6);
    if (parts.join(' ').length > 120){
      // make para-sized chunks ~2 sentences each
      const paras = [];
      let buf = '';
      for (const sent of parts){
        buf += (buf ? ' ' : '') + sent;
        if (buf.length > 160){ paras.push(buf); buf=''; }
      }
      if (buf) paras.push(buf);
      while (out.length < maxParas && paras.length) out.push(paras.shift());
    }
  }
  return out.length ? `<p>${out.join('</p><p>')}</p>` : '';
}

function pick(s, ...keys){ const o={}; for(const k of keys) if (k in s) o[k]=s[k]; return o; }

function pickClientFields(it){
  return pick(it, 'title','url','dateIso','source','image','excerptHtml');
}

function json(status, body, extra={}){
  return { statusCode: status, headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) };
}

function parseTag(block, tag){
  const rx = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = rx.exec(block);
  return m ? m[1].trim() : '';
}
function parseMedia(block){
  // media:content or enclosure
  const m1 = /<media:content[^>]*url="([^"]+)"/i.exec(block);
  if (m1) return m1[1];
  const m2 = /<enclosure[^>]*url="([^"]+)"/i.exec(block);
  if (m2) return m2[1];
  return '';
}

function parseRSS(xml){
  // simple item splitter
  const items = [];
  const reItem = /<item[\s\S]*?<\/item>/gi;
  let m;
  while ((m = reItem.exec(xml))){
    const it = m[0];
    const title = decode(parseTag(it, 'title'));
    const link  = decode(parseTag(it, 'link'));
    const pub   = decode(parseTag(it, 'pubDate')) || decode(parseTag(it, 'dc:date')) || '';
    const desc  = decode(parseTag(it, 'description'));
    const enc   = decode(parseTag(it, 'content:encoded'));
    const media = parseMedia(it);
    items.push({ title, link, pubDate: pub, description: desc, contentEncoded: enc, media });
  }
  return items;
}

function decode(s=''){
  // very basic HTML entity decode
  return s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
}

async function fetchArticle(url){
  try{
    const res = await fetch(url, { headers: { "User-Agent": "NetlifyFunction/1.0" } });
    if (!res.ok) return null;
    const html = await res.text();
    const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] || '';
    // collect <p> tags (best-effort; avoids paywalled bodies)
    const paras = firstParagraphs(html, 2, 4);
    return { ogImage: og, parasHtml: paras };
  }catch{ return null; }
}

async function enrichItems(items){
  const tasks = items.map(async it => {
    const source = new URL(it.link || "https://example.com").hostname.replace(/^www\./,'');
    const dateIso = (it.pubDate ? new Date(it.pubDate) : new Date());
    // Prefer content:encoded; else description
    let bodyHtml = it.contentEncoded && it.contentEncoded.length > 60 ? it.contentEncoded : it.description || '';
    let excerptHtml = firstParagraphs(bodyHtml, 2, 4);

    // If still too short, fetch article and extract first paragraphs + OG image
    let image = it.media || '';
    if (stripTags(excerptHtml).length < 140 || !image){
      const fetched = await fetchArticle(it.link);
      if (fetched){
        if (stripTags(excerptHtml).length < 140 && fetched.parasHtml) excerptHtml = fetched.parasHtml;
        if (!image && fetched.ogImage) image = fetched.ogImage;
      }
    }

    return {
      title: it.title || '(untitled)',
      url: it.link,
      dateIso: isFinite(dateIso) ? dateIso.toISOString() : new Date().toISOString(),
      source,
      image,
      excerptHtml
    };
  });

  return Promise.all(tasks);
}
