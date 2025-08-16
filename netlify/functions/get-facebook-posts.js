// netlify/functions/fb-posts.js
// Fetch latest public posts from a Facebook Page using env vars.
// Env required in Netlify UI:
//   FB_PAGE_ID = 766439739884645
//   FB_PAGE_ACCESS_TOKEN = EAA7FJwBfHX0BPLAsLkycY0shUViEk9gPKZB90QKx9BZBpdZAqmmlPxKudPukFppqoCFovy8pSIwfZBAtXj7hpg3f7lsTpFsjGVTJBqsO2V0eeZCPnKd4fKwcSsZBeq73boYY78AjRF1uDwUWZAjWq34TZBHUvAf34voBLisbnHtryHuZAuI0edfFO1LmE5693rNwmqCBc1FgQq0R8YLUYox7CYJpG
// Optional:
//   FB_GRAPH_VERSION = v20.0
//   FB_POSTS_LIMIT = 15

export default async (req, context) => {
  // Basic CORS
  const headers = {
    'Access-Control-Allow-Origin': '*', // or your domain: 'https://www.atlantictruck.ca'
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=600, s-maxage=900'
  };
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers });
  }

  try {
    const pageId = process.env.FB_PAGE_ID;
    const token = process.env.FB_PAGE_ACCESS_TOKEN;
    const version = process.env.FB_GRAPH_VERSION || 'v20.0';
    const limit = Number(process.env.FB_POSTS_LIMIT || 15);

    if (!pageId || !token) {
      return json({ error: 'Missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN' }, 500, headers);
    }

    // Pull posts with fields useful for rendering (pictures, message, link)
    const fields = [
      'id',
      'message',
      'story',
      'created_time',
      'permalink_url',
      'full_picture',
      'attachments{media_type,description,media,target,url,subattachments}'
    ].join(',');

    const url = new URL(`https://graph.facebook.com/${version}/${pageId}/posts`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('access_token', token);

    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await res.json();

    if (!res.ok) {
      return json({ error: 'Facebook API error', details: data }, res.status, headers);
    }

    const items = (data.data || []).map(mapPost).filter(Boolean);
    return json({ items }, 200, headers);

  } catch (err) {
    return json({ error: 'Server error', details: String(err) }, 500, { 'Content-Type': 'application/json', ...headers });
  }
};

function mapPost(p) {
  const message = (p.message || p.story || '').trim();
  const created = new Date(p.created_time || Date.now());
  const image = extractImage(p);
  const link = p.permalink_url || '#';

  // Filter out totally empty posts
  if (!message && !image) return null;

  return {
    id: p.id,
    message,
    createdISO: created.toISOString(),
    createdHuman: created.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    image,
    link
  };
}

function extractImage(p) {
  if (p.full_picture) return p.full_picture;

  // attachments tree
  const a = p.attachments && p.attachments.data && p.attachments.data[0];
  if (a && a.media && a.media.image && a.media.image.src) return a.media.image.src;

  // subattachments (albums/multi-photos)
  if (a && a.subattachments && a.subattachments.data) {
    const sub = a.subattachments.data.find(s => s.media && s.media.image && s.media.image.src);
    if (sub) return sub.media.image.src;
  }
  return '';
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
