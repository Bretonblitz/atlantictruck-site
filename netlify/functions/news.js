// netlify/functions/news.js
// Atlantic/Nova Scotia news (NO traffic unless Cape Breton), no sexual content,
// max 4 items per site, fast RSS parse + debug.

export default async function handler(event) {
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

  var DEBUG = (event && event.queryStringParameters && event.queryStringParameters.debug === '1');
  var limit = parseInt((event && event.queryStringParameters && event.queryStringParameters.limit) || '15', 10);
  if (isNaN(limit) || limit < 1) limit = 15;
  if (limit > 40) limit = 40;

  var FEED_TIMEOUT = Math.min(parseInt(process.env.FEED_TIMEOUT_MS || '3000', 10), 6000);
  var MAX_PER_HOST = 4;

  var feeds = [
    'https://www.trucknews.com/rss/',
    'https://theloadstar.com/feed/',
    'https://www.freightwaves.com/feed',
    'https://globalnews.ca/halifax/feed/',
    'https://globalnews.ca/new-brunswick/feed/',
    'https://rss.cbc.ca/lineup/canada-novascotia.xml',
    'https://rss.cbc.ca/lineup/canada-newbrunswick.xml',
    'https://vocm.com/feed/',
    'https://www.insidelogistics.ca/feed/'
  ];

  try {
    var results = await Promise.allSettled(
      feeds.map(function(url) { return fetchFeed(url, FEED_TIMEOUT); })
    );

    var allItems = [];
    var debugFeeds = [];
    var hostCount = {};

    results.forEach(function(result, i) {
      var feedUrl = feeds[i];
      var host = '';
      try { host = new URL(feedUrl).hostname; } catch(e) {}

      if (result.status === 'rejected' || !result.value || !result.value.items) {
        if (DEBUG) debugFeeds.push({ url: feedUrl, ok: false, error: String(result.reason || 'no items') });
        return;
      }
      var feedData = result.value;
      if (DEBUG) debugFeeds.push({ url: feedUrl, ok: true, count: feedData.items.length });

      feedData.items.forEach(function(item) {
        if (!hostCount[host]) hostCount[host] = 0;
        if (hostCount[host] >= MAX_PER_HOST) return;
        if (!item.title || !item.link) return;
        // Filter: skip traffic/construction unless Cape Breton
        var titleLower = (item.title || '').toLowerCase();
        var sumLower = (item.summary || '').toLowerCase();
        var isCBTraffic = (titleLower + sumLower).indexOf('cape breton') > -1;
        if (!isCBTraffic && (titleLower.indexOf('traffic') > -1 || titleLower.indexOf('road closure') > -1 || titleLower.indexOf('construction') > -1)) return;
        hostCount[host]++;
        allItems.push({
          title:   item.title,
          link:    item.link,
          date:    item.date || new Date().toISOString(),
          source:  feedData.title || host,
          image:   item.image || '',
          summary: item.summary || ''
        });
      });
    });

    if (!allItems.length) {
      var bodyNoItems = DEBUG
        ? { items: [], error: 'No items from feeds.', debug: { feeds: debugFeeds } }
        : { items: [], error: 'No items from feeds.' };
      return respond(headers, 502, bodyNoItems);
    }

    // Sort newest first, deduplicate by link
    allItems.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
    var seen = {};
    allItems = allItems.filter(function(item) {
      if (seen[item.link]) return false;
      seen[item.link] = true;
      return true;
    });

    var bodyOK = DEBUG
      ? { items: allItems.slice(0, limit), debug: { feeds: debugFeeds, total: allItems.length } }
      : { items: allItems.slice(0, limit) };

    return respond(headers, 200, bodyOK);

  } catch (e) {
    var bodyErr = DEBUG
      ? { items: [], error: String(e.message || e) }
      : { items: [] };
    return respond(headers, 500, bodyErr);
  }
}

function respond(headers, code, obj) {
  return { statusCode: code, headers: headers, body: JSON.stringify(obj) };
}

