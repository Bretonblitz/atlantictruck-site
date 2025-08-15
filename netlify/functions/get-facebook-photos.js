// netlify/functions/get-facebook-photos.js (CommonJS, Node 18+)
const API = 'https://graph.facebook.com/v19.0/';

exports.handler = async function (event) {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_ACCESS_TOKEN;
  const limit = Math.max(1, Math.min(50, parseInt((event.queryStringParameters?.limit) || '30')));

  if (!token || !pageId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing FB_PAGE_ID or FB_ACCESS_TOKEN' }) };
  }

  const fetchJson = async (url) => {
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    return j;
  };

  try {
    // 1) Try "uploaded" photos first
    const fields = 'id,permalink_url,created_time,name,images,full_picture,link';
    const photosUrl = `${API}${pageId}/photos?type=uploaded&fields=${fields}&limit=${limit}&access_token=${encodeURIComponent(token)}`;
    let data = (await fetchJson(photosUrl)).data || [];

    // 2) If none returned, fall back to post attachments (carousels/images on posts)
    if (!data.length) {
      const postFields = [
        'permalink_url',
        'created_time',
        'message',
        'full_picture',
        'attachments{media_type,media,image,subattachments}'
      ].join(',');
      const postsUrl = `${API}${pageId}/posts?fields=${postFields}&limit=${Math.min(limit, 20)}&access_token=${encodeURIComponent(token)}`;
      const posts = (await fetchJson(postsUrl)).data || [];

      // Flatten images from attachments/subattachments
      const imgs = [];
      for (const p of posts) {
        const atts = p.attachments?.data || [];
        for (const a of atts) {
          // single image
          const single =
            a.media?.image?.src ||
            a.media?.source ||
            p.full_picture;

          if (single) {
            imgs.push({
              id: `${p.id}-a`,
              permalink_url: p.permalink_url,
              created_time: p.created_time,
              full_picture: single
            });
          }

          // carousel images
          const subs = a.subattachments?.data || [];
          for (const s of subs) {
            const src = s.media?.image?.src || s.media?.source;
            if (src) {
              imgs.push({
                id: `${p.id}-${s.target?.id || Math.random().toString(36).slice(2)}`,
                permalink_url: p.permalink_url,
                created_time: p.created_time,
                full_picture: src
              });
            }
          }
        }
      }
      data = imgs.slice(0, limit);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ data })
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
