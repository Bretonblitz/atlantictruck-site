// netlify/functions/fb-img-proxy.js
// Proxies Facebook CDN image URLs to bypass signed-URL / CORS issues.
// Usage: /.netlify/functions/fb-img-proxy?u=<encoded-fb-image-url>
// Only allows fbcdn.net and cdninstagram.com domains for safety.

export default async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });

  const u = (new URL(req.url).searchParams.get('u') || '').trim();
  if (!u) return new Response('Missing u param', { status: 400 });

  let parsed;
  try { parsed = new URL(u); } catch { return new Response('Bad URL', { status: 400 }); }

  // Allowlist: only FB / Instagram CDN domains
  const allowed = /^(.*\.)?((fbcdn\.net|cdninstagram\.com|scontent\.xx\.fbcdn\.net))$/i;
  if (!allowed.test(parsed.hostname)) {
    return new Response('Forbidden domain', { status: 403 });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const upstream = await fetch(u, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AtlanticTruckBot/1.0)',
        'Referer': 'https://www.facebook.com/',
      },
    });
    clearTimeout(timer);

    if (!upstream.ok) return new Response('Upstream error', { status: upstream.status });

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const body = await upstream.arrayBuffer();

    return new Response(body, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      },
    });
  } catch (e) {
    return new Response('Proxy error: ' + String(e), { status: 502 });
  }
};
