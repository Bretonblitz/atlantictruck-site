// netlify/functions/news.js
// Atlantic/Nova Scotia news (NO traffic unless Cape Breton), no sexual content,
// max 4 items per site, fast RSS parse + debug.

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
    var limit        = Number(process.env.NEWS_LIMIT || 30);
    var perFeed      = Number(process.env.NEWS_PER_FEED || 10);
    var timeout      = Number(process.env.FEED_TIMEOUT_MS || 3000);
    var MAX_PER_HOST = 4;

    // netlify/functions/news.js  — replace the feeds array with this
var feeds = [
  // Canada trucking / logistics
  'https://www.trucknews.com/rss/',
  'https://theloadstar.com/feed/',
  'https://www.freightwaves.com/feed',

  // Regional broadcasters – Atlantic
  'https://globalnews.ca/halifax/feed/',
  'https://globalnews.ca/new-brunswick/feed/',

  // CBC provincial “lineup” feeds
  'https://rss.cbc.ca/lineup/canada-novascotia.xml',
  'https://rss.cbc.ca/lineup/canada-newbrunswick.xml',
  'https://rss.cbc.ca/lineup/canada-pei.xml',
  'https://rss.cbc.ca/lineup/canada-newfoundland.xml',

  // NL local + Canadian logistics
  'https://vocm.com/feed/',
  'https://www.insidelogistics.ca/feed/'
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

    // --- Content filtering ---
    // 1) Remove HR/corporate fluff (CEO appointments, etc.)
    items = items.filter(function (it) { return !isCorporateHR(it.title); });

    // 2) Remove sexual content
    items = items.filter(function (it) { return !isSexualContent(it.title, it.summary); });

    // 3) Remove traffic-related items UNLESS mention Cape Breton/CBRM explicitly
    items = items.filter(function (it) {
      var isTraffic = isTrafficRelated(it.title, it.summary);
      if (!isTraffic) return true;
      return mentionsCapeBreton(it.title, it.summary, it.link);
    });

    if (!items.length) {
      var bodyNoItems = DEBUG
        ? { items: [], error: 'No items from feeds.', debug: { feeds: debugFeeds } }
        : { items: [], error: 'No items from feeds.' };
      return respond(headers, 502, bodyNoItems);
    }

    // newest first
    items.sort(function(a,b){ return b.date - a.date; });

    // cap per website (host) to 4
    var perHostCount = Object.create(null);
    var capped = [];
    for (var j = 0; j < items.length; j++) {
      var h = hostFromLink(items[j].link);
      perHostCount[h] = (perHostCount[h] || 0);
      if (perHostCount[h] < MAX_PER_HOST) {
        capped.push(items[j]);
        perHostCount[h]++;
      }
    }
    items = capped.slice(0, limit);

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
      ? { items: [], error: String(e), debug: { message: 'Unhandled error in news.js' } }
      : { items: [], error: String(e) };
    return respond(headers, 500, bodyErr);
  }
};

function respond(headers, code, obj) {
  return { statusCode: code, headers: headers, body: JSON.stringify(obj) };
}

