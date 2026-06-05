/* ================================================================
   ATLANTIC TRUCK & EQUIPMENT REPAIR — site.js
   Full rewrite June 2026. All logic consolidated here.
   ================================================================ */

/* ── Utilities ──────────────────────────────────────────────────── */
function fmtDate(s){
  try { return new Date(s).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}); }
  catch(_){ return ''; }
}
async function api(path){
  try{
    const r = await fetch(path,{cache:'no-store'});
    if(!r.ok) throw new Error(r.status);
    return await r.json();
  }catch(e){ console.error('API',e); return {items:[],data:[]}; }
}
function normalizePosts(json){
  if(!json) return [];
  if(Array.isArray(json.items)&&json.items.length)
    return json.items.map(p=>({message:(p.message||'').trim(),dateISO:p.date||p.createdISO||'',link:p.link||'#',image:p.image||''}));
  if(Array.isArray(json.data)&&json.data.length)
    return json.data.map(p=>({message:(p.message||p.story||'').trim(),dateISO:p.created_time||'',link:p.permalink_url||'#',image:p.full_picture||extractImg(p)||''}));
  return [];
}
function extractImg(p){
  try{
    const a=p.attachments&&p.attachments.data&&p.attachments.data[0];
    if(!a) return '';
    if(a.media&&a.media.image&&a.media.image.src) return a.media.image.src;
    if(a.subattachments&&Array.isArray(a.subattachments.data)){
      const s=a.subattachments.data.find(s=>s.media&&s.media.image&&s.media.image.src);
      if(s) return s.media.image.src;
    }
    return a.target&&a.target.url||a.url||'';
  }catch(_){ return ''; }
}
function esc(s){ return (s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escA(s){ return esc(String(s||'')).replace(/"/g,'&quot;'); }
const FALLBACK_IMG = '/assets/img/hero-rotator.jpg';

/* ── Halifax time helpers (shared by smartCta + ETA) ────────────── */
function halifaxParts(){
  const f=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Halifax',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const parts=f.formatToParts(new Date());
  let wd='Mon',h=0,m=0;
  for(const p of parts){
    if(p.type==='weekday') wd=p.value;
    if(p.type==='hour')    h=parseInt(p.value,10);
    if(p.type==='minute')  m=parseInt(p.value,10);
  }
  return {wd,h,m,label:f.format(new Date())};
}
function inBizHours(){
  const {wd,h,m}=halifaxParts();
  if(wd==='Sat'||wd==='Sun') return false;
  if(h<8||h>16||(h===16&&m>30)) return false;
  return true;
}

/* ── Smart CTA ──────────────────────────────────────────────────── */
function updateSmartCta(){
  const el=document.getElementById('smartCta');
  if(!el) return;
  if(inBizHours()){
    el.textContent='Book Service';
    el.href='/requests.html#service';
    el.setAttribute('aria-label','Book service online');
  } else {
    el.textContent='Call 902-539-4574';
    el.href='tel:9025394574';
    el.setAttribute('aria-label','Call service line');
  }
}

/* ── ETA table (service-area.html) ──────────────────────────────── */
function initETA(){
  const indicator=document.getElementById('etaIndicator');
  const indicatorText=document.getElementById('etaIndicatorText');
  const clock=document.getElementById('etaClock');
  const tbody=document.querySelector('#etaTable tbody');
  if(!indicator||!tbody) return;
  const BASE={'Sydney':35,'North Sydney':40,'Sydney Mines':45,'Glace Bay':55,'New Waterford':60,'Eskasoni':60,'Baddeck':70,'Port Hawkesbury':115,'Antigonish':145};
  function ceil15(n){ return Math.ceil(n/15)*15; }
  function fmt(m){ const H=Math.floor(m/60),M=m%60; return H===0?`${M} min`:M===0?`${H} hr`:`${H} hr ${M} min`; }
  function render(){
    const hal=halifaxParts();
    const biz=inBizHours();
    indicator.classList.toggle('on',biz);
    indicator.classList.toggle('off',!biz);
    if(indicatorText) indicatorText.textContent=biz?'Quoting Business Hours response times':'Quoting After Hours response times';
    if(clock) clock.textContent=`Time now in Cape Breton, Nova Scotia: ${hal.label}`;
    tbody.innerHTML='';
    Object.entries(BASE).forEach(([place,base])=>{
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${place}</td><td><strong>~${fmt(ceil15(base+(biz?15:30)))}</strong></td>`;
      tbody.appendChild(tr);
    });
  }
  render();
  setInterval(render,60000);
}

/* ── Traffic advisories (traffic.html) ──────────────────────────── */
async function initTraffic(){
  const grid=document.getElementById('grid');
  const status=document.getElementById('status');
  if(!grid) return;
  if(status) status.textContent='Loading advisories…';
  try{
    const r=await fetch('/.netlify/functions/traffic',{cache:'no-store'});
    if(!r.ok) throw new Error('unavailable');
    const data=await r.json();
    if(!data||!Array.isArray(data.items)||!data.items.length) throw new Error('empty');
    status&&(status.textContent='');
    const frag=document.createDocumentFragment();
    data.items.forEach(a=>{
      const el=document.createElement('article');
      el.className='news-card';
      const date=fmtDate(a.date||Date.now());
      el.innerHTML=`<a href="${escA(a.link)}" target="_blank" rel="noopener"><img class="news-thumb" src="${escA(a.image||FALLBACK_IMG)}" alt="" loading="lazy"></a>
        <div class="news-body">
          <div class="news-meta"><span class="chip">Traffic advisory</span><span>${esc(date)}</span></div>
          <h3 class="news-title"><a href="${escA(a.link)}" target="_blank" rel="noopener">${esc(a.title||'Advisory')}</a></h3>
          ${a.summary?`<p class="news-summary">${esc(a.summary)}</p>`:''}
          <div class="news-actions"><a href="${escA(a.link)}" target="_blank" rel="noopener" style="font-size:.8rem;font-weight:600;color:var(--brand)">Open →</a></div>
        </div>`;
      const img=el.querySelector('img');
      if(img) img.onerror=()=>{ img.src=FALLBACK_IMG; img.onerror=null; };
      frag.appendChild(el);
    });
    grid.innerHTML='';
    grid.appendChild(frag);
  }catch(e){
    if(status) status.textContent='Could not load traffic advisories right now.';
  }
}

/* ── Facebook sidebar (homepage) ────────────────────────────────── */
async function renderHomepageSidebar(){
  const wrap=document.getElementById('fbSidebar');
  if(!wrap) return;
  wrap.innerHTML='<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  let json=await api('/.netlify/functions/get-facebook-posts?limit=3');
  let posts=normalizePosts(json);
  if(!posts.length){
    try{ json=await api('/.netlify/functions/fb-posts?limit=3'); posts=normalizePosts(json); }catch(_){}
  }
  wrap.innerHTML='';
  if(!posts.length){ wrap.innerHTML='<small class="muted">No recent updates.</small>'; return; }
  posts.forEach(p=>{
    const a=document.createElement('a');
    a.className='tile'; a.href=p.link||'#'; a.target='_blank'; a.rel='noopener';
    const msg=p.message||'';
    a.innerHTML=(p.image?`<img src="${escA(p.image)}" alt="Post image" loading="lazy">`:'')
      +`<div class="body"><div class="meta">${esc(fmtDate(p.dateISO))}</div><div>${esc(msg).slice(0,140)}${msg.length>140?'…':''}</div></div>`;
    const imgEl=a.querySelector('img');
    if(imgEl) imgEl.onerror=()=>{ imgEl.remove(); };
    wrap.appendChild(a);
  });
}

/* ── Gallery (gallery.html) ─────────────────────────────────────── */
async function renderGallery(){
  const grid=document.getElementById('galleryGrid');
  if(!grid) return;
  grid.innerHTML='<div class="skeleton"></div>'.repeat(9);
  let json={data:[]};
  try{
    const r=await fetch('/.netlify/functions/get-facebook-photos?limit=30',{cache:'no-store'});
    json=await r.json();
  }catch(e){ console.error('gallery',e); }
  grid.innerHTML='';
  if(!json.data||!json.data.length){ grid.innerHTML='<p class="muted">No recent photos.</p>'; return; }
  const seen=new Set();
  const canon=u=>{ try{ const x=new URL(u); return `${x.origin}${x.pathname}`.toLowerCase(); }catch{ return (u||'').split('?')[0].toLowerCase(); }};
  json.data.forEach(ph=>{
    const src=(ph.images?.[0]?.source)||ph.full_picture||ph.source;
    if(!src) return;
    const key=canon(src);
    if(seen.has(key)) return;
    seen.add(key);
    const a=document.createElement('a');
    a.href=src; a.className='lightbox-trigger'; a.dataset.src=src;
    a.dataset.caption=ph.name||'';
    a.setAttribute('aria-label','View full photo');
    const img=document.createElement('img');
    img.src=src; img.alt=ph.name||'Fleet photo'; img.loading='lazy';
    a.appendChild(img);
    grid.appendChild(a);
  });
  // Re-init lightbox for dynamic items
  initLightbox();
}

/* ── News page (news.html) ──────────────────────────────────────── */
(function(){
  const PAGE=9; let all=[],shown=0;
  async function init(){
    const grid=document.getElementById('newsGrid');
    const status=document.getElementById('newsStatus');
    const btn=document.getElementById('loadMoreBtn');
    if(!grid) return;
    if(status) status.textContent='Loading…';
    const json=await api('/.netlify/functions/get-truck-news?limit=30');
    all=(json&&Array.isArray(json.items))?json.items:[];
    if(!all.length){ if(status) status.textContent='No articles found.'; return; }
    if(status) status.textContent='';
    shown=0; showMore(grid,btn);
    if(btn){ btn.style.display=shown<all.length?'':'none'; btn.onclick=()=>showMore(grid,btn); }
  }
  function showMore(grid,btn){
    all.slice(shown,shown+PAGE).forEach(a=>{
      const el=document.createElement('article');
      el.className='news-card';
      const img=a.image?`<img class="news-thumb" src="${escA(a.image)}" alt="" loading="lazy">`
        :`<div class="news-thumb" style="background:var(--light);overflow:hidden"><img src="${FALLBACK_IMG}" alt="" style="width:100%;height:100%;object-fit:cover"></div>`;
      el.innerHTML=`${img}<div class="news-body">
        <div class="news-meta"><span class="chip">${esc(a.source||'News')}</span>${a.date?`<span>${esc(fmtDate(a.date))}</span>`:''}</div>
        <h3 class="news-title"><a href="${escA(a.link||'#')}" target="_blank" rel="noopener">${esc(a.title||'')}</a></h3>
        ${a.summary?`<p class="news-summary">${esc(a.summary.slice(0,180))}…</p>`:''}
        <div class="news-actions"><a href="${escA(a.link||'#')}" target="_blank" rel="noopener" style="font-size:.8rem;font-weight:600;color:var(--brand)">Read more →</a></div>
      </div>`;
      const imgEl=el.querySelector('.news-thumb img');
      if(imgEl&&a.image) imgEl.onerror=()=>{ imgEl.src=FALLBACK_IMG; };
      grid.appendChild(el);
    });
    shown+=Math.min(PAGE,all.length-shown);
    if(btn) btn.style.display=shown<all.length?'':'none';
  }
  document.addEventListener('DOMContentLoaded',()=>{ if(document.getElementById('newsGrid')) init(); });
})();

/* ── Lightbox ───────────────────────────────────────────────────── */
function initLightbox(){
  if(document.getElementById('lb-overlay')) return; // already built

  const overlay=document.createElement('div');
  overlay.id='lb-overlay';
  overlay.setAttribute('role','dialog');
  overlay.setAttribute('aria-modal','true');
  overlay.setAttribute('aria-label','Photo viewer');
  overlay.innerHTML=`
    <button id="lb-close" aria-label="Close photo viewer">✕</button>
    <button id="lb-prev" aria-label="Previous photo">‹</button>
    <button id="lb-next" aria-label="Next photo">›</button>
    <div id="lb-inner">
      <img id="lb-img" src="" alt="">
      <div id="lb-caption"></div>
    </div>`;
  document.body.appendChild(overlay);

  let items=[], idx=0;

  function open(i){
    idx=i;
    const it=items[idx];
    const img=document.getElementById('lb-img');
    img.src=it.src;
    document.getElementById('lb-caption').textContent=it.caption||'';
    overlay.classList.add('open');
    document.body.style.overflow='hidden';
    document.getElementById('lb-prev').style.display=items.length>1?'':'none';
    document.getElementById('lb-next').style.display=items.length>1?'':'none';
  }
  function close(){ overlay.classList.remove('open'); document.body.style.overflow=''; }
  function prev(){ idx=(idx-1+items.length)%items.length; open(idx); }
  function next(){ idx=(idx+1)%items.length; open(idx); }

  document.getElementById('lb-close').onclick=close;
  document.getElementById('lb-prev').onclick=e=>{ e.stopPropagation(); prev(); };
  document.getElementById('lb-next').onclick=e=>{ e.stopPropagation(); next(); };
  overlay.onclick=e=>{ if(e.target===overlay) close(); };
  document.addEventListener('keydown',e=>{
    if(!overlay.classList.contains('open')) return;
    if(e.key==='Escape') close();
    if(e.key==='ArrowLeft') prev();
    if(e.key==='ArrowRight') next();
  });

  // Attach to all .lightbox-trigger elements
  function attach(){
    const triggers=[...document.querySelectorAll('.lightbox-trigger')];
    items=triggers.map(a=>({src:a.dataset.src||a.href,caption:a.dataset.caption||''}));
    triggers.forEach((a,i)=>{
      a.onclick=e=>{ e.preventDefault(); open(i); };
    });
  }
  attach();
  // expose so renderGallery can re-attach after dynamic load
  window._lbAttach=attach;
}

/* ── Scroll animations ──────────────────────────────────────────── */
function initScrollAnimations(){
  if(!('IntersectionObserver' in window)) return;
  const targets=document.querySelectorAll('.tile,.step,.testimonial,.staff-card,.cert-badge,.stat-item');
  const obs=new IntersectionObserver((entries)=>{
    entries.forEach(e=>{
      if(e.isIntersecting){
        e.target.style.opacity='1';
        e.target.style.transform='translateY(0)';
        obs.unobserve(e.target);
      }
    });
  },{threshold:0.12,rootMargin:'0px 0px -40px 0px'});
  targets.forEach((t,i)=>{
    t.style.opacity='0';
    t.style.transform='translateY(20px)';
    t.style.transition=`opacity .45s ease ${(i%4)*0.07}s, transform .45s ease ${(i%4)*0.07}s`;
    obs.observe(t);
  });
}

/* ── Stat counter animation ─────────────────────────────────────── */
function initStatCounters(){
  if(!('IntersectionObserver' in window)) return;
  const stats=document.querySelectorAll('.stat-num');
  if(!stats.length) return;
  const obs=new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      if(!e.isIntersecting) return;
      obs.unobserve(e.target);
      const el=e.target;
      const raw=el.textContent.trim();
      const suffix=raw.replace(/[\d.]/g,'');  // '+', 'hr', '/7' etc.
      const num=parseFloat(raw);
      if(isNaN(num)||num>100) return; // skip "24/7" and large numbers
      let start=0;
      const dur=1200;
      const step=ts=>{
        if(!start) start=ts;
        const progress=Math.min((ts-start)/dur,1);
        const ease=1-Math.pow(1-progress,3);
        el.textContent=Math.round(ease*num)+suffix;
        if(progress<1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  },{threshold:0.5});
  stats.forEach(s=>obs.observe(s));
}

/* ── Request form tabs ──────────────────────────────────────────── */
function initRequestTabs(){
  const serviceDiv=document.getElementById('service');
  const partsDiv=document.getElementById('parts');
  const tabBar=document.getElementById('requestTabBar');
  if(!serviceDiv||!partsDiv||!tabBar) return;
  const tabs=tabBar.querySelectorAll('[data-tab]');
  function activate(name){
    serviceDiv.style.display=name==='service'?'':'none';
    partsDiv.style.display=name==='parts'?'':'none';
    tabs.forEach(t=>{
      const active=t.dataset.tab===name;
      t.style.background=active?'var(--brand)':'transparent';
      t.style.color=active?'#fff':'var(--text)';
      t.style.borderColor=active?'var(--brand)':'var(--border)';
    });
  }
  tabs.forEach(t=>t.onclick=()=>activate(t.dataset.tab));
  // Activate based on URL hash
  activate(location.hash==='#parts'?'parts':'service');
  window.onhashchange=()=>activate(location.hash==='#parts'?'parts':'service');
}

/* ── Print stylesheet logic ─────────────────────────────────────── */
// Handled in CSS @media print block

/* ── Boot ───────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded',()=>{
  updateSmartCta();
  setInterval(updateSmartCta,60000);
  initETA();
  initTraffic();
  renderHomepageSidebar();
  renderGallery();
  initLightbox();
  initScrollAnimations();
  initStatCounters();
  initRequestTabs();
});
