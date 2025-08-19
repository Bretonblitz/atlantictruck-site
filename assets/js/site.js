// assets/js/site.js

function fmtDate(s){
  try { return new Date(s).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }); }
  catch(_) { return ''; }
}

async function api(path){
  try{
    const res = await fetch(path, { cache: 'no-store' });
    if(!res.ok) throw new Error(res.status);
    return await res.json();
  } catch(e){
    console.error('API fail', e);
    // Return an empty shape that won't crash callers.
    return { items: [], data: [] };
  }
}

/* Normalize either:
   A) our Netlify function { items: [{ message, date, link, image, id }] }
   B) raw Graph API { data: [{ message, created_time, permalink_url, full_picture, ... }] }
   into a common shape { message, dateISO, link, image }
*/
function normalizePosts(json){
  if (!json) return [];
  if (Array.isArray(json.items) && json.items.length){
    return json.items.map(p => ({
      message: (p.message || '').trim(),
      dateISO: p.date || p.createdISO || '',
      link: p.link || '#',
      image: p.image || ''
    }));
  }
  if (Array.isArray(json.data) && json.data.length){
    return json.data.map(p => ({
      message: (p.message || p.story || '').trim(),
      dateISO: p.created_time || '',
      link: p.permalink_url || '#',
      image: p.full_picture || extractGraphAttachmentImage(p) || ''
    }));
  }
  return [];
}

function extractGraphAttachmentImage(p){
  try{
    const a = p.attachments && p.attachments.data && p.attachments.data[0];
    if (!a) return '';
    if (a.media && a.media.image && a.media.image.src) return a.media.image.src;
    if (a.subattachments && Array.isArray(a.subattachments.data)){
      const sub = a.subattachments.data.find(s => s.media && s.media.image && s.media.image.src);
      if (sub) return sub.media.image.src;
    }
    if (a.target && a.target.url) return a.target.url;
    if (a.url) return a.url;
  }catch(_){}
  return '';
}

function escHTML(s){ return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escAttr(s){ return escHTML(String(s||'')).replace(/"/g, '&quot;'); }

/* ------------------ Facebook sidebar (home page) ------------------ */
async function renderHomepageSidebar(){
  const wrap = document.getElementById('fbSidebar');
  if(!wrap) return;

  // small skeleton
  wrap.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';

  // IMPORTANT: must match your function filename. We prefer the new one;
  // if you keep a legacy alias, you can add a fallback here.
  let json = await api('/.netlify/functions/get-facebook-posts?limit=3');

  let posts = normalizePosts(json);
  if (!posts.length){
    // fallback to old name if someone renamed the function
    try {
      json = await api('/.netlify/functions/fb-posts?limit=3');
      posts = normalizePosts(json);
    } catch(_) {}
  }

  wrap.innerHTML = '';
  if(!posts.length){
    wrap.innerHTML = '<small class="muted">No recent updates.</small>';
    return;
  }

  posts.forEach(p=>{
    const a = document.createElement('a');
    a.className = 'tile';
    a.href = p.link || '#';
    a.target = '_blank';
    a.rel = 'noopener';

    const msg = p.message || '';
    const dateTxt = fmtDate(p.dateISO || Date.now());

    a.innerHTML =
      (p.image ? `<img src="${escAttr(p.image)}" alt="Post image" loading="lazy">` : '') +
      `<div class="body">
         <div class="meta">${escHTML(dateTxt)}</div>
         <div>${escHTML(msg).slice(0,140)}${msg.length>140?'…':''}</div>
       </div>`;

    const imgEl = a.querySelector('img');
    if (imgEl) imgEl.onerror = () => { imgEl.remove(); };
    wrap.appendChild(a);
  });
}

/* ------------------ Legacy News (ONLY if #newsFeed exists) ------------------ */
async function renderNews(){
  // supports the legacy container #newsFeed (the new News page owns #newsGrid separately)
  const grid = document.getElementById('newsFeed');
  if(!grid) return;

  grid.innerHTML = '<div class="skeleton"></div>'.repeat(6);

  let json = await api('/.netlify/functions/get-facebook-posts?limit=12');
  let posts = normalizePosts(json);

  if (!posts.length){
    // fallback to old function name if needed
    try {
      json = await api('/.netlify/functions/fb-posts?limit=12');
      posts = normalizePosts(json);
    } catch(_) {}
  }

  grid.innerHTML = '';
  if(!posts.length){
    grid.innerHTML = '<p class="muted">No recent posts.</p>';
    return;
  }

  posts.forEach(p=>{
    const el = document.createElement('article');
    el.className = 'news-card';
    const img = p.image ? `<img class="news-thumb" src="${escAttr(p.image)}" alt="Post image" loading="lazy">` : '';
    const msg = (p.message || '').replace(/\n/g,'<br>');

    el.innerHTML =
      `${img}
       <div class="body">
         <div class="meta">${escHTML(fmtDate(p.dateISO))}</div>
         <div>${msg || '<span class="muted">Photo update</span>'}</div>
         <p style="margin-top:8px">
           <a class="btn" target="_blank" rel="noopener" href="${escAttr(p.link || '#')}">View on Facebook</a>
         </p>
       </div>`;

    const imgEl = el.querySelector('img');
    if (imgEl) imgEl.onerror = () => { imgEl.remove(); };
    grid.appendChild(el);
  });
}

/* ------------------ Gallery (photos) ------------------ */
async function renderGallery(){
  const grid = document.getElementById('galleryGrid');
  if(!grid) return;
  grid.innerHTML = '<div class="skeleton"></div>'.repeat(9);

  let json = { data: [] };
  try {
    // keep as-is; your photos function returns a Graph-like { data: [...] }
    const res = await fetch('/.netlify/functions/get-facebook-photos?limit=30', { cache: 'no-store' });
    json = await res.json();
  } catch(e) {
    console.error('gallery fetch error', e);
  }

  grid.innerHTML = '';
  if (!json.data || !json.data.length) {
    grid.innerHTML = '<p class="muted">No recent photos.</p>';
    return;
  }

  const seen = new Set();
  const canon = (u) => {
    try { const x = new URL(u); return `${x.origin}${x.pathname}`.toLowerCase(); }
    catch { return (u || '').split('?')[0].toLowerCase(); }
  };

  json.data.forEach(ph => {
    const src = (ph.images?.[0]?.source) || ph.full_picture || ph.source;
    if (!src) return;
    const key = canon(src);
    if (seen.has(key)) return; // de-dup in UI
    seen.add(key);

    const a = document.createElement('a');
    a.href = ph.permalink_url || src;
    a.target = '_blank'; a.rel = 'noopener';
    const img = document.createElement('img');
    img.src = src; img.alt = ph.name || 'Photo';
    a.appendChild(img);
    grid.appendChild(a);
  });
}

/* ------------------ boot ------------------ */
document.addEventListener('DOMContentLoaded', ()=>{
  try{ renderHomepageSidebar(); }catch(e){ console.error(e); }
  try{ renderNews(); }catch(e){ console.error(e); }
  try{ renderGallery(); }catch(e){ console.error(e); }
});