// ---- fetch a single RSS feed quickly, record debug info ----
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

      var cands = collectImageCandidates(block);
      var htmlImg = firstImgSrc(raw);
      if (htmlImg) cands.push({ url: htmlImg, w: 0, h: 0, score: scoreCandidate(htmlImg, '', 0, 0) });

      var best  = selectBestImage(cands);
      var image = absolutize(best && best.url ? best.url : '', link, feedUrl);
      image = preferLargeVariant(image);

      var date = pub ? new Date(pub) : new Date();
      var summary = stripHTML(raw).slice(0, 300).trim();

      if (!title && !link) continue;

      items.push({
        source: stripHTML(sourceTitle),
        title:  title || 'Untitled',
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

// ---- tiny fetch with timeout ----
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

// ---------- filters ----------
function isCorporateHR(title) {
  if (!title) return false;
  var t = title.toLowerCase();
  var patterns = [
    'appoint', 'appointment', 'appointed', 'joins as', 'join as', 'chief executive',
    'chief financial', 'chief operating', 'ceo', 'cfo', 'coo', 'president',
    'vice president', 'vp ', 'board of directors', 'director of', 'promoted',
    'promotion', 'hires', 'hired', 'obituary', 'sponsored', 'q&a:', 'q & a',
    'anniversary', 'milestone', 'in memoriam'
  ];
  for (var i = 0; i < patterns.length; i++) {
    if (t.indexOf(patterns[i]) !== -1) return true;
  }
  return false;
}

function isSexualContent(title, summary) {
  var txt = (String(title || '') + ' ' + String(summary || '')).toLowerCase();
  var patterns = [
    'sexual', 'voyeur', 'voyeurism', 'sex offender', 'sex-related', 'sex related',
    'porn', 'pornography', 'explicit', 'luring', 'child exploit', 'child pornography',
    'rape', 'indecent', 'inappropriate touching', 'grooming', 'in camera in washroom'
  ];
  for (var i = 0; i < patterns.length; i++) {
    if (txt.indexOf(patterns[i]) !== -1) return true;
  }
  return false;
}

function isTrafficRelated(title, summary) {
  var txt = (String(title || '') + ' ' + String(summary || '')).toLowerCase();
  var phrases = [
    'traffic advisory', 'traffic alert', 'traffic delays', 'traffic update',
    'road closure', 'lane closure', 'lane reduction', 'detour', 'bridge closure',
    'bridge repairs', 'roadwork', 'road work', 'paving', 'maintenance work',
    'closed to traffic', 'reduced to one lane'
  ];
  for (var i = 0; i < phrases.length; i++) {
    if (txt.indexOf(phrases[i]) !== -1) return true;
  }
  // heuristics: "closure on Hwy/Highway/Route + number"
  if (/\b(closure|closed|detour)\b.*\b(hwy|highway|route|trunk|ns-\d+)\b/i.test(txt)) return true;
  return false;
}

function mentionsCapeBreton(title, summary, link) {
  var txt = (String(title || '') + ' ' + String(summary || '') + ' ' + String(link || '')).toLowerCase();
  var places = [
    'cape breton', 'cbrm', 'sydney', 'glace bay', 'north sydney', 'sydney mines',
    'new waterford', 'louisbourg', 'baddeck', 'eskasoni', 'membertou',
    'ingonish', 'whycocomagh', 'port hawkesbury', 'inverness', 'mabou',
    "st. peter", 'arichat', 'isle madame'
  ];
  for (var i = 0; i < places.length; i++) {
    if (txt.indexOf(places[i]) !== -1) return true;
  }
  return false;
}

// ---------- image helpers (no scraping) ----------
function collectImageCandidates(blockXml) {
  var out = [];
  var encl = blockXml.match(/<enclosure\b[^>]*>/gi) || [];
  for (var i = 0; i < encl.length; i++) {
    var tag = encl[i];
    var url = getAttrRaw(tag, 'url');
    var type = (getAttrRaw(tag, 'type') || '').toLowerCase();
    var w = parseInt(getAttrRaw(tag, 'width') || '0', 10) || 0;
    var h = parseInt(getAttrRaw(tag, 'height') || '0', 10) || 0;
    if (url) out.push({ url: url, w: w, h: h, score: scoreCandidate(url, type, w, h) });
  }
  var mediaTags = blockXml.match(/<(media:content|media:thumbnail)\b[^>]*>/gi) || [];
  for (var j = 0; j < mediaTags.length; j++) {
    var tag2 = mediaTags[j];
    var url2 = getAttrRaw(tag2, 'url');
    var type2 = (getAttrRaw(tag2, 'type') || '').toLowerCase();
    var w2 = parseInt(getAttrRaw(tag2, 'width') || '0', 10) || 0;
    var h2 = parseInt(getAttrRaw(tag2, 'height') || '0', 10) || 0;
    if (url2) out.push({ url: url2, w: w2, h: h2, score: scoreCandidate(url2, type2, w2, h2) });
  }
  var moreImgs = blockXml.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
  for (var k = 0; k < moreImgs.length; k++) {
    var t = moreImgs[k];
    var m = t.match(/src=["']([^"']+)["']/i);
    if (m && m[1]) out.push({ url: m[1], w: 0, h: 0, score: scoreCandidate(m[1], '', 0, 0) });
  }
  return out;
}
function selectBestImage(cands) {
  if (!cands.length) return null;
  cands.sort(function(a, b) {
    var areaA = (a.w || 0) * (a.h || 0);
    var areaB = (b.w || 0) * (b.h || 0);
    if (b.score !== a.score) return b.score - a.score;
    return areaB - areaA;
  });
  return cands[0];
}
function scoreCandidate(url, type, w, h) {
  var score = 0;
  var u = String(url || '');
  var t = String(type || '');
  if (t.indexOf('image/') === 0) score += 50;
  if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(u)) score += 40;
  if (/wp-content|uploads|cdn|images|image|media/i.test(u)) score += 15;
  var area = (w || 0) * (h || 0);
  if (area >= 800 * 450) score += 15;
  else if (area >= 400 * 225) score += 8;
  return score;
}

// ---------- tiny XML/HTML utils ----------
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
function getAttrRaw(tagXml, attr) {
  var re = new RegExp('\\b' + attr + '=["\']([^"\']+)["\']', 'i');
  var m = tagXml.match(re);
  return m ? decodeHTML(m[1]) : '';
}
function cdata(s) { var m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i); return m ? m[1] : s; }
function stripHTML(html) { return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '); }
function decodeHTML(s) {
  s = String(s || '');
  s = s.replace(/&amp;/g, '&'); s = s.replace(/&lt;/g, '<'); s = s.replace(/&gt;/g, '>');
  s = s.replace(/&quot;/g, '"'); s = s.replace(/&#39;/g, '\''); return s;
}
function preferLargeVariant(u) {
  if (!u) return u;
  var m = u.match(/(.*)-\d+x\d+(\.[a-zA-Z0-9]+)(\?.*)?$/);
  if (m) return m[1] + m[2] + (m[3] || '');
  return u;
}
function absolutize(u, baseLink, feedUrl) {
  if (!u) return '';
  if (u.indexOf('data:') === 0) return '';
  try { if (u.indexOf('//') === 0) return 'https:' + u; return new URL(u, baseLink || feedUrl).href; }
  catch (e) { return u; }
}
function isValidDate(d) { return d instanceof Date && !isNaN(d.valueOf()); }
function safeHost(u) { try { return new URL(u).hostname; } catch (e) { return 'News'; } }
function hostFromLink(u){ try { return new URL(u).hostname.toLowerCase(); } catch(e){ return 'unknown'; } }
function firstImgSrc(html) { var m = (html || '').match(/<img[^>]+src=["']([^"']+)["']/i); return m ? decodeHTML(m[1]) : ''; }
