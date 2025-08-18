// netlify/functions/news.js
// Direct RSS fetch + robust image extraction + "no boring corporate appointments" filter.
// CommonJS + ASCII-only to avoid syntax issues on Netlify.

exports.handler = async function (event) {
  var headers = {
    'Access-Control-Allow-Origin': '*', // set to your domain if you prefer
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
    // You can override in Netlify env FEED_URLS (comma-separated).
    var feedsCSV = process.env.FEED_URLS || (
      'https://www.trucknews.com/rss/,' +
      'https://www.ttnews.com/rss.xml,' +
      'https://atlantic.ctvnews.ca/rss/ctv-news-atlantic-public-rss-1.822315,' +
      'https://www.freightwaves.com/feed,' +
      'https://theloadstar.com/feed/,' +
      'https://www.cbc.ca/cmlink/rss-canada-ns'
    );
    var feeds = feedsCSV.split(',').map(function(s){ return s.trim(); }).filter(Boolean);

    // 1) Pull and parse
    var settled = await Promise.allSettled(feeds.map(fetchAndParseFeed));
    var items = [];
    for (var i = 0; i < settled.length; i++) {
      var r = settled[i];
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        items = items.concat(r.value);
      }
    }
    if (!items.length) {
      return respond(headers, 502, { items: [], error: 'No items from feeds.' });
    }

    // 2) Filter out corporate HR / exec appointments / promos
    items = items.filter(function (it) { return !isCorporateHR(it.title); });

    // 3) Sort newest first
    items.sort(function(a, b){ return b.date - a.date; });

    // 4) Enrich missing images via article pages (limit fetches for speed)
    await fillMissingImages(items, 10, 3000);

    // 5) Trim and respond
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

// ---------------- helpers ----------------

function respond(headers, code, obj) {
  return { statusCode: code, headers: headers, body: JSON.stringify(obj) };
}

function isCorporateHR(title) {
  if (!title) return false;
  var t = title.toLowerCase();
  // filter promotions, executive appointments, board changes, obits, anniversaries, sponsored
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

    // Collect image candidates from common tags inside the item
    var candidates = collectImageCandidates(block);

    // Scan any embedded HTML for <img> and srcset
    var htmlImg = firstImgSrc(rawHtml);
    if (htmlImg) candidates.push({ url: htmlImg, w: 0, h: 0, score: scoreCandidate(htmlImg, '', 0, 0) });
    var srcsetBest = firstSrcsetBest(rawHtml);
    if (srcsetBest) candidates.push({ url: srcsetBest, w: 0, h: 0, score: scoreCandidate(srcsetBest, '', 0, 0) });

    var best = selectBestImage(candidates);
    var image = absolutize(best && best.url ? best.url : '', link, feedUrl);
    image = preferLargeVariant(image); // upgrade WP style "-300x200" to full

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

// ---- image candidate collection ----
function collectImageCandidates(blockXml) {
  var out = [];

  // <enclosure ...>
  var encl = blockXml.match(/<enclosure\b[^>]*>/gi) || [];
  for (var i = 0; i < encl.length; i++) {
    var tag = encl[i];
    var url = getAttrRaw(tag, 'url');
    var type = (getAttrRaw(tag, 'type') || '').toLowerCase();
    var w = parseInt(getAttrRaw(tag, 'width') || '0', 10) || 0;
    var h = parseInt(getAttrRaw(tag, 'height') || '0', 10) || 0;
    if (url) out.push({ url: url, w: w, h: h, score: scoreCandidate(url, type, w, h) });
  }

  // <media:content> / <media:thumbnail>
  var mediaTags = blockXml.match(/<(media:content|media:thumbnail)\b[^>]*>/gi) || [];
  for (var j = 0; j < mediaTags.length; j++) {
    var tag2 = mediaTags[j];
    var url2 = getAttrRaw(tag2, 'url');
    var type2 = (getAttrRaw(tag2, 'type') || '').toLowerCase();
    var w2 = parseInt(getAttrRaw(tag2, 'width') || '0', 10) || 0;
    var h2 = parseInt(getAttrRaw(tag2, 'height') || '0', 10) || 0;
    if (url2) out.push({ url: url2, w: w2, h: h2, score: scoreCandidate(url2, type2, w2, h2) });
  }

  // any <img src="..."> in the item XML itself
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

function firstSrcsetBest(html) {
  var mm = html && html.match(/<img[^>]+srcset=["']([^"']+)["']/i);
  if (!mm || !mm[1]) return '';
  var srcset = mm[1].split(',').map(function(s){ return s.trim(); });
  var bestUrl = '';
  var bestWidth = 0;
  for (var i = 0; i < srcset.length; i++) {
    var part = srcset[i]; // "url 1200w"
    var m = part.match(/(\S+)\s+(\d+)w/);
    var url = '';
    var w = 0;
    if (m) { url = m[1]; w = parseInt(m[2], 10) || 0; }
    else { url = part.split(' ')[0]; w = 0; }
    if (w >= bestWidth) { bestWidth = w; bestUrl = url; }
  }
  return bestUrl;
}

function preferLargeVariant(u) {
  // Upgrade common WordPress sized images: ...-300x200.jpg -> ... .jpg
  if (!u) return u;
  var m = u.match(/(.*)-\d+x\d+(\.[a-zA-Z0-9]+)(\?.*)?$/);
  if (m) return m[1] + m[2] + (m[3] || '');
  return u;
}

// ---- fill missing images by scraping article page ----
async function fillMissingImages(items, maxFetches, timeoutMs) {
  var remaining = maxFetches;
  for (var i = 0; i < items.length; i++) {
    if (!remaining) break;
    var it = items[i];
    if (it.image) continue;
    if (!it.link || it.link === '#') continue;

    try {
      var og = await fetchArticleImage(it.link, timeoutMs);
      if (og) {
        it.image = absolutize(preferLargeVariant(og), it.link, it.link);
      }
    } catch (e) {
      // ignore
    }
    remaining--;
  }
}

async function fetchArticleImage(url, timeoutMs) {
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

    // Try multiple meta patterns
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

    return img ? decodeHTML(img) : '';
  } catch (e) {
    return '';
  } finally {
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
  // Find first <script type="application/ld+json"> that contains "image"
  var scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/ig) || [];
  for (var i = 0; i < scripts.length; i++) {
    var raw = scripts[i].replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    try {
      var obj = JSON.parse(raw);
      var url = extractJsonLdImage(obj);
      if (url) return url;
    } catch (e) { /* ignore parse errors */ }
  }
  return '';
}
function extractJsonLdImage(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) {
    for (var i = 0; i < obj.length; i++) {
      var v = extractJsonLdImage(obj[i]);
      if (v) return v;
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
    // Dive deeper
    var keys = Object.keys(obj);
    for (var k = 0; k < keys.length; k++) {
      var v2 = extractJsonLdImage(obj[keys[k]]);
      if (v2) return v2;
    }
  }
  return '';
}

// ---- tiny XML/HTML utils ----
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
