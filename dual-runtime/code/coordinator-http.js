'use strict';
const http=require('http'),crypto=require('crypto');
function createServer({keys,models,scheduler,status,actions}){
 if(!Array.isArray(keys)||!keys.length||keys.some(k=>typeof k!=='string'||!k))throw Error('API keys required');
 const equal=(a,b)=>{
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length && crypto.timingSafeEqual(x,y);
 };
 const json=(res,code,body)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   const supplied=req.headers['x-goog-api-key']||
    (req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):undefined)||
    req.headers['x-api-key']||url.searchParams.get('key');
   if(typeof supplied!=='string'||!keys.some(k=>equal(k,supplied)))return json(res,401,{error:'Unauthorized'});
   if(req.method==='GET' && url.pathname==='/v1/models')
    return json(res,200,{object:'list',data:models.map(id=>({id,object:'model',owned_by:'google'}))});
   if(req.method==='GET' && url.pathname==='/internal/coordinator-status')
    return json(res,200,status());
   const readBody=async()=>{
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>4096)throw Error('Body too large');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
   };
   if(req.method==='POST' && url.pathname==='/internal/set-mode'){
    const body=await readBody();
    if(body?.mode!=='fake'&&body?.mode!=='real')return json(res,400,{error:'Invalid mode'});
    return json(res,200,await actions.setMode(body.mode));
   }
   if(req.method==='POST' && url.pathname==='/internal/rotate'){
    const body=await readBody().catch(()=>({}));
    const slot=body?.slot;
    if(slot!==undefined&&['A','B'].includes(slot)===false)return json(res,400,{error:'Invalid slot'});
    const target=body?.targetAccount;
    if(target!==undefined&&target!==null&&Number.isSafeInteger(target)===false)return json(res,400,{error:'Invalid target account'});
    const result=await actions.rotate(slot,target===undefined?undefined:target===null?undefined:target);
    return json(res,result.started===false?409:202,result);
   }
   if(req.method==='POST' && url.pathname==='/internal/sync-accounts')
    return json(res,200,await actions.syncAccounts());
   const native=/^\/v1beta\/models\/[a-zA-Z0-9._-]+:(generateContent|streamGenerateContent)$/.test(url.pathname);
   if(req.method!=='POST'||(url.pathname!=='/v1/chat/completions' && !native))
    return json(res,404,{error:'Endpoint unavailable'});
   if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))
    return json(res,415,{error:'JSON required'});
   let size=0;const chunks=[];
   for await(const chunk of req){
    size+=chunk.length;
    if(size>20*1024*1024){json(res,413,{error:'Request too large'});return;}
    chunks.push(chunk);
   }
   if(res.destroyed)return;
   const body=Buffer.concat(chunks);
   let parsed;try{parsed=JSON.parse(body);}catch{return json(res,400,{error:'Invalid JSON'});}
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return json(res,400,{error:'JSON object required'});
   scheduler.submit(url.pathname,body,res);
  }catch{
   if(!res.destroyed){
    if(!res.headersSent)json(res,503,{error:'Coordinator unavailable'});
    else res.destroy();
   }
  }
 });
 server.requestTimeout=120000;server.headersTimeout=30000;server.keepAliveTimeout=5000;
 return server;
}
module.exports={createServer};
