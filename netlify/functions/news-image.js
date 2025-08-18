// netlify/functions/news-image.js
// Scrapes an article's og:image/twitter:image/etc. Supports ?debug=1.

exports.handler = async function (event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=86400, s-maxage=86400',
    'Content-Type': 'application/json'
  };
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers, body: '' };
  }

  var qs = (event && event.queryStringParameters) || {};
  var DEBUG = String(qs.debug || '').toLowerCase() === '1';
  var u = qs.u;

  if (!u) return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Missing u' }) };

  try {
    var timeout = Number(process.env.IMAGE_FETCH_TIMEOUT_MS || 2500);
    var fx = await fetchTextWithTimeout(u, timeout);

    var dbg = { url: u, ok: fx.ok, status: fx.status, durationMs: fx.durationMs, error: fx.error || '' };
    if (!fx.ok) {
      var bodyBad = DEBUG ? { image: '', debug: dbg } : { image: '' };
      return { statusCode: 200, headers: headers, body: JSON.stringify(bodyBad) };
    }

    var html = fx.text;
    var img =
      metaContent(html, 'property', 'og:image') ||
      metaContent(html, 'property', 'og:image:secure_url') ||
      metaContent(html, 'name', 'twitter:image') ||
      metaContent(html, 'name', 'parsely-image') ||
      linkHref(html, 'link', 'image_src') ||
      jsonLdImage(html) ||
      firstSrcsetBest(html) ||
      firstImgSrc(html) ||
      '';
    img = absolutize(img, u, u);

    var bodyOK = DEBUG ? { image: img || '', debug: dbg } : { image: img || '' };
    return { statusCode: 200, headers: headers, body: JSON.stringify(bodyOK) };
  } catch (e) {
    var bodyErr = DEBUG ? { image: '', debug: { url: u, error: String(e) } } : { image: '' };
    return { statusCode: 200, headers: headers, body: JSON.stringify(bodyErr) };
  }
};

async function fetchTextWithTimeout(url, ms) {
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = null;
  if (controller) timer = setTimeout(function(){ controller.abort(); }, ms);
  var out = { ok: false, text: '', status: 0, durationMs: 0, error: '' };
  var t0 = Date.now();
  try {
    var res = await fetch(url, {
      signal: controller ? controller.signal : undefined,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AtlanticTruckBot/1.0; +https://www.atlantictruck.ca/)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    out.status = res.status;
    if (!res.ok) { out.error = 'HTTP ' + res.status; return out; }
    out.text = await res.text();
    out.ok = true;
    return out;
  } catch (e) {
    out.error = String(e && e.name === 'AbortError' ? 'Timeout' : e);
    return out;
  } finally {
    out.durationMs = Date.now() - t0;
    if (timer) clearTimeout(timer);
  }
}

function metaContent(html, attr, val) {
  var re = new RegExp('<meta[^>]+' + attr + '=["\']' + val + '["\'][^>]*content=["\']([^"\']+)["\'][^>]*>', 'i');
  var m = html.match(re);
  return m ? m[1] : '';
}
function linkHref(html, tag, relVal) {
  var re = new RegExp('<' + tag + '[^>]+rel=["\']' + relVal + '["\'][^>]*href=["\']([^"\']+)["\']', 'i');
  var m = html.match(re);
  return m ? m[1] : '';
}
function jsonLdImage(html) {
  var scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/ig) || [];
  for (var i = 0; i < scripts.length; i++) {
    var raw = scripts[i].replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    try {
      var obj = JSON.parse(raw);
      var url = extractJsonLdImage(obj);
      if (url) return url;
    } catch (e) {}
  }
  return '';
}
function extractJsonLdImage(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) {
    for (var i = 0; i < obj.length; i++) {
      var v = extractJsonLdImage(obj[i]); if (v) return v;
    }
    return '';
  }
  if (typeof obj === 'object') {
    if (obj.image) {
      if (typeof obj.image === 'string') return obj.image;
      if (Array.isArray(obj.image) && obj.image.length) {
        var first = obj.image[0];
        if (typeof first === 'string') return first;
        if (first && typeof first === 'object' && first.url) return first.url;
      }
      if (obj.image.url) return obj.image.url;
    }
    if (obj.thumbnailUrl) return obj.thumbnailUrl;
    var keys = Object.keys(obj);
    for (var k = 0; k < keys.length; k++) {
      var v2 = extractJsonLdImage(obj[keys[k]]); if (v2) return v2;
    }
  }
  return '';
}
function firstImgSrc(html) {
  var m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : '';
}
function firstSrcsetBest(html) {
  var mm = html && html.match(/<img[^>]+srcset=["']([^"']+)["']/i);
  if (!mm || !mm[1]) return '';
  var srcset = mm[1].split(',').map(function(s){ return s.trim(); });
  var bestUrl = ''; var bestWidth = 0;
  for (var i = 0; i < srcset.length; i++) {
    var part = srcset[i];
    var m = part.match(/(\S+)\s+(\d+)w/);
    var url = ''; var w = 0;
    if (m) { url = m[1]; w = parseInt(m[2], 10) || 0; }
    else { url = part.split(' ')[0]; w = 0; }
    if (w >= bestWidth) { bestWidth = w; bestUrl = url; }
  }
  return bestUrl;
}
function absolutize(u, baseLink, feedUrl) {
  if (!u) return '';
  if (u.indexOf('data:') === 0) return '';
  try { if (u.indexOf('//') === 0) return 'https:' + u; return new URL(u, baseLink || feedUrl).href; }
  catch (e) { return u; }
}
