// netlify/functions/get-facebook-posts.js
// Fetch recent Facebook Page posts with debug + env alias support.
//
// Env (set in Netlify → Site settings → Build & deploy → Environment):
//   FB_PAGE_ID = <your page id, e.g. 61579126693357>
//   FB_PAGE_ACCESS_TOKEN = <your Page Access Token>
// Optional:
//   FB_GRAPH_VERSION = v20.0
//   FB_POSTS_LIMIT   = 10
//   FB_APP_ID        = <app id>              // enables token debug + appsecret_proof
//   FB_APP_SECRET    = <app secret>
//
// Endpoint:
//   /.netlify/functions/get-facebook-posts
// Debug:
//   /.netlify/functions/get-facebook-posts?debug=1
// Force edge: ?source=posts (fallback to /posts instead of /published_posts)
// Limit override: ?limit=5

export default async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=120, s-maxage=300'
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers });

  try {
    const url = new URL(req.url);
    const DEBUG = (url.searchParams.get('debug') || '0').toLowerCase() === '1';
    const source = (url.searchParams.get('source') || 'published').toLowerCase(); // 'published' | 'posts'
    const limitQ = url.searchParams.get('limit');

    // --- Accept multiple alias names to avoid name mismatch issues ---
    const PAGE_ID =
      process.env.FB_PAGE_ID ||
      process.env.FB_PAGEID ||            // alias
      process.env.FACEBOOK_PAGE_ID ||     // alias
      '';

    const PAGE_TOKEN =
      process.env.FB_PAGE_ACCESS_TOKEN ||
      process.env.FB_ACCESS_TOKEN ||      // alias
      process.env.FB_PAGE_TOKEN ||        // alias
      process.env.FACEBOOK_PAGE_TOKEN ||  // alias
      '';

    const GRAPH_VER = process.env.FB_GRAPH_VERSION || 'v20.0';
    const LIMIT = Number(limitQ || process.env.FB_POSTS_LIMIT || 10);

    const APP_ID = process.env.FB_APP_ID || '';
    const APP_SECRET = process.env.FB_APP_SECRET || '';

    // --- DEBUG: show which env vars are visible (names only, not values) ---
    const fbEnvPresence = {
      FB_PAGE_ID: !!process.env.FB_PAGE_ID,
      FB_PAGEID: !!process.env.FB_PAGEID,
      FACEBOOK_PAGE_ID: !!process.env.FACEBOOK_PAGE_ID,
      FB_PAGE_ACCESS_TOKEN: !!process.env.FB_PAGE_ACCESS_TOKEN,
      FB_ACCESS_TOKEN: !!process.env.FB_ACCESS_TOKEN,
      FB_PAGE_TOKEN: !!process.env.FB_PAGE_TOKEN,
      FACEBOOK_PAGE_TOKEN: !!process.env.FACEBOOK_PAGE_TOKEN,
      FB_GRAPH_VERSION: !!process.env.FB_GRAPH_VERSION,
      FB_POSTS_LIMIT: !!process.env.FB_POSTS_LIMIT,
      FB_APP_ID: !!process.env.FB_APP_ID,
      FB_APP_SECRET: !!process.env.FB_APP_SECRET
    };

    if (!PAGE_ID || !PAGE_TOKEN) {
      return json({
        error: 'Missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN in env.',
        hint: 'Check exact names + redeploy after adding env vars.',
        ...(DEBUG ? { debug: { fbEnvPresence } } : {})
      }, 500, headers);
    }

    const edge = source === 'posts' ? 'posts' : 'published_posts';
    const fields = [
      'id',
      'message',
      'story',
      'created_time',
      'permalink_url',
      'full_picture',
      'attachments{media_type,description,media,target,url,subattachments}'
    ].join(',');

    const g = new URL(`https://graph.facebook.com/${GRAPH_VER}/${encodeURIComponent(PAGE_ID)}/${edge}`);
    g.searchParams.set('fields', fields);
    g.searchParams.set('limit', String(LIMIT));
    g.searchParams.set('access_token', PAGE_TOKEN);

    // appsecret_proof if available
    if (APP_SECRET) {
      const proof = await hmacSha256Hex(PAGE_TOKEN, APP_SECRET);
      if (proof) g.searchParams.set('appsecret_proof', proof);
    }

    const t0 = Date.now();
    const res = await fetch(g, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (AtlanticTruckFB/1.0)',
        'Accept': 'application/json'
      }
    });
    const raw = await res.json().catch(() => ({}));
    const tookMs = Date.now() - t0;

    if (!res.ok) {
      return json({
        error: 'Facebook API error',
        status: res.status,
        details: redactFbError(raw),
        ...(DEBUG ? { debug: { tookMs, endpoint: redactURL(g), fbEnvPresence } } : {})
      }, res.status, headers);
    }

    const data = Array.isArray(raw.data) ? raw.data : [];
    const items = data.map(mapFBPost).filter(Boolean);

    const body = { items };
    if (DEBUG) {
      body.debug = {
        tookMs,
        count: items.length,
        endpoint: redactURL(g),
        fbEnvPresence,
        paging: raw.paging ? Object.keys(raw.paging) : [],
        token: (APP_ID && APP_SECRET) ? await debugToken(PAGE_TOKEN, APP_ID, APP_SECRET, GRAPH_VER) : undefined
      };
    }

    return json(body, 200, headers);
  } catch (err) {
    return json({ error: 'Server error', details: String(err) }, 500, headers);
  }
};

