// netlify/functions/get-facebook-photos.js — Netlify v2
const API = 'https://graph.facebook.com/v20.0/';

export default async (req, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=600'
  };

  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers });
  }

  const qs = new URL(req.url).searchParams;
  const limitParam = parseInt(qs.get('limit') || '12', 10);
  const limit = isNaN(limitParam) ? 12 : Math.min(limitParam, 50);

  const pageId = process.env.FB_PAGE_ID || process.env.FB_PAGEID || process.env.FACEBOOK_PAGE_ID || '';
  const token  = process.env.FB_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_PAGE_TOKEN || '';

  if (!pageId || !token) {
    return new Response(
      JSON.stringify({ error: 'Missing FB_PAGE_ID or FB_ACCESS_TOKEN in environment.' }),
      { status: 500, headers }
    );
  }

  try {
    const fields = 'id,full_picture,picture,source,permalink_url,created_time';
    const url = `${API}${pageId}/photos?type=uploaded&fields=${fields}&limit=${limit}&access_token=${token}`;
    const res = await fetch(url);
    const json = await res.json();

    if (!res.ok || json.error) {
      return new Response(
        JSON.stringify({ error: json.error?.message || `FB API error ${res.status}` }),
        { status: 502, headers }
      );
    }

    // Deduplicate by ID
    const seen = new Set();
    const data = (json.data || []).filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    return new Response(
      JSON.stringify({ data }),
      { status: 200, headers }
    );

  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e.message || e) }),
      { status: 502, headers }
    );
  }
};
