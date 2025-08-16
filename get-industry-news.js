// netlify/functions/get-industry-news.js
// Node 18+ runtime (fetch is built-in)
// Aggregates trucking/HD news from official RSS feeds and returns JSON.

import { XMLParser } from 'fast-xml-parser';

const FEEDS = [
  // Transport Topics (official RSS)
  'https://www.ttnews.com/rss.xml',
  // Heavy Equipment Guide (site has RSS & Trucks category)
  'https://www.heavyequipmentguide.ca/rss',
  // FMCSA newsroom RSS
  'https://www.fmcsa.dot.gov/rss.xml'
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text'
});

export async function handler(event) {
  try {
    const qs = event.queryStringParameters || {};
    const limit = Math.min(20, Math.max(1, parseInt(qs.limit || '10', 10)));

    const allItems = [];
    for (const url of FEEDS) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'AtlanticTruckSiteBot/1.0' }});
        if (!res.ok) continue;
        const xml = await res.text();
        const json = parser.parse(xml);

        // RSS (channel.item) or Atom (feed.entry)
        let items = [];
        if (json?.rss?.channel?.item) items = toArray(json.rss.channel.item);
        else if (json?.feed?.entry) items = toArray(json.feed.entry);

        const host = safeHost(url);
        for (const it of items) {
          const mapped = mapItem(it, host);
          if (mapped) allItems.push(mapped);
        }
      } catch (_) {
        // Skip failed feed
      }
    }

    // Sort by date desc and limit
    allItems.sort((a,b) => (b.dateMs||0) - (a.dateMs||0));
    const out = allItems.slice(0, limit).map(stripForClient);

    return json(200, { data: out }, {
      'Cache-Control': 'public, max-age=600',
      'Access-Control-Allow-Origin': '*'
    });

  } catch (e) {
    return json(500, { error: 'Server error', details: String(e) });
  }
}

function toArray(x) { return Array.isArray(x) ? x : (x ? [x] : []); }
function safeHost(u) { try { return new URL(u).host; } catch { return ''; } }
function parseDate(s) { const d = new Date(s); return isNaN(d) ? 0 : d.getTime(); }

function textOnly(htmlish) {
  if (!htmlish) return '';
  return String(htmlish)
    .replace(/<[^>]+>/g, ' ')     // strip tags
    .replace(/\s+/g, ' ')         // collapse spaces
    .trim();
}

function pickImage(obj) {
  // Try common RSS/Atom image locations
  const enc = obj.enclosure;
  if (enc && typeof enc === 'object' && enc['@_url'] && (enc['@_type'] || '').startsWith('image')) {
    return enc['@_url'];
  }
  const media = obj['media:content'] || obj['media:thumbnail'];
  if (media && media['@_url']) return media['@_url'];

  // HEG sometimes nests images in content:encoded
  const content = obj['content:encoded'] || obj.content;
  const m = content && String(content).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function mapItem(it, defaultSource) {
  // RSS style
  const title = it.title?.['#text'] || it.title || '';
  const link =
    (typeof it.link === 'string' ? it.link : it.link?.['#text']) ||
    it.link?.['@_href'] || '';
  const desc =
    it.description?.['#text'] || it.description ||
    it.summary?.['#text'] || it.summary ||
    it['content:encoded'] || it.content || '';
  const pub =
    it.pubDate || it.published || it.updated || it['dc:date'] || '';

  if (!title || !link) return null;

  const img = pickImage(it);
  const srcHost = safeHost(link) || defaultSource;

  return {
    title: textOnly(title),
    link: link,
    source: srcHost.replace(/^www\./,''),
    excerpt: textOnly(desc),
    pubDate: pub,
    dateMs: parseDate(pub),
    image: img
  };
}

function stripForClient(x) {
  const words = x.excerpt.split(' ').filter(Boolean);
  const short = words.slice(0, 50).join(' ');
  return {
    title: x.title,
    link: x.link,
    source: x.source,
    pubDate: x.pubDate,
    image: x.image,
    excerpt: short + (words.length > 50 ? '…' : '')
  };
}

function json(status, body, extra = {}) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body)
  };
}
