// netlify/functions/news-image.js  —  Netlify v2 format
// Scrapes og:image / twitter:image / JSON-LD / article body from a news URL.
// Falls back to a source logo when no article image is found.

export default async (req, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=86400, s-maxage=86400',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers });
  }

  const qs     = new URL(req.url).searchParams;
  const u      = (qs.get('u') || '').trim();
  const DEBUG  = qs.get('debug') === '1';

  if (!u) {
    return new Response(JSON.stringify({ image: '', logo: '' }), { status: 400, headers });
  }

  // Source logo fallbacks — never expire, no hotlink issues
  const LOGOS = {
    'trucknews.com':       'https://www.trucknews.com/wp-content/uploads/2020/01/trucknews-logo.png',
    'theloadstar.com':     'https://theloadstar.com/wp-content/themes/loadstar/img/loadstar-logo.svg',
    'freightwaves.com':    'https://www.freightwaves.com/wp-content/uploads/2019/09/FreightWaves-Logo-e1569001898901.png',
    'globalnews.ca':       'https://globalnews.ca/wp-content/themes/globalnews-2018/assets/images/global-news-logo.svg',
    'cbc.ca':              'https://www.cbc.ca/a/images/cbc-news-logo-en.svg',
    'vocm.com':            'https://vocm.com/wp-content/uploads/2016/09/vocm-logo.png',
    'insidelogistics.ca':  'https://www.insidelogistics.ca/wp-content/uploads/2023/03/inside-logistics-logo.png',
    'todaystrucking.com':  'https://www.todaystrucking.com/wp-content/themes/todaystrucking/images/todays-trucking-logo.png',
  };

  let logo = '';
  try {
    const host = new URL(u).hostname.replace(/^www\./, '');
    logo = LOGOS[host] || '';
  } catch (_) {}

  const timeout = Math.min(Number(process.env.IMAGE_FETCH_TIMEOUT_MS || 4500), 7000);

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let html = '';

    try {
      const res = await fetch(u, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
        }
      });
      if (res.ok) {
        // Read only first 100 KB — enough for <head> meta tags
        const reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        while (total < 102400) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
        }
        reader.cancel();
        const all = chunks.reduce((a, b) => {
          const c = new Uint8Array(a.length + b.length);
          c.set(a); c.set(b, a.length);
          return c;
        }, new Uint8Array(0));
        html = new TextDecoder().decode(all);
      }
    } finally {
      clearTimeout(timer);
    }

    if (!html) {
      return new Response(JSON.stringify({ image: logo, logo }), { status: 200, headers });
    }

    // ── Image extraction waterfall ──────────────────────────────
    let img =
      metaContent(html, 'property', 'og:image:secure_url') ||
      metaContent(html, 'property', 'og:image')            ||
      metaContent(html, 'name', 'twitter:image:src')        ||
      metaContent(html, 'name', 'twitter:image')            ||
      metaContent(html, 'name', 'parsely-image')            ||
      linkHref(html, 'image_src')                           ||
      jsonLdImage(html)                                     ||
      articleBodyImage(html)                                ||
      '';

    // Make absolute
    if (img && img.startsWith('//')) img = 'https:' + img;
    if (img) {
      try { img = new URL(img, u).href; } catch (_) {}
    }

    // Reject obvious junk
    if (img && /1x1|pixel|spacer|blank|favicon|icon-\d|tracking|beacon/i.test(img)) img = '';

    const body = DEBUG
      ? { image: img || logo, logo, debug: { url: u, found: !!img } }
      : { image: img || logo, logo };

    return new Response(JSON.stringify(body), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({ image: logo, logo }), { status: 200, headers });
  }
};

// ── Helpers ───────────────────────────────────────────────────────

function metaContent(html, attr, val) {
  const esc = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re  = new RegExp(
    '<meta[^>]+(?:' + attr + '=["\']' + esc + '["\'][^>]+content=["\']([^"\']+)["\']' +
    '|content=["\']([^"\']+)["\'][^>]+' + attr + '=["\']' + esc + '["\'])', 'i'
  );
  const m = html.match(re);
  return m ? (m[1] || m[2] || '') : '';
}

function linkHref(html, rel) {
  const re = new RegExp('<link[^>]+rel=["\']' + rel + '["\'][^>]+href=["\']([^"\']+)["\']', 'i');
  const m  = html.match(re);
  return m ? m[1] : '';
}

function jsonLdImage(html) {
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const raw = b.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
    try {
      const obj = JSON.parse(raw);
      const img = pickJsonLdImg(obj);
      if (img) return img;
    } catch (_) {}
  }
  return '';
}
function pickJsonLdImg(o) {
  if (!o || typeof o !== 'object') return '';
  if (typeof o.image === 'string')  return o.image;
  if (o.image?.url)                 return o.image.url;
  if (Array.isArray(o.image) && o.image.length) {
    const f = o.image[0];
    return (typeof f === 'string') ? f : (f?.url || '');
  }
  if (Array.isArray(o['@graph'])) {
    for (const n of o['@graph']) { const i = pickJsonLdImg(n); if (i) return i; }
  }
  return '';
}

function articleBodyImage(html) {
  const imgs = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi) || [];
  for (const tag of imgs) {
    const src = (tag.match(/src=["']([^"']+)["']/i) || [])[1] || '';
    if (!src || src.startsWith('data:')) continue;
    if (/favicon|icon|logo|pixel|spacer|avatar|gravatar/i.test(src)) continue;
    const w = parseInt((tag.match(/width=["']?(\d+)/i) || [])[1] || '0');
    if (w > 0 && w < 150) continue;
    return src;
  }
  return '';
}
