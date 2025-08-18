// netlify/functions/news.js
// Direct RSS fetch + robust image extraction (with og:image fallback).
// Returns { items: [{source,title,link,date,image,summary}, ...] }

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*', // lock to your domain if preferred
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

    // 1) Pull and parse items from each feed
    const results = await Promise.allSettled(feeds.map(fetchAndParseFeed));
    let items = [];
    for (const r of results) {
      if (r.status === 'fulfilled') items.push(...r.value);
      else console.warn('Feed failed:', String(r.reason || 'unknown'));
    }
    if (!items.length) {
      return { statusCode: 502, headers, body: JSON.stringify({ items: [], error: 'No items from feeds.' }) };
    }

    // 2) Try to enrich missing images via og:image (cap the work so it stays fast)
    items.sort((a, b) => b.date - a.date);
    await fillMissingImages(items, /*maxFetches*/ 8, /*timeoutMs*/ 2500);

    // 3) Trim and return
    const out = items.slice(0, limit).map(x => ({
      source: x.source,
      title: x.title,
      link: x.link,
      date: x.date.toISOString(),
      image: x.image || '',
      summary: x.summary
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ items: out }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ items: [], error: String(e) }) };
  }
};

// ============ RSS parsing (no dependencies) ============

async function fetchAndParseFeed(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AtlanticTruckBot/1.0; +https://www.atlantictruck.ca/)',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${feedUrl}`);
  const xml = await res.text();

  const sourceTitle = getTagText(xml, 'title') || new URL(feedUrl).hostname;
  const isRSS = /<rss\b|<channel\b/i.test(xml);
  const isAtom = /<feed\b/i.test(xml);

  const blocks = isRSS
    ? (xml.match(/<item[\s\S]*?<\/item>/gi) || [])
    : isAtom
      ? (xml.match(/<entry[\s\S]*?<\/entry>/gi) || [])
      : [];

  const items = [];
  for (const block of blocks) {
    const title = stripHTML(
      getTagText(block, 'title') ||
      getAttr(block, 'title', 'type') || // atom edge
      ''
    );

    // Link: RSS <link> or Atom <link href="...">
    let link = getTagText(block, 'link') || getAttr(block, 'link', 'href') || '';
    // Robust absolutization happens later when we build image URLs

    const pub =
      getTagText(block, 'pubDate') ||
      getTagText(block, 'published') ||
      getTagText(block, 'updated') ||
      '';

    // Prefer content:encoded -> description -> content/summary
    const rawHtml =
      getTagText(block, 'content:encoded') ||
      getTagText(block, 'content') ||
      getTagText(block, 'description') ||
      getTagText(block, 'summary') ||
      '';

    // Gather all image candidates from common tags
    const candidates = collectImageCandidates(block);

    // Also scan the HTML body for <img>
    const htmlImg = firstImgSrc(rawHtml);
    if (htmlImg) candidates.push({ url: htmlImg, w: 0, h: 0, score: 40 });

    // Pick best candidate and normalize it
    const best = selectBestImage(candidates);
    const image = absolutize(best?.url || '', link, feedUrl);

    const date = pub ? new Date(pub) : new Date();
    const summary = stripHTML(rawHtml).slice(0, 300).trim();

    if (!title && !link) continue; // skip junk

    items.push({
      source: stripHTML(sourceTitle),
      title: title || 'Untitled',
      link: link || '#',
      date: isValidDate(date) ? date : new Date(),
      image: image || '',
      summary
    });
  }
  return items;
}

function collectImageCandidates(blockXml) {
  const out = [];

  // <enclosure url="..." type="image/jpeg" width="..." height="..."/>
  const encl = blockXml.match(/<enclosure\b[^>]*>/gi) || [];
  for (const tag of encl) {
    const url = getAttrRaw(tag, 'url');
    const type = (getAttrRaw(tag, 'type') || '').toLowerCase();
    const w = parseInt(getAttrRaw(tag, 'width') || '0', 10) || 0;
    const h = parseInt(getAttrRaw(tag, 'height') || '0', 10) || 0;
    if (url) out.push({ url, w, h, score: scoreCandidate(url, type, w, h) });
  }

  // <media:content url="...">, <media:thumbnail url="...">, <media:group><media:content ...>
  const mediaTags = blockXml.match(/<(media:content|media:thumbnail)\b[^>]*>/gi) || [];
  for (const tag of mediaTags) {
    const url = getAttrRaw(tag, 'url');
    const type = (getAttrRaw(tag, '
