// netlify/functions/get-truck-news.js
// Node 18+ (fetch built-in). One file deploy. No extra deps needed.

const FEEDS = [
  // Canada-first trucking + Atlantic/NS general news
  { name: 'TruckNews', url: 'https://www.trucknews.com/feed/' },                               // :contentReference[oaicite:0]{index=0}
  { name: 'Global Halifax', url: 'https://globalnews.ca/halifax/feed/' },                      // :contentReference[oaicite:1]{index=1}
  { name: 'CTV Atlantic', url: 'https://atlantic.ctvnews.ca/rss/ctv-news-atlantic-top-stories-1.1073369?ot=sdk.AjaxTarget&o=5' }, // :contentReference[oaicite:2]{index=2}
  { name: 'CBC Nova Scotia', url: 'https://www.cbc.ca/webfeed/rss/rss-ns' },                   // 
  { name: 'NS Gov – All News', url: 'https://news-feeds.novascotia.ca/en' },                  // JSON feed of NS releases (auto content) :contentReference[oaicite:4]{index=4}
  { name: 'NS Gov – Traffic Advisories', url: 'https://novascotia.ca/news/rss/' }             // landing lists traffic/news RSS :contentReference[oaicite:5]{index=5}
];

// Simple XML → items parser (no external libs)
function stripTags(html = '') {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}
function* eachItem(xml) {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/"items"\s*:\s*\[/i) ? [] : [];
  // Try RSS <item>
  const rssItems = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const raw of rssItems) yield { raw, type: 'rss' };
  // Try Atom <entry>
  const atomItems = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const raw of atomItems) yield { raw, type: 'atom' };
  // Try NS JSON feed (news-feeds.novascotia.ca returns JSON)
  if (/^\s*\{/.test(xml)) {
    try {
      const j = JSON.parse(xml);
      if (Array.isArray(j.items)) {
        for (const it of j.items) yield { json: it, type: 'json' };
      }
    } catch { /* ignore */ }
  }
}
function toAbs(href, base) {
  try { return new URL(href, base).toString(); } catch { return href || ''; }
}
function pickImageFrom(raw, base) {
  // Try media:content, enclosure, og:image in description
  const media = raw.match(/<media:content[^>]+url="([^"]+)"/i);
  if (media) return toAbs(media[1], base);
  const encl = raw.match(/<enclosure[^>]+url="([^"]+)"/i);
  if (encl) return toAbs(encl[1], base);
  const desc = getTag(raw, 'description');
  const img = (desc.match(/<img[^>]+src="([^"]+)"/i) || [])[1];
  if (img) return toAbs(img, base);
  return '';
}
const REGION_WEIGHT = [
  /cape\s*breton/i, /sydney\b/i, /\bns\b|\bnova scotia/i,
  /halifax/i, /antigonish/i, /port hawkesbury/i, /atlantic canada|new brunswick|pei|newfoundland/i
];

function scoreItem(t, sum) {
  const hay = `${t} ${sum}`.toLowerCase();
  let s = 0;
  for (const rx of REGION_WEIGHT) if (rx.test(hay)) s += 5;
  if (/truck|trucking|transport|tow|highway|wreck|semi|18[- ]?wheeler|fleet/i.test(hay)) s += 3;
  return s;
}

async function fetchText(u) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(u, { signal: ctrl.signal, headers: { 'User-Agent': 'NetlifyFunction/TruckNews' }});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(id); }
}

export async function handler(event) {
  try {
    const qs = event.queryStringParameters || {};
    const limit = Math.min(10, Math.max(1, parseInt(qs.limit || '10', 10)));

    const texts = await Promise.allSettled(FEEDS.map(f => fetchText(f.url).then(t => ({ f, t }))));

    const items = [];
    for (const r of texts) {
      if (r.status !== 'fulfilled') continue;
      const { f, t } = r.value;
      for (const blk of eachItem(t)) {
        if (blk.type === 'json') {
          const it = blk.json;
          const title = it.title || '';
          const link  = toAbs(it.url || it.external_url || '', f.url);
          const date  = it.date_published || it.published || it.date_modified || it.updated || '';
          const desc  = stripTags(it.content_html || it.summary || '');
          const image = it.image || '';
          if (!title || !link) continue;
          items.push({ source: f.name, title, link, date, image, summary: desc });
        } else {
          const raw = blk.raw;
          const title = stripTags(getTag(raw, 'title'));
          const link  = toAbs(getTag(raw, 'link') || (raw.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)||[])[1] || '', f.url);
          const date  = getTag(raw, 'pubDate') || getTag(raw, 'updated') || getTag(raw, 'published') || '';
          const desc  = stripTags(getTag(raw, 'description') || getTag(raw, 'summary'));
          const image = pickImageFrom(raw, f.url);
          if (!title || !link) continue;
          items.push({ source: f.name, title, link, date, image, summary: desc });
        }
      }
    }

    // De-dup by canonical link
    const seen = new Set();
    const canon = u => {
      try { const x = new URL(u); return `${x.origin}${x.pathname}`.toLowerCase(); }
      catch { return (u||'').split('?')[0].toLowerCase(); }
    };
    const uniq = [];
    for (const it of items) {
      const k = canon(it.link);
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(it);
    }

    // Score + sort (prefer local + trucking terms), newest first as tiebreak
    uniq.forEach(it => it._score = scoreItem(it.title, it.summary));
    uniq.sort((a,b) => {
      const da = Date.parse(a.date || 0), db = Date.parse(b.date || 0);
      if (b._score !== a._score) return b._score - a._score;
      return (db||0) - (da||0);
    });

    // Trim to limit
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ data: uniq.slice(0, limit) })
    };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e) }) };
  }
}
