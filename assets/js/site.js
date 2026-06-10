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
  const items=Array.isArray(json.items)&&json.items.length?json.items
    :Array.isArray(json.data)&&json.data.length?json.data
    :Array.isArray(json)&&json.length?json:null;
  if(!items) return [];
  return items.map(p=>{
    // Try every possible image field the FB API or our function might return
    const img=(p.image||p.full_picture||p.picture||extractImg(p)||'').trim();
    const validImg=(img&&img.startsWith('http')&&!img.includes('blank'))?img:'';
    const msg=(p.message||p.story||p.text||'').trim();
    const dateISO=p.date||p.createdISO||p.created_time||p.timestamp||'';
    const link=p.link||p.permalink_url||p.url||'#';
    return {message:msg,dateISO,link,image:validImg};
  }).filter(p=>p.message||p.image); // only show posts with content
}
function extractImg(p){
  try{
    // Try direct fields first
    if(p.full_picture) return p.full_picture;
    if(p.picture) return p.picture;
    const a=p.attachments&&p.attachments.data&&p.attachments.data[0];
    if(!a) return '';
    if(a.media&&a.media.image&&a.media.image.src) return a.media.image.src;
    if(a.media&&a.media.source) return a.media.source;
    if(a.image&&a.image.src) return a.image.src;
    if(a.subattachments&&Array.isArray(a.subattachments.data)){
      const s=a.subattachments.data.find(s=>s.media&&s.media.image&&s.media.image.src);
      if(s) return s.media.image.src;
      const s2=a.subattachments.data.find(s=>s.media&&s.media.source);
      if(s2) return s2.media.source;
    }
    if(a.target&&a.target.url&&a.target.url.match(/\.(jpg|jpeg|png|webp)/i)) return a.target.url;
    return '';
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
    if(indicatorText) indicatorText.textContent=biz
      ?'Shop open — Mon–Fri 8:00 AM–4:30 PM (showing business hour ETAs)'
      :'After hours — 24/7 emergency dispatch available (showing after-hour ETAs)';
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

  // Try Netlify function first
  let posts=[];
  try{
    const json=await api('/.netlify/functions/get-facebook-posts?limit=3');
    posts=normalizePosts(json);
  }catch(_){}

  // Fallback: try rss2json with public FB RSS feed
  if(!posts.length){
    try{
      const FB_PAGE='766439739884645';
      const feedUrl=`https://www.facebook.com/feeds/page.php?id=${FB_PAGE}&format=rss20`;
      const r=await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}&count=3`);
      if(r.ok){
        const d=await r.json();
        if(d.status==='ok'&&Array.isArray(d.items)&&d.items.length){
          posts=d.items.map(p=>({
            message:(p.title||p.description||'').replace(/<[^>]+>/g,'').trim().slice(0,200),
            dateISO:p.pubDate||'',
            link:p.link||'#',
            image:p.enclosure?.link||p.thumbnail||''
          })).filter(p=>p.message);
        }
      }
    }catch(_){}
  }

  wrap.innerHTML='';
  if(!posts.length){
    wrap.innerHTML='<div style="text-align:center;padding:16px 8px">'
      +'<svg width="32" height="32" fill="none" stroke="var(--muted)" stroke-width="1.5" viewBox="0 0 24 24" style="margin-bottom:8px;display:block;margin-left:auto;margin-right:auto"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>'
      +'<div style="font-size:.8rem;color:var(--muted);line-height:1.5">Connect Facebook in Netlify settings<br>to show live posts here.<br><a href="https://www.facebook.com/profile.php?id=766439739884645" target="_blank" rel="noopener" style="color:var(--brand)">Visit our page →</a></div>'
      +'</div>';
    return;
  }
  posts.forEach(p=>{
    const a=document.createElement('a');
    a.className='tile'; a.href=p.link||'#'; a.target='_blank'; a.rel='noopener';
    const msg=p.message||'';
    // Route FB CDN images through our proxy to avoid CORS / signed-URL expiry issues
    const rawImg=p.image||'';
    const postImg=rawImg&&rawImg.startsWith('http')
      ?`/.netlify/functions/fb-img-proxy?u=${encodeURIComponent(rawImg)}`
      :'/assets/img/fleet-wide.jpg';
    a.innerHTML=`<img src="${escA(postImg)}" alt="Facebook post" loading="lazy" style="width:100%;height:120px;object-fit:cover;border-radius:var(--radius-sm) var(--radius-sm) 0 0">`
      +`<div class="body"><div class="meta">${esc(fmtDate(p.dateISO))}</div><div>${esc(msg).slice(0,140)}${msg.length>140?'…':''}</div></div>`;
    const imgEl=a.querySelector('img');
    if(imgEl) imgEl.onerror=()=>{ imgEl.style.display='none'; };
    wrap.appendChild(a);
  });
}

/* ── Gallery (gallery.html) ─────────────────────────────────────── */
async function renderGallery(){
  const grid=document.getElementById('galleryGrid');
  const localGrid=document.getElementById('localGallery');
  if(!grid&&!localGrid) return;

  // Fetch FB photos and append to main gallery grid
  let photos=[];
  try{
    const r=await fetch('/.netlify/functions/get-facebook-photos?limit=30',{cache:'no-store'});
    if(!r.ok) throw new Error('FB photos unavailable');
    const json=await r.json();
    const raw=(json&&json.data)||[];
    photos=raw.map(ph=>{
      // Pick highest-res image available
      const src=(ph.images&&ph.images[0]&&ph.images[0].source)
        ||ph.full_picture||ph.source||ph.picture||'';
      return {src:src.trim(), caption:ph.name||ph.message||''};
    }).filter(p=>p.src&&!p.src.includes('blank')&&p.src.startsWith('http'));
  }catch(e){
    console.warn('FB gallery fetch failed:',e);
  }

  // Hide old separate FB section; we merge everything into localGallery
  const fbSection=document.getElementById('fbGallerySection');
  if(fbSection) fbSection.style.display='none';
  if(grid) grid.innerHTML='';

  if(!photos.length) return;

  // Add "Facebook" filter button if not already present
  const filterBar=document.querySelector('.gallery-filters');
  if(filterBar&&!filterBar.querySelector('[data-filter="facebook"]')){
    const btn=document.createElement('button');
    btn.className='gallery-filter';
    btn.dataset.filter='facebook';
    btn.textContent='Facebook';
    btn.onclick=()=>filterGallery('facebook',btn);
    filterBar.appendChild(btn);
  }

  // Dedup and inject into localGallery with data-category="facebook"
  const seen=new Set();
  const canon=u=>{ try{ const x=new URL(u); return x.origin+x.pathname; }catch{ return u.split('?')[0]; }};

  photos.forEach(ph=>{
    const key=canon(ph.src);
    if(seen.has(key)) return;
    seen.add(key);

    // Proxy the image URL through fb-img-proxy to avoid CORS/expiry
    const proxied=`/.netlify/functions/fb-img-proxy?u=${encodeURIComponent(ph.src)}`;

    const a=document.createElement('a');
    a.href=proxied;
    a.className='lightbox-trigger';
    a.dataset.src=proxied;
    a.dataset.caption=ph.caption||'From our Facebook page';
    a.dataset.category='facebook';
    a.setAttribute('aria-label',ph.caption||'View Facebook photo');

    const img=document.createElement('img');
    img.src=proxied;
    img.alt=ph.caption||'Atlantic Truck Facebook photo';
    img.loading='lazy';
    img.onerror=()=>{ a.remove(); };
    a.appendChild(img);
    if(localGrid) localGrid.appendChild(a);
  });

  // Re-init lightbox after dynamic load
  if(window._lbAttach) window._lbAttach();
  else initLightbox();
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
    const json=await api('/.netlify/functions/news?limit=30');
    all=(json&&(Array.isArray(json.items)?json.items:(Array.isArray(json.data)?json.data:[])));
    if(!all.length){ if(status) status.textContent='No articles found.'; return; }
    if(status) status.textContent='';
    shown=0; showMore(grid,btn);
    if(btn){ btn.style.display=shown<all.length?'':'none'; btn.onclick=()=>showMore(grid,btn); }
  }
  function showMore(grid,btn){
    all.slice(shown,shown+PAGE).forEach(a=>{
      const el=document.createElement('article');
      el.className='news-card';
      // Always render a placeholder thumb — we'll fill it via scraper if no image in RSS
      const img=a.image
        ?`<img class="news-thumb" src="${escA(a.image)}" alt="" loading="lazy">`
        :`<div class="news-thumb" style="background:var(--light);overflow:hidden"><img src="${FALLBACK_IMG}" alt="" style="width:100%;height:100%;object-fit:cover" data-scrape="${escA(a.link||'')}"></div>`;
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
    // Lazy-scrape images for cards that had none in the RSS feed
    scrapeNewsImages(grid);
  }

  // Throttled scraper: for any thumb still showing the fallback with data-scrape,
  // call news-image.js and swap in the real OG image.
  function scrapeNewsImages(grid){
    const pending=[...grid.querySelectorAll('img[data-scrape]')];
    let i=0;
    function next(){
      if(i>=pending.length) return;
      const imgEl=pending[i++];
      const articleUrl=imgEl.getAttribute('data-scrape');
      if(!articleUrl){next();return;}
      imgEl.removeAttribute('data-scrape'); // prevent double-scrape
      fetch(`/.netlify/functions/news-image?u=${encodeURIComponent(articleUrl)}`)
        .then(r=>r.ok?r.json():null)
        .then(d=>{
          if(d&&d.image&&d.image.startsWith('http')){
            imgEl.src=d.image;
            imgEl.onerror=()=>{ imgEl.src=FALLBACK_IMG; imgEl.onerror=null; };
            // Expand wrapper from div to a bare img
            const wrap=imgEl.parentElement;
            if(wrap&&wrap.tagName==='DIV'&&wrap.classList.contains('news-thumb')){
              imgEl.className='news-thumb';
              imgEl.style.cssText='';
              wrap.replaceWith(imgEl);
            }
          } else if(d&&d.logo&&d.logo.startsWith('http')){
            // Use source logo as fallback image
            imgEl.src=d.logo;
            imgEl.onerror=()=>{ imgEl.src=FALLBACK_IMG; imgEl.onerror=null; };
          }
          setTimeout(next,120); // throttle: 120ms between scrape calls
        })
        .catch(()=>setTimeout(next,120));
    }
    // Start with a small delay so page paint isn't blocked
    setTimeout(next,300);
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
      // Skip values with slashes (24/7), already-animated tallies, or non-numeric
      if(/\//.test(raw)||el.id==='unitsTally') return;
      const suffix=raw.replace(/[\d.,]/g,'');
      const num=parseFloat(raw.replace(/,/g,''));
      if(isNaN(num)||num>200) return;
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


/* ── FB connection diagnostic (runs once, logs to console only) ──── */
async function checkFBConnection(){
  try{
    const r=await fetch('/.netlify/functions/get-facebook-posts?debug=1&limit=1',{cache:'no-store'});
    const j=await r.json();
    if(j.error){
      console.warn('Facebook not connected:',j.error);
      if(j.hint) console.info('Hint:',j.hint);
    } else if(j.items&&j.items.length){
      console.info('Facebook connected ✓',j.items.length,'post(s) loaded');
    }
  }catch(e){
    console.warn('FB diagnostic failed:',e);
  }
}


/* ── Remember my details — localStorage form persistence ────────── */
function initRememberDetails(){
  const configs=[
    {
      checkId:'rememberSrv',
      fields:['name','phone','email','unit_number','make_model_year'],
      storageKey:'at-svc-details'
    },
    {
      checkId:'rememberPrt',
      fields:['name','phone','email','make_model_year'],
      storageKey:'at-parts-details'
    }
  ];
  configs.forEach(({checkId,fields,storageKey})=>{
    const cb=document.getElementById(checkId);
    if(!cb) return;
    // Restore saved values if checkbox was checked
    try{
      const saved=JSON.parse(localStorage.getItem(storageKey)||'null');
      if(saved){
        cb.checked=true;
        fields.forEach(f=>{
          const el=cb.closest('form').querySelector(`[name="${f}"]`);
          if(el&&saved[f]) el.value=saved[f];
        });
      }
    }catch(_){}
    // Save on checkbox change
    cb.addEventListener('change',()=>{
      if(!cb.checked){ localStorage.removeItem(storageKey); return; }
      const data={};
      fields.forEach(f=>{
        const el=cb.closest('form').querySelector(`[name="${f}"]`);
        if(el) data[f]=el.value;
      });
      try{ localStorage.setItem(storageKey,JSON.stringify(data)); }catch(_){}
    });
    // Update storage when form fields change (if checkbox is on)
    const form=cb.closest('form');
    if(form){
      fields.forEach(f=>{
        const el=form.querySelector(`[name="${f}"]`);
        if(!el) return;
        el.addEventListener('change',()=>{
          if(!cb.checked) return;
          try{
            const saved=JSON.parse(localStorage.getItem(storageKey)||'{}');
            saved[f]=el.value;
            localStorage.setItem(storageKey,JSON.stringify(saved));
          }catch(_){}
        });
      });
    }
  });
}

/* ── Mobile nav — drawer + accordion ───────────────────────────── */
function initMobileNav(){
  const toggle=document.getElementById('navToggle');
  const navList=document.getElementById('navList');
  const closeBtn=document.getElementById('navClose');
  if(!toggle||!navList) return;

  const BREAKPOINT=1280;

  function openDrawer(){
    navList.classList.add('open');
    toggle.classList.add('is-open');
    toggle.setAttribute('aria-expanded','true');
    document.body.style.overflow='hidden';
  }
  function closeDrawer(){
    navList.classList.remove('open');
    toggle.classList.remove('is-open');
    toggle.setAttribute('aria-expanded','false');
    document.body.style.overflow='';
  }

  toggle.addEventListener('click',e=>{
    e.stopPropagation();
    navList.classList.contains('open')?closeDrawer():openDrawer();
  });

  if(closeBtn) closeBtn.addEventListener('click',e=>{
    e.stopPropagation();
    closeDrawer();
  });

  // Close on backdrop tap
  document.addEventListener('click',e=>{
    if(navList.classList.contains('open')&&!navList.contains(e.target)){
      closeDrawer();
    }
  });

  // Close on Escape
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape') closeDrawer();
  });

  // Close drawer if window is resized to desktop width
  window.addEventListener('resize',()=>{
    if(window.innerWidth>BREAKPOINT) closeDrawer();
  },{passive:true});

  // Services accordion (mobile only)
  navList.querySelectorAll('.has-sub').forEach(li=>{
    const link=li.querySelector(':scope > a');
    if(!link) return;
    link.addEventListener('click',e=>{
      if(window.innerWidth>BREAKPOINT) return;
      e.preventDefault();
      const isOpen=li.classList.contains('sub-open');
      navList.querySelectorAll('.has-sub.sub-open').forEach(o=>o.classList.remove('sub-open'));
      if(!isOpen) li.classList.add('sub-open');
    });
  });

  // Auto-close drawer on any nav link tap
  navList.querySelectorAll('a:not(.nav-drawer-close)').forEach(a=>{
    a.addEventListener('click',()=>{
      if(window.innerWidth<=BREAKPOINT) closeDrawer();
    });
  });
}

/* ── Boot ───────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded',()=>{
  initMobileNav();
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
  initUnitsTally();
  animateUnitsTally();
  checkFBConnection();
  initRememberDetails();
});

/* ── Units Serviced auto-tally ──────────────────────────────────────
   Base: 5291 on June 5 2026 (Thursday). Each subsequent weekday
   adds 3-9 units — deterministic hash so number is consistent
   across all browsers and page loads for the same date.
──────────────────────────────────────────────────────────────────── */
function calcUnitsTally(){
  const BASE=5291;
  const BASE_Y=2026,BASE_M=5,BASE_D=5; // June 5 2026 (month is 0-indexed below)
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Halifax',
    year:'numeric',month:'2-digit',day:'2-digit'});
  const parts=fmt.formatToParts(new Date());
  let y=0,m=0,d=0;
  for(const p of parts){
    if(p.type==='year')   y=+p.value;
    if(p.type==='month')  m=+p.value;
    if(p.type==='day')    d=+p.value;
  }
  const today=new Date(y,m-1,d);
  const base=new Date(BASE_Y,BASE_M,BASE_D); // June = month 5 (0-indexed)
  let total=BASE;
  const cur=new Date(base);
  cur.setDate(cur.getDate()+1);
  while(cur<=today){
    const dow=cur.getDay();
    if(dow>=1&&dow<=5){
      const h=(cur.getFullYear()*366+cur.getMonth()*31+cur.getDate())%7;
      total+=3+h; // 3-9
    }
    cur.setDate(cur.getDate()+1);
  }
  return total;
}

function initUnitsTally(){
  const el=document.getElementById('unitsTally');
  if(!el) return;
  const target=calcUnitsTally();
  el.dataset.tallyTarget=target;
  el.textContent=target.toLocaleString();
}

function animateUnitsTally(){
  const el=document.getElementById('unitsTally');
  if(!el||!el.dataset.tallyTarget||!('IntersectionObserver' in window)) return;
  const target=parseInt(el.dataset.tallyTarget,10);
  const obs=new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      if(!e.isIntersecting) return;
      obs.unobserve(el);
      const range=Math.min(400,Math.floor(target*0.07));
      const start=target-range;
      let t0=null;
      const step=ts=>{
        if(!t0) t0=ts;
        const prog=Math.min((ts-t0)/1600,1);
        const ease=1-Math.pow(1-prog,3);
        el.textContent=Math.round(start+(target-start)*ease).toLocaleString();
        if(prog<1) requestAnimationFrame(step);
        else el.textContent=target.toLocaleString();
      };
      el.textContent=start.toLocaleString();
      requestAnimationFrame(step);
    });
  },{threshold:0.5});
  obs.observe(el);
}
