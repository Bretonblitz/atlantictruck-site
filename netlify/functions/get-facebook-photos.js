// netlify/functions/get-facebook-photos.js
// Node 18+ (CommonJS). Dedupes images by ID or canonicalized URL.

const API = 'https://graph.facebook.com/v19.0/';

exports.handler = async function (event) {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_ACCESS_TOKEN;
  const limit = Math.max(1, Math.min(50, parseInt(event.queryStringParameters?.limit || '30')));

  if (!pageId || !token) {
    return resp(500, { error: 'Missing FB_PAGE_ID or FB_ACCESS_TOKEN' });
  }

  const fetchJson = async (url) => {
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    return j;
  };

  const canon = (u) => {
    try {
      const x = new URL(u);
      // drop querystring to normalize fbcdn variants
      return `${x.origin}${x.pathname}`.toLowerCase();
    } catch {
      return (u || '').split('?')[0].toLowerCase();
    }
  };

  const pushUnique = (arr, seen, item) => {
    const src = item.full_picture || item.source || item.images?.[0]?.source;
    if (!src) return;
    const key = item.id ? `id:${item.id}` : `url:${canon(src)}`;
    if (seen.has(key)) return;
    seen.add(key);
    arr.push({
      id: item.id || key,
      permalink_url: item.permalink_url || item.link || '',
      created_time: item.created_time || '',
      full_picture: src
    });
  };

  try {
    const out = [];
    const seen = new Set();

    // 1) Try "uploaded" photos
    const photoFields = 'id,permalink_url,created_time,name,images,full_picture,link';
    const photosURL = `${API}${pageId}/photos?type=uploaded&fields=${photoFields}&limit=${limit}&access_token=${encodeURIComponent(token)}`;

    try {
      const p = await fetchJson(photosURL);
      (p.data || []).forEach(ph => pushUnique(out, seen, ph));
    } catch (e) {
      // swallow and continue to posts fallback
      console.warn('Uploaded photos fetch failed:', e.message);
    }

    // 2) Fall back to grabbing images from recent posts (attachments / carousels)
    if (out.length < limit) {
      const postFields = [
        'permalink_url',
        'created_time',
        'message',
        'full_picture',
        'attachments{media_type,media,image,subattachments}'
      ].join(',');
      const postsURL = `${API}${pageId}/posts?fields=${postFields}&limit=25&access_token=${encodeURIComponent(token)}`;
      try {
        const posts = await fetchJson(postsURL);
        (posts.data || []).forEach(p => {
          // hero image on the post
          if (p.full_picture) pushUnique(out, seen, p);
          // attachments and carousels
          (p.attachments?.data || []).forEach(a => {
            if (a?.media?.image?.src) {
              pushUnique(out, seen, {
                id: `${p.id}-a`,
                permalink_url: p.permalink_url,
                created_time: p.created_time,
                full_picture: a.media.image.src
              });
            }
            (a?.subattachments?.data || []).forEach(s => {
              const src = s?.media?.image?.src;
              if (src) {
                pushUnique(out, seen, {
                  id: `${p.id}-${s.target?.id || Math.random().toString(36).slice(2)}`,
                  permalink_url: p.permalink_url,
                  created_time: p.created_time,
                  full_picture: src
                });
              }
            });
          });
        });
      } catch (e) {
        console.warn('Posts fallback failed:', e.message);
      }
    }

    // Sort newest → oldest and cap to limit
    out.sort((a, b) => new Date(b.created_time || 0) - new Date(a.created_time || 0));
    const final = out.slice(0, limit);

    return resp(200, { data: final }, { 'Cache-Control': 'public, max-age=600' });
  } catch (e) {
    return resp(502, { error: String(e.message || e) });
  }
};

function resp(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  };
}
