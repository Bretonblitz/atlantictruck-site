// netlify/functions/news.js
// Direct RSS fetch + robust image extraction (ASCII-only, CommonJS)

exports.handler = async function (event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=300, s-maxage=600',
    'Content-Type': 'application/json'
  };

  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers, body: '' };
  }

  try {
    var limit = Number(process.env.NEWS_LIMIT || 36);
    var feedsCSV = process.env.FEED_URLS || (
      'https://www.trucknews.com/rss/,' +
      'https://www.ttnews.com/rss.xml,' +
      'https://atlantic.ctvnews.ca/rss/ctv-news-atlantic-public-rss-1.822315'
    );

    var feeds = feedsCSV.split(',').map(function(s){ return s.trim(); }).filter(Boolean);

    var promises = feeds.map(fetchAndParseFeed);
    var settled = await Promise.allSettled(promises);

    var items = [];
    for (var i = 0; i < settled.length; i++) {
      var r = settled[i];
      if (r.status === 'fulfilled' && Array.isArray(r.value)) items = items.concat(r.value);
    }

    if (!items.length) {
      return respond(headers, 502, { items: [], error: 'No items from feeds.' });
    }

    items.sort(function(a,b){ return b.date - a.date; });

    // Fill missing images from article pages (small cap to keep fast)
    await fillMissingImages(items, 8, 2500);

    var out = items.slice(0, limit).map(function(x){
      return {
        source: x.source,
        title: x.title,
        link: x.link,
        date: x.date.toISOString(),
        image: x.image || '',
        summary: x.summary
      };
    });

    return respond(headers, 200, { items: out });
  } catch (e) {
    return respond(headers, 500, { items: [], error: String(e) });
  }
};

// ---------- helpers ----------

function respond(headers, code, obj) {
  return { statusCode: code, headers: headers, body: JSON.stringify(obj) };
}

async function fetchAndParseFeed(feedUrl) {
  var res = await fetch(feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AtlanticTruckBot/1.0; +https://www.atlantictruck.ca/)',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
    }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + feedUrl);
  var xml = await res.text();

  var sourceTitle = getTagText(xml, 'title') || safeHost(feedUrl);
  var isRSS = /<rss\b|<channel\b/i.test(xml);
  var isAtom = /<feed\b/i.test(xml);

  var blocks = isRSS ? (xml.match(/<item[\s\S]*?<\/item>/gi) || [])
                     : (isAtom ? (xml.match(/<entry[\s\S]*?<\/entry>/gi) || []) : []);

  var items = [];
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];

    var title = stripHTML(
      getTagText(block, 'title') ||
      getAttr(block, 'title', 'type') || ''
    );

    var link = getTagText(block, 'link') || getAttr(block, 'link', 'href') || '';

    var pub = getTagText(block, 'pubDate') ||
              getTagText(block, 'published') ||
              getTagText(block, 'updated') || '';

    var rawHtml = getTagText(block, 'content:encoded') ||
                  getTagText(block, 'content') ||
                  getTagText(block, 'description') ||
                  getTagText(block, 'summary') || '';

    var candidates = collectImageCandidates(block);
    var htmlImg = firstImgSrc(rawHtml);
    if (htmlImg) candidates.push({ url: htmlImg, w: 0, h: 0, score: scoreCandidate(htmlImg, '', 0, 0) });

    var best = selectBestImage(candidates);
    var image = absolutize(best && best.url ? best.url : '', link, feedUrl);

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

function safeHost(u) { try { return new URL(u).hostname; } catch (e) { return 'News'; } }

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

function firstImgSrc(html) {
  var m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? decodeHTML(m[1]) : '';
}

async function fillMissingImages(items, maxFetches, timeoutMs) {
  var remaining = maxFetches;
  for (var i = 0; i < items.length; i++) {
    if (!remaining) break;
    var it = items[i];
    if (it.image) continue;
    if (!it.link || it.link === '#') continue;
    try {
      var og = await fetchOgImage(it.link, timeoutMs);
      if (og) it.image = absolutize(og, it.link, it.link);
    } catch (e) {
      // ignore
    }
    remaining--;
  }
}

async function fetchOgImage(url, timeoutMs) {
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = null;
  if (controller) timer = setTimeout(function(){ controller.abort(); }, timeoutMs);

  try {
    var opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AtlanticTruckBot/1.0; +https://www.atlantictruck.ca/)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    };
    if (controller) opts.signal = controller.signal;

    var res = await fetch(url, opts);
    if (!res.ok) return '';
    var html = await res.text();

    var og = metaContent(html, 'property', 'og:image') || metaContent(html, 'name', 'twitter:image') || '';
    return og ? decodeHTML(og) : '';
  } catch (e) {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function metaContent(html, attr, val) {
  var re = new RegExp('<meta[^>]+'+attr+'=["\']'+val+'["\'][^>]*content=["\']([^"\']+)["\'][^>]*>', 'i');
  var m = html.match(re);
  return m ? m[1] : '';
}

// tiny XML helpers
function getTagText(xml, tag) {
  var re = new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)<\\/'+tag+'>', 'i');
  var m = xml.match(re);
  return m ? decodeHTML(cdata(m[1]).trim()) : '';
}
function getAttr(xml, tag, attr) {
  var re = new RegExp('<'+tag+'\\b[^>]*\\b'+attr+'=["\']([^"\']+)["\'][^>]*\\/?>' , 'i');
  var m = xml.match(re);
  return m ? decodeHTML(m[1]) : '';
}
function getAttrRaw(tagXml, attr) {
  var re = new RegExp('\\b'+attr+'=["\']([^"\']+)["\']', 'i');
  var m = tagXml.match(re);
  return m ? decodeHTML(m[1]) : '';
}
function cdata(s) {
  var m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  return m ? m[1] : s;
}
function stripHTML(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}
function decodeHTML(s) {
  s = String(s || '');
  s = s.replace(/&amp;/g, '&');
  s = s.replace(/&lt;/g, '<');
  s = s.replace(/&gt;/g, '>');
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&#39;/g, '\'');
  return s;
}
function absolutize(u, baseLink, feedUrl) {
  if (!u) return '';
  if (u.indexOf('data:') === 0) return '';
  try {
    if (u.indexOf('//') === 0) return 'https:' + u;
    return new URL(u, baseLink || feedUrl).href;
  } catch (e) {
    return u;
  }
}
function isValidDate(d) {
  return d instanceof Date && !isNaN(d.valueOf());
}
