'use strict';
// Headless Build call: same CodeAssistantOffline flow as build-page-call.js, but signed and sent by the local
// no-browser service (AIStudio2API + dual-runtime patch, POST /v1/x-build-raw). No browser page involved.
// raw(op) -> {s, t?, path?, data?}. Never logs keys, cookies or signatures.
const http=require('http'),crypto=require('crypto');
const APP=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// key: the service's PROXY_API_KEY; rawKey: its BUILD_RAW_KEY (the endpoint answers 404 without it, and only on loopback).
function createRaw({host='127.0.0.1',port=2048,key,rawKey,timeoutMs=120000}){
 if(typeof key!=='string'||!key)throw Error('headless key required');
 if(typeof rawKey!=='string'||rawKey.length<16)throw Error('headless raw key required');
 return (call,{signal,deadlineMs=timeoutMs}={})=>new Promise((resolve,reject)=>{
  const payload=Buffer.from(JSON.stringify(call));
  const req=http.request({host,port,path:'/v1/x-build-raw',method:'POST',agent:false,
   headers:{'Content-Type':'application/json','Content-Length':payload.length,'Authorization':'Bearer '+key,'X-Build-Raw-Key':rawKey}},res=>{
   const chunks=[];let size=0;
   res.on('data',c=>{size+=c.length;if(size>96*1024*1024){req.destroy(Error('raw reply too large'));return;}chunks.push(c);});
   res.on('end',()=>{
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(Object.assign(Error('raw reply unparseable ('+res.statusCode+')'),{status:502}));}
    if(res.statusCode!==200)return reject(Object.assign(Error(String(body?.error?.message||'raw call failed').slice(0,300)),{status:res.statusCode,code:body?.error?.code}));
    resolve(body);
   });
   res.on('error',reject);
  });
  const timer=setTimeout(()=>req.destroy(Object.assign(Error('raw call deadline'),{status:504})),deadlineMs);
  const abort=()=>req.destroy(Object.assign(Error('cancelled'),{status:499}));
  if(signal){if(signal.aborted)return abort();signal.addEventListener('abort',abort,{once:true});}
  req.on('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(e);});
  req.on('close',()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);});
  req.end(payload);
 });
}
const sleep=(ms,signal)=>new Promise((r,j)=>{const t=setTimeout(r,ms);signal?.addEventListener('abort',()=>{clearTimeout(t);j(Object.assign(Error('cancelled'),{status:499}));},{once:true});});
const FAILED=/\[null,null,null,null,null,\["[^"]{1,300}",\[/;
// Same result shape as the page function: {s, stage, t, gid, tries, polls, resent, firstModel, ms}.
async function callBuild(raw,{account,parts,model,thinking,app,hardMs=600000,signal}){
 if(!APP.test(app||''))return {s:400,stage:'args',t:'invalid applet'};
 const ac=new AbortController(),t0=Date.now();
 const wd=setTimeout(()=>ac.abort(),hardMs);
 const onAbort=()=>ac.abort();signal?.addEventListener('abort',onAbort,{once:true});
 const opt={signal:ac.signal};
 let gid=null;
 try{
  parts=parts.map(p=>p);
  for(let i=0;i<parts.length;i++){
   const pu=parts[i];if(!pu||!pu.__upload)continue;
   const [mime,b64,name]=pu.__upload;
   const r=await raw({op:'upload',account,mime,data:b64},opt);
   if(r.s!==200||!r.path)return {s:502,stage:'upload',t:'upload '+r.s+' '+String(r.t||'').slice(0,300)};
   const w=new Array(18).fill(null);w[17]=[mime,r.path,name,String(Buffer.from(b64,'base64').length)];parts[i]=w;
  }
  const binding=parts.map(p=>p[1]!=null?p[1]:(p[2]?p[2][1]:'')).join(' ');
  let tries=0,resent=0,r1,r2,t2='',polls=0,firstModel=0;
  gen:for(let g=0;;g++){
   for(let tg=1;;tg++){
    tries++;
    // field 2 (index 1) is the WAA proof slot, filled by the service. 23=true: new chat in this applet.
    const b=[[[parts,'user']],null,null,null,null,2,null,'models/'+model,null,null,null,app,null,[2],null,1,null,null,thinking?[1,null,null,thinking]:null,null,null,null,true,null,null,null,null,null,crypto.randomUUID().toUpperCase()];
    r1=await raw({op:'submit',account,body:b,binding},{...opt,deadlineMs:120000});
    if(r1.s===403&&/caller does not have permission/i.test(r1.t||'')&&tg<8){await sleep(1500*tries,ac.signal);continue;}
    break;
   }
   if(r1.s!==200)return {s:r1.s,stage:'create',tries,t:String(r1.t||'').slice(0,2000),ms:Date.now()-t0};
   try{gid=JSON.parse(r1.t)[0];}catch{}
   if(typeof gid!=='string')return {s:502,stage:'create',tries,t:'no generation id: '+String(r1.t||'').slice(0,300)};
   const done=new RegExp('\\["\\d+","\\d+"(?:,"\\d+")?\\],"'+gid+'"\\]');
   polls=0;firstModel=0;
   for(;;){
    polls++;
    r2=await raw({op:'rpc',account,method:'StreamCodeAssistantOfflineGeneration',body:[gid,null,null,app]},{...opt,deadlineMs:Math.max(5000,hardMs-(Date.now()-t0))});
    if(r2.s!==200){if(!t2)t2=r2.t||'';break;}
    t2=r2.t||'';
    if(!firstModel&&t2.indexOf('"model"]')>=0)firstModel=polls;
    if(FAILED.test(t2))break;
    if(done.test(t2)||polls>=20)break;
    if(!firstModel&&polls>=12&&g<1)break;
    await sleep(1000,ac.signal);
   }
   if(r2.s===200&&!firstModel&&!done.test(t2)&&g<1&&!FAILED.test(t2)){resent++;continue gen;}
   break;
  }
  const out={s:r2.s,stage:'stream',tries,resent,polls,firstModel,gid,t:t2,ms:Date.now()-t0};
  gid=null; // finished: nothing to cancel
  return out;
 }catch(e){
  if(signal?.aborted)return {s:499,stage:'cancel',t:'cancelled'};
  if(ac.signal.aborted)return {s:504,stage:'fetch',t:'timeout after '+hardMs+'ms',ms:Date.now()-t0};
  return {s:e.status&&e.status!==499?e.status:502,stage:'fetch',t:String(e.message||e).slice(0,200),ms:Date.now()-t0};
 }finally{
  clearTimeout(wd);signal?.removeEventListener('abort',onAbort);
  // Unfinished generation: cancel it in the background so it stops using the account.
  if(gid)raw({op:'rpc',account,method:'CancelCodeAssistantOfflineGeneration',body:[gid,app]},{deadlineMs:30000}).catch(()=>{});
 }
}
// Anti-truncation reply file. Service verifies SHA-256; 409 = hash mismatch, 413 = too large.
async function readFile(raw,{account,app,hash,signal}){
 const r=await raw({op:'file',account,applet:app,hash},{signal,deadlineMs:60000});
 if(r.s!==200||typeof r.data!=='string')return {ok:false,s:r.s,err:r.s===409?'hash_mismatch':r.s===413?'too_large':'status_'+r.s};
 const b=Buffer.from(r.data,'base64');
 try{return {ok:true,s:200,len:b.length,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b)};}
 catch{return {ok:false,s:200,len:b.length,err:'not_utf8'};}
}
// Applet RPC for project rotation (CreateApplet / DeleteApplet), same {status,text} shape as the worker endpoint.
async function appletRpc(raw,account,method,request){
 const r=await raw({op:'rpc',account,method,body:request},{deadlineMs:90000});
 return {status:r.s,text:r.t||''};
}
module.exports={createRaw,callBuild,readFile,appletRpc};
