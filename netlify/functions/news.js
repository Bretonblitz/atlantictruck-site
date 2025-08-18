// netlify/functions/news.js
// Direct RSS fetch + lightweight XML parsing (no external services).
// Returns { items: [{source,title,link,date,image,summary}, ...] }

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
    const limit = Number(process.env.NEWS_LIMIT || 36);
    const feedsCSV =
      process.env.FEED_URLS ||
      [
        'https://www.trucknews.com/rss/',
        'https://www.ttnews.com/rss.xml',
        'https://atlantic.ctvnews.ca/rss/ctv-news-atlantic-public-rss-1.822315'
      ].join(',');

    const feeds = feedsCSV.split(',').map(s => s.trim()).filter(Boolean);

    const results = await Promise.allSettled(feeds.map(fetchAndParseFeed));
    const items = [];
    for (const r of results) {
      if (r.status === 'fulfilled') items.push(...r.value);
      else console.warn('Feed failed:', r.reason && String(r.reason));
    }

    if (!items.length) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ items: [], error: 'No items from feeds (RSS fetch/parse failed).' })
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
    return { statusCode: 500, headers, body: JSON.stringify({ items: [], error: String(e) }) };
  }
};

// ---- RSS helpers (no deps) ----
async function fetchAndParseFeed(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: {
      // some publishers serve different markup to bots; this helps
      'User-Agent': 'Mozilla/5.0 (compatible; AtlanticTruckBot/1.0; +https://www.atlantictruck.ca/)',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${feedUrl}`);
  const xml = await res.text();

  const source = getTagText(xml, 'title') || new URL(feedUrl).hostname;
  const isRSS = /<rss\b|<channel\b/i.test(xml);
  const isAtom = /<feed\b/i.test(xml);

  const blocks = isRSS
    ? (xml.match(/<item[\s\S]*?<\/item>/gi) || [])
    : isAtom
      ? (xml.match(/<entry[\s\S]*?<\/entry>/gi) || [])
      : [];

  const items = [];
  for (const block of blocks) {
    const title =
      getTagText(block, 'title') ||
      getAttr(block, 'title', 'type'); // atom sometimes
    // Link: RSS <link> or Atom <link href="...">
    let link = getTagText(block, 'link');
    if (!link) link = getAttr(block, 'link', 'href') || '';

    const pub =
      getTagText(block, 'pubDate') ||
      getTagText(block, 'published') ||
      getTagText(block, 'updated') ||
      '';

    const rawDesc =
      getTagText(block, 'description') ||
      getTagText(block, 'content') ||
      getTagText(block, 'summary') ||
      '';

    const enclosure =
      getAttr(block, 'enclosure', 'url') ||
      getAttr(block, 'media:content', 'url') ||
      getAttr(block, 'media:thumbnail', 'url') ||
      '';

    const imgFromHtml = firstImgSrc(rawDesc);
    const image = harden(enclosure || imgFromHtml || '');

    const date = pub ? new Date(pub) : new Date();
    const summary = stripHTML(rawDesc).slice(0, 300).trim();

    // filter out junk
    if (!title && !link) continue;

    items.push({
      source: stripHTML(source),
      title: stripHTML(title) || 'Untitled',
      link: link || '#',
      date: isValidDate(date) ? date : new Date(),
      image,
      summary
    });
  }
  return items;
}

function getTagText(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? decodeHTML(cdata(m[1]).trim()) : '';
}
function getAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["'][^>]*\\/?>`, 'i');
  const m = xml.match(re);
  return m ? decodeHTML(m[1]) : '';
}
function firstImgSrc(html) {
  const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? decodeHTML(m[1]) : '';
}
function stripHTML(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}
function cdata(s) {
  // unwrap <![CDATA[ ... ]]>
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  return m ? m[1] : s;
}
function decodeHTML(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function harden(u) {
  if (!u) return '';
  if (u.startsWith('//')) return 'https:' + u;
  return u;
}
function isValidDate(d) {
  return d instanceof Date && !isNaN(d.valueOf());
}