// ---------- helpers ----------
function mapFBPost(p) {
  const message = (p.message || p.story || '').trim();
  const created = new Date(p.created_time || Date.now());
  const link = p.permalink_url || '#';
  const img = extractImage(p);
  if (!message && !img) return null;
  return { id: p.id, message, date: created.toISOString(), link, image: img || '' };
}

function extractImage(p) {
  if (p.full_picture) return p.full_picture;
  const a = p.attachments && p.attachments.data && p.attachments.data[0];
  if (a) {
    if (a.media && a.media.image && a.media.image.src) return a.media.image.src;
    if (a.subattachments && Array.isArray(a.subattachments.data)) {
      const sub = a.subattachments.data.find(s => s.media && s.media.image && s.media.image.src);
      if (sub && sub.media && sub.media.image) return sub.media.image.src;
    }
    if (a.target && a.target.url) return a.target.url;
    if (a.url) return a.url;
  }
  return '';
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function redactURL(u) {
  const copy = new URL(u.toString());
  if (copy.searchParams.has('access_token')) copy.searchParams.set('access_token', '***');
  if (copy.searchParams.has('appsecret_proof')) copy.searchParams.set('appsecret_proof', '***');
  return copy.toString();
}

function redactFbError(err) {
  try {
    const e = JSON.parse(JSON.stringify(err || {}));
    if (e.error && e.error.message) {
      e.error.message = String(e.error.message).replace(/access_token=[^&\s]+/g, 'access_token=***');
    }
    return e;
  } catch {
    return { error: String(err) };
  }
}

// HMAC-SHA256(token, secret) → hex
async function hmacSha256Hex(token, secret) {
  if (globalThis.crypto && globalThis.crypto.subtle) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(token));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  try {
    const { createHmac } = await import('node:crypto');
    return createHmac('sha256', secret).update(token).digest('hex');
  } catch {
    return '';
  }
}

async function debugToken(pageToken, appId, appSecret, ver = 'v20.0') {
  try {
    const u = new URL(`https://graph.facebook.com/${ver}/debug_token`);
    u.searchParams.set('input_token', pageToken);
    u.searchParams.set('access_token', `${appId}|${appSecret}`);
    const r = await fetch(u);
    const j = await r.json();
    if (!j || !j.data) return { ok: false };
    const d = j.data;
    return {
      ok: !!d.is_valid,
      type: d.type,
      app_id: d.app_id,
      expires_at: d.expires_at || null,
      scopes: d.scopes || []
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
