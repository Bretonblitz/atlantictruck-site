// netlify/functions/get-truck-news.js
// Node 18+ (fetch built-in)

const FEEDS = [
  { name: 'TruckNews', url: 'https://www.trucknews.com/feed/' },
  { name: 'Global Halifax', url: 'https://globalnews.ca/halifax/feed/' },
  { name: 'CTV Atlantic', url: 'https://atlantic.ctvnews.ca/rss/ctv-news-atlantic-top-stories-1.1073369?ot=sdk.AjaxTarget&o=5' },
  { name: 'CBC Nova Scotia', url: 'https://www.cbc.ca/webfeed/rss/rss-ns' },
  { name: 'NS Gov – All News', url: 'https://news-feeds.novascotia.ca/en' },
  { name: 'NS Gov – Traffic Advisories', url: 'https://novascotia.ca/news/rss/' },
];

const UA = 'Mozilla/5.0 (compatible; AtlanticTruckNewsBot/1.0; +https://www.atlantictruck.ca/)';

function stripTags(html = '') { return html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim(); }
function getTag(xml, tag){ const m=xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`,'i')); return m?m[1].trim():''; }
function toAbs(href, base){ try{ return new URL(href, base).toString(); }catch{ return href||''; } }
function* eachItem(xml){
  const rssItems = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for(const raw of rssItems) yield { raw, type:'rss' };
  const atomItems = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for(const raw of atomItems) yield { raw, type:'atom' };
  if(/^\s*\{/.test(xml)) { try{ const j=JSON.parse(xml); if(Array.isArray(j.items)){ for(const it of j.items) yield { json:it, type:'json' }; } }catch{} }
}
function pickImageFrom(raw, base){
  const media = raw.match(/<media:content[^>]+url="([^"]+)"/i);
  if(media) return toAbs(media[1], base);
  const thumb = raw.match(/<media:thumbnail[^>]+url="([^"]+)"/i);
  if(thumb) return toAbs(thumb[1], base);
  const encl = raw.match(/<enclosure[^>]+url="([^"]+)"/i);
  if(encl) return toAbs(encl[1], base);
  const desc = getTag(raw,'description');
  const img = (desc.match(/<img[^>]+src="([^"]+)"/i)||[])[1];
  return img ? toAbs(img, base) : '';
}
async function fetchText(u, timeoutMs=9000){
  const ctrl = new AbortController(); const id = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(u, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept': '*/*' }});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(id); }
}
function findMetaImage(html, base){
  const pick = (re)=>{ const m = html.match(re); return m ? m[1] : ''; };
  let u = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
       || pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
       || pick(/<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i);
  if(!u){
    // last-resort: first <img> with reasonable size-ish attributes
    const m = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
    if(m) u = m[1];
  }
  return u ? toAbs(u, base) : '';
}

function scoreItem(t, sum){
  const hay = `${t} ${sum}`.toLowerCase();
  let s = 0;
  const REGION = [/cape\s*breton/i,/sydney\b/i,/\bnova scotia\b|\bns\b/i,/halifax/i,/antigonish/i,/port hawkesbury/i,/atlantic canada|new brunswick|pei|newfoundland/i];
  REGION.forEach(rx => { if(rx.test(hay)) s += 5; });
  if(/truck|trucking|transport|tow|highway|semi|18[- ]?wheeler|fleet/i.test(hay)) s += 3;
  return s;
}

export async function handler(event){
  try{
    const qs = event.queryStringParameters || {};
    const limit = Math.min(10, Math.max(1, parseInt(qs.limit || '10', 10)));

    // 1) Fetch feeds
    const results = await Promise.allSettled(FEEDS.map(f => fetchText(f.url).then(t => ({ f, t }))));

    // 2) Collect items
    const items = [];
    for(const r of results){
      if(r.status !== 'fulfilled') continue;
      const { f, t } = r.value;

      for(const blk of eachItem(t)){
        if(blk.type === 'json'){
          const it = blk.json;
          const title = it.title || '';
          const link  = toAbs(it.url || it.external_url || '', f.url);
          const date  = it.date_published || it.published || it.date_modified || it.updated || '';
          const desc  = stripTags(it.content_html || it.summary || '');
          const image = it.image || '';
          if(title && link) items.push({ source:f.name, title, link, date, image, summary:desc });
        } else {
          const raw = blk.raw;
          const title = stripTags(getTag(raw,'title'));
          const link  = toAbs(getTag(raw,'link') || (raw.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)||[])[1] || '', f.url);
          const date  = getTag(raw,'pubDate') || getTag(raw,'updated') || getTag(raw,'published') || '';
          const desc  = stripTags(getTag(raw,'description') || getTag(raw,'summary'));
          const image = pickImageFrom(raw, f.url);
          if(title && link) items.push({ source:f.name, title, link, date, image, summary:desc });
        }
      }
    }

    // 3) De-dup by link
    const seen = new Set();
    const canon = (u)=>{ try{ const x=new URL(u); return `${x.origin}${x.pathname}`.toLowerCase(); }catch{ return (u||'').split('?')[0].toLowerCase(); } };
    const uniq = [];
    for(const it of items){
      const k = canon(it.link);
      if(seen.has(k)) continue;
      seen.add(k);
      uniq.push(it);
    }

    // 4) For items missing image, fetch their page & grab og:image (cap to protect latency)
    const NEED = uniq.filter(it => !it.image).slice(0, 12); // at most 12 page fetches
    await Promise.allSettled(NEED.map(async it => {
      try{
        const html = await fetchText(it.link, 7000);
        const og = findMetaImage(html, it.link);
        if(og) it.image = og;
      }catch{}
    }));

    // 5) Score + sort (local + trucking first; then newest)
    uniq.forEach(it => it._score = scoreItem(it.title, it.summary));
    uniq.sort((a,b)=>{
      if(b._score !== a._score) return b._score - a._score;
      const da = Date.parse(a.date||0), db=Date.parse(b.date||0);
      return (db||0)-(da||0);
    });

    // 6) Return
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ data: uniq.slice(0, limit) })
    };
  }catch(e){
    return { statusCode: 500, headers:{'Content-Type':'application/json'}, body: JSON.stringify({ error:String(e) }) };
  }
}
