export default async () => new Response(JSON.stringify({ok:true,time:Date.now()}),{status:200,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
