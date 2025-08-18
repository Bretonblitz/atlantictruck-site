// netlify/functions/news.js
// Fast RSS merge: no per-article scraping. We hydrate images client-side.

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

  try {
    var limit = Number(process.env.NEWS_LIMIT || 30);
    var perFeed = Number(process.env.NEWS_PER_FEED || 10);
    var feedsCSV = process.env.FEED_URLS || (
      'https://www.trucknews.com/rss/,' +
      'https://www.ttnews.com/rss.xml,' +
      'https://atlantic.ctvnews.ca/rss/ctv-news-atlantic-public-rss-1.822315,' +
      'https://www.freightwaves.com/feed,' +
      'https://theloadstar.com/feed/,' +
      'https://www.cbc.ca/cmlink/rss-canada-ns'
    );

    var feeds = feedsCSV.split(',').map(function(s){ return s.trim(); }).filter(Boolean);

    var FEED_TIMEOUT_MS = Number(process.env.FEED_TIMEOUT_MS || 2500);

    var settled = await Promise.allSettled(
      feeds.map(function (u) { return fetchFeedFast(u, perFeed, FEED_TIMEOUT_MS); })
    );

    var items = [];
    for (var i = 0; i < settled.length; i++) {
      var r = settled[i];
      if (r.status === 'fulfilled' && Array.isArray(r.value)) items = items.concat(r.value);
    }

    // Filter out corporate HR fluff
    items = items.filter(function (it) { return !isCorporateHR(it.title); });

    if (!items.length) {
      return respond(headers, 502, { items: [], error: 'No items from feeds.' });
    }

    // sort newest first and trim
    items.sort(function(a,b){ return b.date - a.date; });
    items = items.slice(0, limit);

    return respond(headers, 200, {
      items: items.map(function(x){
        return {
          source: x.source,
          title: x.title,
          link: x.link,
          date: x.date.toISOString(),
          image: x.image || '',
          summary: x.summary
        };
      })
    });
  } catch (e) {
    return respond(headers, 500, { items: [], error: String(e) });
  }
};

function respond(headers, code, obj) {
  return { statusCode: code, headers: headers, body: JSON.stringify(obj) };
}

// ---- no-deps RSS fetch with timeout, no article scraping ----
async function fetchFeedFast(feedUrl, perFeed, timeoutMs) {
  var xml = await fetchTextWithTimeout(feedUrl, timeoutMs);
  var sourceTitle = getTagText(xml, 'title') || safeHost(feedUrl);
  var isRSS = /<rss\b|<channel\b/i.test(xml);
  var isAtom = /<feed\b/i.test(xml);
  var blocks = isRSS ? (xml.match(/<item[\s\S]*?<\/item>/gi) || [])
                     : (isAtom ? (xml.match(/<entry[\s\S]*?<\/entry>/gi) || []) : []);
  var items = [];
  for (var i = 0; i < blocks.length && items.length < perFeed; i++) {
    var block = blocks[i];
    var title = stripHTML(getTagText(block, 'title') || getAttr(block, 'title', 'type') || '');
    var link = getTagText(block, 'link') || getAttr(block, 'link', 'href') || '';
    var pub  = getTagText(block, 'pubDate') || getTagText(block, 'published') || getTagText(block, 'updated') || '';
    var rawHtml = getTagText(block, 'content:encoded') ||
                  getTagText(block, 'content') ||
                  getTagText(block, 'description') ||
                  getTagText(block, 'summary') || '';

    // quick image candidates: enclosure/media/html <img>
    var candidates = collectImageCandidates(block);
    var htmlImg = firstImgSrc(rawHtml);
    if (htmlImg) candidates.push({ url: htmlImg, w: 0, h: 0, score: scoreCandidate(htmlImg, '', 0, 0) });

    var best = selectBestImage(candidates);
    var image = absolutize(best && best.url ? best.url : '', link, feedUrl);
    image = preferLargeVariant(image);

    var date = pub ? new Date(pub) : new Date();
    var summary = stripHTML(rawHtml).slice(0, 300).trim();

    if (!title && !link) continue;

    items.push({
      source: stripHTML(sourceTitle),
      title: title || 'Untitled',
      link: link || '#',
      date: isValidDate(date) ? date : new Date(),
      image: image || '',
      summary: summary
    });
  }
  return items;
}

async function fetchTextWithTimeout(url, ms) {
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = null;
  if (controller) timer = setTimeout(function(){ controller.abort(); }, ms);
  try {
    var res = await fetch(url, {
      signal: controller ? controller.signal : undefined,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AtlanticTruckBot/1.0; +https://www.atlantictruck.ca/)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
      }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
