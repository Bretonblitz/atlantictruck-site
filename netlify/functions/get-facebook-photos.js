const API = 'https://graph.facebook.com/v19.0/';
exports.handler = async function(event, context) {
  const pageId = process.env.FB_PAGE_ID || "61579126693357";
  const token = process.env.FB_ACCESS_TOKEN;
  const limit = Math.max(1, Math.min(50, parseInt((event.queryStringParameters && event.queryStringParameters.limit) || '30')));
  if(!token) return { statusCode: 500, body: JSON.stringify({ error: 'Missing FB_ACCESS_TOKEN' }) };
  const fields = 'id,permalink_url,created_time,name,images,full_picture,link';
  const url = `${API}${pageId}/photos?type=uploaded&fields=${fields}&limit=${limit}&access_token=${encodeURIComponent(token)}`;
  try { const resp = await fetch(url); const data = await resp.json();
    return { statusCode: resp.status, headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=600'}, body: JSON.stringify(data) };
  } catch(e) { return { statusCode:500, body: JSON.stringify({ error: e.message }) }; }
};