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
      re
