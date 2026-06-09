// netlify/functions/news-image.js — v2
export default async (req, context) => {
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json','Cache-Control':'public, max-age=86400'};
  if(req.method==='OPTIONS') return new Response('',{status:204,headers:h});
  const u=(new URL(req.url).searchParams.get('u')||'').trim();
  if(!u) return new Response(JSON.stringify({image:'',logo:''}),{status:400,headers:h});
  const LOGOS={'trucknews.com':'https://www.trucknews.com/wp-content/uploads/2020/01/trucknews-logo.png','globalnews.ca':'https://globalnews.ca/wp-content/themes/globalnews-2018/assets/images/global-news-logo.svg','cbc.ca':'https://www.cbc.ca/a/images/cbc-news-logo-en.svg','freightwaves.com':'https://www.freightwaves.com/wp-content/uploads/2019/09/FreightWaves-Logo-e1569001898901.png','theloadstar.com':'https://theloadstar.com/wp-content/themes/loadstar/img/loadstar-logo.svg','vocm.com':'https://vocm.com/wp-content/uploads/2016/09/vocm-logo.png','insidelogistics.ca':'https://www.insidelogistics.ca/wp-content/uploads/2023/03/inside-logistics-logo.png'};
  let logo='';try{logo=LOGOS[new URL(u).hostname.replace(/^www\./,'')]||'';}catch(_){}
  try{
    const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),4500);
    let html='';
    try{const res=await fetch(u,{signal:ctrl.signal,headers:{'User-Agent':'Mozilla/5.0 Chrome/120','Accept':'text/html,*/*'}});
      if(res.ok){const r=res.body.getReader();const chunks=[];let t=0;
        while(t<102400){const{done,value}=await r.read();if(done)break;chunks.push(value);t+=value.length;}
        r.cancel();html=new TextDecoder().decode(chunks.reduce((a,b)=>{const c=new Uint8Array(a.length+b.length);c.set(a);c.set(b,a.length);return c;},new Uint8Array(0)));
      }}finally{clearTimeout(timer);}
    if(!html) return new Response(JSON.stringify({image:logo,logo}),{status:200,headers:h});
    const mc=(a,v)=>{const e=v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const re=new RegExp('<meta[^>]+(?:'+a+'=["\']+'+e+'["\']+[^>]+content=["\']+([^"\']+)["\']+|content=["\']+([^"\']+)["\']+[^>]+'+a+'=["\']+'+e+'["\']+)','i');const m=html.match(re);return m?(m[1]||m[2]||''):'';}
    let img=mc('property','og:image:secure_url')||mc('property','og:image')||mc('name','twitter:image:src')||mc('name','twitter:image');
    if(!img){for(const t of html.match(/<img[^>]+src=["\']([^"\']+)["\'][^>]*>/gi)||[]){const s=(t.match(/src=["\']([^"\']+)["\']/)|| [])[1]||'';if(!s||s.startsWith('data:')) continue;if(/favicon|icon|logo|pixel|spacer/i.test(s)) continue;const w=parseInt((t.match(/width=["\']?(\d+)/)|| [])[1]||'0');if(w>0&&w<150) continue;img=s;break;}}
    if(img&&img.startsWith('//')) img='https:'+img;try{if(img) img=new URL(img,u).href;}catch(_){}
    return new Response(JSON.stringify({image:img||logo,logo}),{status:200,headers:h});
  }catch(_){return new Response(JSON.stringify({image:logo,logo}),{status:200,headers:h});}
};
