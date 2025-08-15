function fmtDate(s){ try{ return new Date(s).toLocaleDateString(); }catch(_){return ''; } }

async function api(path){
  try{
    const res = await fetch(path);
    if(!res.ok) throw new Error(res.status);
    return await res.json();
  } catch(e){
    console.error('API fail', e);
    return {data:[]};
  }
}

async function renderHomepageSidebar(){
  const wrap = document.getElementById('fbSidebar');
  if(!wrap) return;
  wrap.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  const json = await api('/.netlify/functions/get-facebook-posts?limit=3');
  wrap.innerHTML='';
  if(!json.data || !json.data.length){
    wrap.innerHTML='<small class="muted">No recent updates.</small>';
    return;
  }
  json.data.forEach(p=>{
    const a=document.createElement('a');
    a.className='tile';
    a.href=p.permalink_url||'#';
    a.target='_blank';
    a.rel='noopener';
    a.innerHTML =
      (p.full_picture?`<img src="${p.full_picture}" alt="Post image">`:'') +
      `<div class="body"><div class="meta">${fmtDate(p.created_time)}</div><div>${(p.message||'').slice(0,140)}...</div></div>`;
    wrap.appendChild(a);
  });
}

async function renderNews(){
  // supports either #newsGrid (new) or #newsFeed (old)
  const grid = document.getElementById('newsGrid') || document.getElementById('newsFeed');
  if(!grid) return;
  grid.innerHTML='<div class="skeleton"></div>'.repeat(6);

  const json = await api('/.netlify/functions/get-facebook-posts?limit=12');
  grid.innerHTML='';
  if(!json.data || !json.data.length){
    grid.innerHTML='<p class="muted">No recent posts.</p>';
    return;
  }
  json.data.forEach(p=>{
    const el=document.createElement('article');
    el.className='news-card';
    const img=p.full_picture?`<img src="${p.full_picture}" alt="Post image" loading="lazy">`:'';
    const msg=(p.message||'').replace(/\n/g,'<br>');
    el.innerHTML =
      `${img}<div class="body"><div class="meta">${fmtDate(p.created_time)}</div><div>${msg}</div>
       <p><a class="btn" target="_blank" rel="noopener" href="${p.permalink_url}">View on Facebook</a></p></div>`;
    grid.appendChild(el);
  });
}

async function renderGallery(){
  const grid = document.getElementById('galleryGrid');
  if(!grid) return;
  grid.innerHTML = '<div class="skeleton"></div>'.repeat(9);

  let json = { data: [] };
  try {
    const res = await fetch('/.netlify/functions/get-facebook-photos?limit=30');
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

// kick everything once the DOM is ready
document.addEventListener('DOMContentLoaded', ()=>{
  try{ renderHomepageSidebar(); }catch(e){ console.error(e); }
  try{ renderNews(); }catch(e){ console.error(e); }
  try{ renderGallery(); }catch(e){ console.error(e); }
});
