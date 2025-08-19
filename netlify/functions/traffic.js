// netlify/functions/traffic.js
// Traffic advisories only (Nova Scotia Government).

exports.handler = async function (event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=180, s-maxage=900',
    'Content-Type': 'application/json'
  };
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers, body: '' };
  }

  var qs = (event && event.queryStringParameters) || {};
  var DEBUG = String(qs.debug || '').toLowerCase() === '1';

  try {
    var perFeed = Number(process.env.TRAFFIC_PER_FEED || 20);
    var timeout = Number(process.env.FEED_TIMEOUT_MS || 3000);

// netlify/functions/traffic.js — replace the feeds array with this
var feeds = [
  // Nova Scotia traffic advisories
  'https://novascotia.ca/news/rss/traffic.asp',

  // Environment Canada CAP/RSS alerts (weather) for Atlantic provinces
  'https://alerts.weather.gc.ca/rss/cap/ns.xml',
  'https://alerts.weather.gc.ca/rss/cap/nb.xml',
  'https://alerts.weather.gc.ca/rss/cap/pe.xml',
  'https://alerts.weather.gc.ca/rss/cap/nl.xml'
];


    var debugFeeds = [];
    var settled = await Promise.allSettled(
      feeds.map(function (u) { return fetchFeedFast(u, perFeed, timeout, DEBUG, debugFeeds); })
    );

    var items = [];
    for (var i = 0; i < settled.length; i++) {
      if (settled[i].status === 'fulfilled' && Array.isArray(settled[i].value)) {
        items = items.concat(settled[i].value);
      }
    }

    if (!items.length) {
      var bodyNoItems = DEBUG
        ? { items: [], error: 'No items from traffic feeds.', debug: { feeds: debugFeeds } }
        : { items: [], error: 'No items from traffic feeds.' };
      return respond(headers, 502, bodyNoItems);
    }

    items.sort(function(a,b){ return b.date - a.date; });

    var bodyOK = {
      items: items.map(function(x){
        return {
          source: x.source,
          title:  x.title,
          link:   x.link,
          date:   x.date.toISOString(),
          image:  x.image || '',
          summary:x.summary
        };
      })
    };
    if (DEBUG) bodyOK.debug = { feeds: debugFeeds };

    return respond(headers, 200, bodyOK);
  } catch (e) {
    var bodyErr = DEBUG
      ? { items: [], error: String(e), debug: { message: 'Unhandled error in traffic.js' } }
      : { items: [], error: String(e) };
    return respond(headers, 500, bodyErr);
  }
};

function respond(headers, code, obj) {
  return { statusCode: code, headers: headers, body: JSON.stringify(obj) };
}

// --- Shared helpers (same as news.js but minimal) ---
async function fetchFeedFast(feedUrl, perFeed, timeoutMs, DEBUG, debugFeeds) {
  var started = Date.now();
  var debug = { url: feedUrl, ok: false, status: 0, durationMs: 0, itemCount: 0, error: '' };

  try {
    var fx = await fetchTextWithTimeout(feedUrl, timeoutMs);
    debug.status = fx.status;
    debug.durationMs = fx.durationMs;

    if (!fx.ok) {
      debug.error = fx.error || ('HTTP ' + fx.status);
      if (DEBUG) debugFeeds.push(debug);
      return [];
    }

    var xml = fx.text;
    var sourceTitle = getTagText(xml, 'title') || safeHost(feedUrl);
    var isRSS = /<rss\b|<channel\b/i.test(xml);
    var isAtom = /<feed\b/i.test(xml);
    var blocks = isRSS ? (xml.match(/<item[\s\S]*?<\/item>/gi) || [])
                       : (isAtom ? (xml.match(/<entry[\s\S]*?<\/entry>/gi) || []) : []);

    var items = [];
    for (var i = 0; i < blocks.length && items.length < perFeed; i++) {
      var block = blocks[i];
      var title = stripHTML(getTagText(block, 'title') || getAttr(block, 'title', 'type') || '');
      var link  = getTagText(block, 'link') || getAttr(block, 'link', 'href') || '';
      var pub   = getTagText(block, 'pubDate') || getTagText(block, 'published') || getTagText(block, 'updated') || '';
      var raw   = getTagText(block, 'content:encoded') || getTagText(block, 'content') ||
                  getTagText(block, 'description') || getTagText(block, 'summary') || '';

      var htmlImg = firstImgSrc(raw);
      var image = htmlImg ? absolutize(htmlImg, link, feedUrl) : '';

      var date = pub ? new Date(pub) : new Date();
      var summary = stripHTML(raw).slice(0, 300).trim();

      if (!title && !link) continue;

      items.push({
        source: stripHTML(sourceTitle),
        title:  title || 'Traffic advisory',
        link:   link || '#',
        date:   isValidDate(date) ? date : new Date(),
        image:  image || '',
        summary: summary
      });
    }

    debug.ok = true;
    debug.itemCount = items.length;
    if (DEBUG) debugFeeds.push(debug);
    return items;
  } catch (e) {
    debug.durationMs = Date.now() - started;
    debug.error = String(e);
    if (DEBUG) debugFeeds.push(debug);
    return [];
  }
}

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
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
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

function getTagText(xml, tag) {
  var re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  var m = xml.match(re);
  return m ? decodeHTML(cdata(m[1]).trim()) : '';
}
function getAttr(xml, tag, attr) {
  var re = new RegExp('<' + tag + '\\b[^>]*\\b' + attr + '=["\']([^"\']+)["\'][^>]*\\/?>', 'i');
  var m = xml.match(re);
  return m ? decodeHTML(m[1]) : '';
}
function cdata(s) { var m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i); return m ? m[1] : s; }
function stripHTML(html) { return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '); }
function decodeHTML(s) {
  s = String(s || '');
  s = s.replace(/&amp;/g, '&'); s = s.replace(/&lt;/g, '<'); s = s.replace(/&gt;/g, '>');
  s = s.replace(/&quot;/g, '"'); s = s.replace(/&#39;/g, '\''); return s;
}
function firstImgSrc(html) { var m = (html || '').match(/<img[^>]+src=["']([^"']+)["']/i); return m ? decodeHTML(m[1]) : ''; }
function absolutize(u, baseLink, feedUrl) {
  if (!u) return '';
  if (u.indexOf('data:') === 0) return '';
  try { if (u.indexOf('//') === 0) return 'https:' + u; return new URL(u, baseLink || feedUrl).href; }
  catch (e) { return u; }
}
function isValidDate(d) { return d instanceof Date && !isNaN(d.valueOf()); }
function safeHost(u) { try { return new URL(u).hostname; } catch (e) { return 'Traffic'; } }
