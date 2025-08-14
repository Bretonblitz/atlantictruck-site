
function fmtDate(s){ try{ return new Date(s).toLocaleDateString(); }catch(_){return ''; } }

async function api(path){
  try{ const res = await fetch(path); if(!res.ok) throw new Error(res.status); return await res.json(); }
  catch(e){ console.error('API fail', e); return {data:[]}; }
}

async function renderHomepageSidebar(){
  const wrap = document.getElementById('fbSidebar');
  if(!wrap) return;
  wrap.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  const json = await api('/.netlify/functions/get-facebook-posts?limit=3');
  wrap.innerHTML='';
  if(!json.data||!json.data.length){ wrap.innerHTML='<small class="muted">No recent updates.</small>'; return; }
  json.data.forEach(p=>{
    const a=document.createElement('a'); a.className='tile'; a.href=p.permalink_url||'#'; a.target='_blank'; a.rel='noopener';
    a.innerHTML = (p.full_picture?`<img src="${p.full_picture}" alt="Post image">`:'')+`<div class="body"><div class="meta">${fmtDate(p.created_time)}</div><div>${(p.message||'').slice(0,140)}...</div></div>`;
    wrap.appendChild(a);
  });
}

async function renderNews(){
  const grid=document.getElementById('newsGrid'); if(!grid) return;
  grid.innerHTML='<div class="skeleton"></div>'.repeat(6);
  const json=await api('/.netlify/functions/get-facebook-posts?limit=12'); grid.innerHTML='';
  if(!json.data||!json.data.length){ grid.innerHTML='<p class="muted">No recent posts.</p>'; return; }
  json.data.forEach(p=>{
    const el=document.createElement('article'); el.className='news-card';
    const img=p.full_picture?`<img src="${p.full_picture}" alt="Post image">`:'';
    const msg=(p.message||'').replace(/\n/g,'<br>');
    el.innerHTML = `${img}<div class="body"><div class="meta">${fmtDate(p.created_time)}</div><div>${msg}</div></div>`;
    grid.appendChild(el);
  });
}

async function renderGallery(){
  const grid=document.getElementById('galleryGrid'); if(!grid) return;
  grid.innerHTML='<div class="skeleton"></div>'.repeat(9);
  const json=await api('/.netlify/functions/get-facebook-photos?limit=30'); grid.innerHTML='';
  if(!json.data||!json.data.length){ grid.innerHTML='<p class="muted">No recent photos.</p>'; return; }
  json.data.forEach(ph=>{
    const src=(ph.images && ph.images.length)?ph.images[0].source:ph.full_picture||ph.source;
    if(!src) return;
    const a=document.createElement('a'); a.href=ph.permalink_url||ph.link||src; a.target='_blank'; a.rel='noopener';
    const img=document.createElement('img'); img.src=src; img.alt=ph.name||'Photo';
    a.appendChild(img); grid.appendChild(a);
  });
}

document.addEventListener('DOMContentLoaded', ()=>{ renderHomepageSidebar(); renderNews(); renderGallery(); });
