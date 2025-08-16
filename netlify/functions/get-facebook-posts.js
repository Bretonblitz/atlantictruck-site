// netlify/functions/get-facebook-posts.js
// Node 18+ (fetch is built-in)

export async function handler(event) {
  try {
    const PAGE_ID   = process.env.FB_PAGE_ID;            // e.g. 766439739884645
    const TOKEN     = process.env.FB_PAGE_ACCESS_TOKEN;  // Long-lived PAGE access token
    const version   = 'v23.0';

    if (!PAGE_ID || !TOKEN) {
      return json(500, { error: 'Missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN env vars' });
    }

    const qs = event.queryStringParameters || {};
    const limit = Math.min(10, Math.max(1, parseInt(qs.limit || '10', 10)));

    // Ask Facebook for posts + all attachments (including multi-image carousels)
    const fields = 'message,permalink_url,created_time,full_picture,attachments{media,subattachments{media}}';
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(PAGE_ID)}/posts` +
                `?fields=${encodeURIComponent(fields)}&limit=${limit}&access_token=${encodeURIComponent(TOKEN)}`;

    const fbRes = await fetch(url);
    if (!fbRes.ok) {
      const txt = await fbRes.text();
      return json(fbRes.status, { error: 'Facebook error', details: txt });
    }
    const fb = await fbRes.json();

    // Normalize to a clean list of images per post
    const out = (fb.data || []).map(p => {
      const images = [];
      const pushMedia = (m) => {
        if (!m) return;
        const src = m.image?.src || m.source || m.url;
        if (src) images.push(src);
      };

      const attachments = p.attachments?.data || [];
      attachments.forEach(a => {
        if (a.subattachments?.data?.length) {
          a.subattachments.data.forEach(sa => pushMedia(sa.media));
        } else {
          pushMedia(a.media);
        }
      });

      // Fallback to top-level full_picture if nothing else came back
      if (!images.length && p.full_picture) images.push(p.full_picture);

      // De-dup while preserving first-seen URLs
      const seen = new Set();
      const uniq = [];
      for (const u of images) {
        const key = (u.split('?')[0] || '').toLowerCase();
        if (!seen.has(key)) { seen.add(key); uniq.push(u); }
      }

      return {
        id: p.id,
        created_time: p.created_time,
        message: p.message || '',
        permalink_url: p.permalink_url || '',
        images: uniq
      };
    });

    // Cache a bit at the edge
    return json(200, { data: out }, { 'Cache-Control': 'public, max-age=300' });
  } catch (e) {
    return json(500, { error: 'Server error', details: String(e) });
  }
}

function json(status, body, extra = {}) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body)
  };
}

