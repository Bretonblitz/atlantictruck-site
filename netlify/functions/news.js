// netlify/functions/news.js
// CommonJS handler for maximum Netlify compatibility.
// Merges multiple RSS feeds server-side via rss2json and returns JSON { items: [...] }.

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*', // lock to your domain if you prefer
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=300, s-maxage=600',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const apiKey = process.env.RSS2JSON_API_KEY || '';
    const limit = Number(process.env.NEWS_LIMIT || 36);

    const feedsCSV = process.env.FEED_URLS || [
      'https://www.trucknews.com/rss/',
      'https://www.ttnews.com/rss.xml',
      'https://atlantic.ctvnews.ca/rss/ctv-news-atlantic-public-rss-1.822315'
    ].join(',');

    const feeds = feedsCSV.split(',').map(s => s.trim()).filter(Boolean);
    const results = await Promise.allSettled(feeds.map(url => fetchFeed(url, apiKey)));

    const items = [];
    for (const r of results) {
      if (r.status === 'fulfilled') items.push(...r.value);
    }

    if (!items.length) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ items: [], error: 'No items from feeds' })
      };
    }

    items.sort((a, b) => b.date - a.date);
    const out = items.slice(0, limit).map(x => ({
      source: x.source,
      title: x.title,
      link: x.link,
      date: x.date.toISOString(),
      image: x.image,
      summary: x.summary
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ items: out }) };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ items: [], error: String(e) })
    };
  }
};

// ---- helpers ----
async function fetchFeed(feedUrl, apiKey) {
  const base = 'https://api.rss2json.com/v1/api.json';
  const params = new URLSearchParams({ rss_url: feedUrl, count: '12' });
  if (apiKey) params.set('api_key', apiKey);

  const res = await fetch(`${base}?${params.toString()}`, { headers: { 'Accept': 'application/json' } });
  const data = await res.json();
  if (!res.ok || data.status !== 'ok' || !Array.isArray(data.items)) {
    throw new Error(`Feed failed: ${feedUrl}`);
  }

  const source = (data.feed && data.feed.title) || new URL(feedUrl).hostname;
  return (data.items || []).map(item => mapItem(source, item)).filter(Boolean);
}

function mapItem(source, item) {
  const title = item.title || 'Untitled';
  const link  = item.link || '#';
  const date  = new Date(item.pubDate || item.isoDate || item.published || Date.now());
  const image = extractImage(item);
  const summary = stripHTML(item.description || item.content || '').trim().slice(0, 300);
  return { source, title, link, date, image, summary };
}

function extractImage(item) {
  if (item.thumbnail) return harden(item.thumbnail);
  if (item.enclosure) {
    const e = item.enclosure.link || item.enclosure.url;
    if (e && (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(e) || (item.enclosure.type||'').startsWith('image/'))) {
      return harden(e);
    }
  }
  const html = item.content || item.content_encoded || item.description || '';
  const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? harden(m[1]) : '';
}

function stripHTML(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function harden(u) {
  return u && u.startsWith('//') ? 'https:' + u : (u || '');
}