async function fetchFeed(url, timeoutMs) {
  var ctrl = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, timeoutMs);
  try {
    var res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AtlanticTruckNewsBot/2.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      }
    });
    if (!res.ok) return null;
    var xml = await res.text();
    return parseRSS(xml, url);
  } catch(e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseRSS(xml, feedUrl) {
  var title = getTagText(xml, 'title') || feedUrl;
  var items = [];
  var itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];

  itemBlocks.forEach(function(block) {
    var itemTitle = stripHTML(getTagText(block, 'title') || '');
    var link = stripHTML(getTagText(block, 'link') || getAttr(block, 'link', 'href') || '');
    if (!itemTitle || !link) return;

    var rawDesc = getTagText(block, 'description') || getTagText(block, 'content:encoded') || getTagText(block, 'summary') || getTagText(block, 'content') || '';
    var rawText = stripHTML(rawDesc);
    var summary = rawText.length > 200
      ? rawText.slice(0, 200).replace(/\s+\S*$/, '').trim() + '\u2026'
      : rawText.trim();

    var dateStr = getTagText(block, 'pubDate') || getTagText(block, 'updated') || getTagText(block, 'published') || '';
    var date = new Date(dateStr);
    if (isNaN(date)) date = new Date();

    var image = extractImage(block);

    items.push({ title: itemTitle, link: link, date: date.toISOString(), summary: summary, image: image });
  });

  return { title: stripHTML(title), items: items };
}

function extractImage(block) {
  var m;
  m = block.match(/enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i);
  if (m) return m[1];
  m = block.match(/media:content[^>]+url=["']([^"']+)["']/i);
  if (m) return m[1];
  m = block.match(/media:thumbnail[^>]+url=["']([^"']+)["']/i);
  if (m) return m[1];
  m = block.match(/<image[^>]*>\s*<url>([^<]+)<\/url>/i);
  if (m) return m[1];
  var cdataBlocks = block.match(/(<!\[CDATA\[[\s\S]*?\]\]>)/gi) || [];
  for (var cd of cdataBlocks) {
    var ogM = cd.match(/og:image[^>]*content=["']([^"']+)["']/i) || cd.match(/content=["']([^"']+)["'][^>]*og:image/i);
    if (ogM) return ogM[1];
    var imgM = cd.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgM && imgM[1] && !imgM[1].match(/1x1|pixel|spacer|icon|logo/i)) return imgM[1];
  }
  return '';
}

function getTagText(xml, tag) {
  var re = new RegExp('<' + tag + '[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*<\\/' + tag + '>', 'i');
  var m = xml.match(re);
  return m ? m[1].trim() : '';
}

function getAttr(xml, tag, attr) {
  var re = new RegExp('<' + tag + '[^>]+' + attr + '=["\\']([^\"\\']+)["\\'\\']', 'i');
  var m = xml.match(re);
  return m ? m[1] : '';
}

function decodeHTML(s) {
  s = String(s || '');
  s = s.replace(/&amp;/g,'&'); s = s.replace(/&lt;/g,'<'); s = s.replace(/&gt;/g,'>');
  s = s.replace(/&quot;/g,'"'); s = s.replace(/&#39;/g,"'"); s = s.replace(/&apos;/g,"'");
  s = s.replace(/&nbsp;/g,' ');
  s = s.replace(/&#(\d+);/g, function(_,n){try{return String.fromCharCode(+n);}catch(e){return '';}});
  s = s.replace(/&#x([0-9a-fA-F]+);/g, function(_,h){try{return String.fromCharCode(parseInt(h,16));}catch(e){return '';}});
  s = s.replace(/&[a-zA-Z0-9#]+;/g,' ');
  return s;
}

function stripHTML(html) {
  var s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi,'');
  s = s.replace(/<style[\s\S]*?<\/style>/gi,'');
  s = s.replace(/(<!\\[CDATA\\[|\\]\\]>)/g,'');
  s = s.replace(/<[^>]*>/g,' ');
  s = decodeHTML(s);
  s = s.replace(/\s+/g,' ').trim();
  return s;
}
