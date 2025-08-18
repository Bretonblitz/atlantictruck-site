// netlify/functions/news.js
// Merges multiple RSS feeds server-side using rss2json (with API key).
// Netlify env vars (Site settings → Environment variables):
//   RSS2JSON_API_KEY = <your key>  (recommended)
//   FEED_URLS = https://www.trucknews.com/rss/,https://www.ttnews.com/rss.xml,https://atlantic.ctvnews.ca/rss/ctv-news-atlantic-public-rss-1.822315
// Optional:
//   NEWS_LIMIT = 36

export default async (req, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*', // or lock to your domain
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=300, s-maxage=600'
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers });

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
    if (!items.length) return json({ items: [], error: 'No items from feeds' }, 502, headers);

    items.sort((a,b) => b.date - a.date);
    const out = items.slice(0, limit).map(x => ({
      source: x.source,
      title: x.title,
      link: x.link,
      date: x.date.toISOString(),
      image: x.image,
      summary: x.summary
    }));

    return json({ items: out }, 200, headers);
  } catch (e) {
    return json({ items: [], error: String(e) }, 500, headers);
  }
};

async function fetchFeed(feedUrl, apiKey) {
  const base = 'https://api.rss2json.com/v1/api.json';
  const params = new URLSearchParams({ rss_url: feedUrl, count: '12' });
  if (apiKey) params.set('api_key', apiKey);
  const url = `${base}?${params.toString()}`;

  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const data = await res.json();
  if (!res.ok || data.status !== 'ok') throw new Error(`Feed failed: ${feedUrl}`);

  const title = (data.feed && data.feed.title) || '';
  return (data.items || []).map(item => mapItem(title, item)).filter(Boolean);
}

function mapItem(source, item) {
  const date = new Date(item.pubDate || item.isoDate || item.published || Date.now());
  const image = extractImage(item);
  const summary = stripHTML(item.description || item.content || '').trim().slice(0, 300);
  const link = item.link || '#';
  const title = item.title || 'Untitled';
  // filter: skip items with neither title nor link
  if (!title && (!link || link === '#')) return null;
  return { source, title, link, date, image, summary };
}

function extractImage(item) {
  if (item.thumbnail) return harden(item.thumbnail);
  if (item.enclosure) {
    const e = item.enclosure.link || item.enclosure.url;
    if (e && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(e)) return harden(e);
    if ((item.enclosure.type || '').startsWith('image/') && e) return harden(e);
  }
  const html = item.content || item.content_encoded || item.description || '';
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? harden(m[1]) : '';
}

function stripHTML(html){ return (html||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim(); }
function harden(u){ if (!u) return ''; return u.startsWith('//') ? 'https:' + u : u; }

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
