'use strict';
const http=require('http'),crypto=require('crypto');
function createServer({keys,models,scheduler,status,actions}){
 if(!Array.isArray(keys)||!keys.length||keys.some(k=>typeof k!=='string'||!k))throw Error('API keys required');
 const equal=(a,b)=>{
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length && crypto.timingSafeEqual(x,y);
 };
 const json=(res,code,body)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   const supplied=req.headers['x-goog-api-key']||
    (req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):undefined)||
    req.headers['x-api-key']||url.searchParams.get('key');
   if(typeof supplied!=='string'||!keys.some(k=>equal(k,supplied)))return json(res,401,{error:'Unauthorized'});
   if(req.method==='GET' && url.pathname==='/v1/models')
    return json(res,200,{object:'list',data:(typeof models==="function"?models():models).map(id=>({id,object:'model',owned_by:'google'}))});
   if(req.method==='GET' && url.pathname==='/internal/coordinator-status')
    return json(res,200,status());
   if(req.method==='GET' && ['/internal/requests','/internal/usage'].includes(url.pathname)){
    let options;
    try{options=require('./analytics-query').parseAnalyticsQuery(url.searchParams,{summary:url.pathname==='/internal/usage'});}
    catch{return json(res,400,{error:'Invalid analytics filters'});}
    const action=url.pathname==='/internal/requests'?actions.historyList:actions.historySummary;
    if(typeof action!=='function')return json(res,503,{error:'Analytics unavailable'});
    return json(res,200,await action(options));
   }
   const readBody=async()=>{
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>4096)throw Object.assign(Error('Body too large'),{statusCode:413});chunks.push(chunk);}
    let body;
    try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
    catch{throw Object.assign(Error('Invalid JSON body'),{statusCode:400});}
    if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(Error('JSON object required'),{statusCode:400});
    return body;
   };
   if(req.method==="POST" && url.pathname==="/internal/models/policy"){
    const body=await readBody();
    if(!body||typeof body.model!=="string"||!Number.isSafeInteger(body.revision)||body.revision<0||
       !["flash","pro"].includes(body.quotaFamily)||
       typeof body.antiTruncation!=="boolean")
     return json(res,400,{error:"Invalid model policy"});
    try{
     const result=await actions.saveModelPolicy(body);
     return json(res,result.saved?200:409,result);
    }catch(error){
     return json(res,error.statusCode===409?409:503,{error:error.statusCode===409?
      "Policy revision changed; refresh first":"Policy save not confirmed; refresh before retry"});
    }
   }
   if(req.method==='GET' && url.pathname==='/internal/models')
    return json(res,200,await actions.models());
   if(req.method==='GET' && url.pathname==='/internal/prices'){
    if(typeof actions.prices!=='function')return json(res,503,{error:'Prices unavailable'});
    return json(res,200,await actions.prices());
   }
   if(req.method==='POST' && url.pathname==='/internal/prices'){
    if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))
     return json(res,415,{error:'JSON required'});
    let body;try{body=await readBody();}catch{return json(res,400,{error:'Invalid JSON body'});}
    try{
     if(typeof actions.savePrice!=='function')return json(res,503,{error:'Prices unavailable'});
     return json(res,200,await actions.savePrice(body));
    }catch(e){
     const code=[400,409,503].includes(e.statusCode)?e.statusCode:503;
     return json(res,code,{error:code===409?'Price revision changed; refresh first':code===400?'Invalid price configuration':'Price save not confirmed; refresh before retry'});
    }
   }
   if(req.method==='POST' && url.pathname==='/internal/models/refresh'){
    const body=await readBody();
    if(!['A','B'].includes(body?.slot))return json(res,400,{error:'Invalid slot'});
    const result=await actions.syncModels(body.slot);
    return json(res,result.accepted||result.pending?202:409,result);
   }
   if(req.method==='POST' && url.pathname==='/internal/set-mode'){
    const body=await readBody();
    if(body?.mode!=='fake'&&body?.mode!=='real')return json(res,400,{error:'Invalid mode'});
    return json(res,200,await actions.setMode(body.mode));
   }
   if(req.method==='POST' && url.pathname==='/internal/rotate'){
    if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))
     return json(res,415,{error:'JSON required'});
    const body=await readBody();
    const slot=body?.slot;
    if(slot!==undefined&&['A','B'].includes(slot)===false)return json(res,400,{error:'Invalid slot'});
    const target=body?.targetAccount;
    if(target!==undefined&&target!==null&&(!Number.isSafeInteger(target)||target<1))return json(res,400,{error:'Invalid target account'});
    if(target!==undefined&&target!==null&&slot===undefined)return json(res,400,{error:'Target account requires a slot'});
    const result=await actions.rotate(slot,target===undefined?undefined:target===null?undefined:target);
    return json(res,Array.isArray(result.started)&&result.started.length>0?202:409,result);
   }
   if(req.method==='POST' && url.pathname==='/internal/sync-accounts')
    return json(res,200,await actions.syncAccounts());
   const native=/^\/v1beta\/models\/[a-zA-Z0-9._-]+:(generateContent|streamGenerateContent)$/.test(url.pathname);
   if(req.method!=='POST'||(url.pathname!=='/v1/chat/completions' && !native))
    return json(res,404,{error:'Endpoint unavailable'});
   if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))
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
  }catch(error){
   if(!res.destroyed){
    if(!res.headersSent)json(res,[400,413].includes(error.statusCode)?error.statusCode:503,
     {error:error.statusCode===400?'Invalid JSON body':error.statusCode===413?'Body too large':'Coordinator unavailable'});
    else res.destroy();
   }
  }
 });
 server.requestTimeout=120000;server.headersTimeout=30000;server.keepAliveTimeout=5000;
 return server;
}
module.exports={createServer};
