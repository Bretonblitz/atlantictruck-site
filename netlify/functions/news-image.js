// netlify/functions/news-image.js
export default async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=86400'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const u = ((event.queryStringParameters || {}).u || '').trim();
  if (!u) return { statusCode: 400, headers, body: JSON.stringify({ image: '', logo: '' }) };

  let hostname = '';
  try { hostname = new URL(u).hostname.replace(/^www\./, ''); } catch {}

  const LOGOS = {
    'trucknews.com':        'https://www.trucknews.com/wp-content/uploads/2020/01/trucknews-logo.png',
    'theloadstar.com':      'https://theloadstar.com/wp-content/themes/loadstar/img/loadstar-logo.svg',
    'freightwaves.com':     'https://www.freightwaves.com/wp-content/uploads/2019/09/FreightWaves-Logo-e1569001898901.png',
    'globalnews.ca':        'https://globalnews.ca/wp-content/themes/globalnews-2018/assets/images/global-news-logo.svg',
    'cbc.ca':               'https://www.cbc.ca/a/images/cbc-news-logo-en.svg',
    'vocm.com':             'https://vocm.com/wp-content/uploads/2016/09/vocm-logo.png',
    'insidelogistics.ca':   'https://www.insidelogistics.ca/wp-content/uploads/2023/03/inside-logistics-logo.png',
    'todaystrucking.com':   'https://www.todaystrucking.com/wp-content/themes/todaystrucking/images/todays-trucking-logo.png',
  };
  const logo = LOGOS[hostname] || '';

  const ms = Math.min(Number(process.env.IMAGE_FETCH_TIMEOUT_MS || 5000), 7000);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    let html = '';
    try {
      const res = await fetch(u, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,*/*;q=0.8'
        }
      });
      if (res.ok) {
        const reader = res.body.getReader();
        const chunks = []; let total = 0;
        while (total < 102400) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); total += value.length;
        }
        reader.cancel();
        const all = chunks.reduce((a, b) => { const c = new Uint8Array(a.length+b.length); c.set(a); c.set(b,a.length); return c; }, new Uint8Array(0));
        html = new TextDecoder().decode(all);
      }
    } finally { clearTimeout(timer); }

    if (!html) return { statusCode: 200, headers, body: JSON.stringify({ image: logo, logo }) };

    // Waterfall: og:image → twitter:image → json-ld → article img
    const meta = (attr, val) => {
      const re = new RegExp('<meta[^>]+(?:' + attr + '=["\'\']' + val.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '["\'\'][^>]+content=["\'\']([^\"\'\']+)["\'\']|content=["\'\']([^\"\'\']+)["\'\'][^>]+' + attr + '=["\'\']' + val.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '["\'\'])','i');
      const m = html.match(re); return m ? (m[1]||m[2]||'') : '';
    };

    let img =
      meta('property','og:image:secure_url') ||
      meta('property','og:image') ||
      meta('name','twitter:image:src') ||
      meta('name','twitter:image') ||
      meta('name','parsely-image') ||
      (() => {
        const blocks = html.match(/<script[^>]+type=["\']application\/ld\+json["\'][^>]*>([\s\S]*?)<\/script>/gi) || [];
        for (const b of blocks) {
          try {
            const j = JSON.parse(b.replace(/<script[^>]*>|<\/script>/gi,''));
            const pick = o => !o ? '' : typeof o.image==='string' ? o.image : o.image?.url || (Array.isArray(o.image) ? o.image[0]?.url||o.image[0]||'' : '') || (Array.isArray(o['@graph']) ? o['@graph'].reduce((a,n)=>a||pick(n),'') : '');
            const r = pick(j); if (r) return r;
          } catch {}
        }
        return '';
      })() ||
      (() => {
        const imgs = html.match(/<img[^>]+src=["\']([^\"\'\']+)["\'][^>]*>/gi) || [];
        for (const tag of imgs) {
          const s = (tag.match(/src=["\']([^\"\'\']+)["\']/) || [])[1] || '';
          if (!s || s.startsWith('data:') || /favicon|icon|logo|pixel|spacer|avatar/i.test(s)) continue;
          const w = parseInt((tag.match(/width=["\']?(\d+)/) || [])[1] || '0');
          if (w > 0 && w < 150) continue;
          return s;
        }
        return '';
      })();

    if (img && img.startsWith('//')) img = 'https:' + img;
    try { if (img) img = new URL(img, u).href; } catch {}
    if (!img || img.startsWith('data:') || /1x1|pixel|spacer/i.test(img)) img = '';

    return { statusCode: 200, headers, body: JSON.stringify({ image: img || logo, logo }) };
  } catch {
    return { statusCode: 200, headers, body: JSON.stringify({ image: logo, logo }) };
  }
}
