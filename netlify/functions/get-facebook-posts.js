// netlify/functions/get-facebook-posts.js
// Node 18+, CommonJS. Uses Graph API v23, resilient fetch, and clear errors.
const API = 'https://graph.facebook.com/v23.0/';

exports.handler = async (event) => {
  const pageId = process.env.FB_PAGE_ID;        // <-- should be 766439739884645
  const token  = process.env.FB_ACCESS_TOKEN;   // <-- your working PAGE token
  const limit  = Math.max(1, Math.min(20, parseInt(event.queryStringParameters?.limit || '6')));

  if (!pageId || !token) {
    return json(500, { error: 'Missing FB_PAGE_ID or FB_ACCESS_TOKEN' });
  }

  const fields = [
    'message',
    'permalink_url',
    'created_time',
    'full_picture',
    'attachments{media_type,media,image,subattachments}'
  ].join(',');

  const url = `${API}${pageId}/posts?fields=${encodeURIComponent(fields)}&limit=${limit}&access_token=${encodeURIComponent(token)}`;

  try {
    const r = await safeFetch(url, 15000);
    const body = await r.json().catch(() => ({}));

    if (!r.ok) {
      return json(r.status, { error: body?.error?.message || `HTTP ${r.status}` });
    }

    const posts = (body.data || []).map(p => {
      // Prefer explicit picture; otherwise pull first image from attachments
      let img = p.full_picture || null;
      const atts = p.attachments?.data || [];
      if (!img) {
        for (const a of atts) {
          img = a?.media?.image?.src || img;
          const subs = a?.subattachments?.data || [];
          for (const s of subs) img = img || s?.media?.image?.src;
          if (img) break;
        }
      }
      return {
        id: p.id,
        permalink_url: p.permalink_url,
        created_time: p.created_time,
        message: p.message || '',
        full_picture: img || null
      };
    });

    // Filter empties & sort newest → oldest
    const cleaned = posts.filter(p => p.permalink_url).sort((a,b) => new Date(b.created_time) - new Date(a.created_time));

    return json(200, { data: cleaned.slice(0, limit) }, { 'Cache-Control': 'public, max-age=300' });
  } catch (e) {
    // Network/timeout/etc → show a clear error so we can see it in the browser
    return json(502, { error: e.message || 'fetch failed' });
  }
};

function json(statusCode, obj, extra = {}) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(obj) };
}

async function safeFetch(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
