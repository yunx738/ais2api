'use strict';
// Asks the host login service to log one account in again right now, and waits for the result.
const http=require('http');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function call(key,method,p,body,port=8894){
 return new Promise(resolve=>{
  const payload=body===undefined?'':JSON.stringify(body);
  const req=http.request({host:'127.0.0.1',port,path:p,method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},r=>{
   let s='';r.on('data',d=>{s+=d;});r.on('end',()=>{let b=null;try{b=JSON.parse(s);}catch{}resolve({status:r.statusCode,body:b});});});
  req.on('error',()=>resolve({status:0,body:null}));req.setTimeout(15000,()=>{req.destroy();resolve({status:0,body:null});});req.end(payload);
 });
}
function createRelogin({key,port=8894,timeoutMs=8*60000,pollMs=3000,request=call}){
 return async function relogin(id,slot){
  const end=Date.now()+timeoutMs;let job=null;
  while(!job){
   const r=await request(key,'POST','/login/relogin',{id,slot},port);
   if(r.status===202&&r.body?.id){job=r.body;break;}
   const msg=r.body?.error||('登录服务不可用 '+r.status);
   // Another login is running (or the service restarts): wait for it instead of giving up.
   if((r.status===409&&/已有登录在进行/.test(msg))||r.status===0){if(Date.now()>end)return {ok:false,message:msg};await wait(5000);continue;}
   return {ok:false,message:msg};
  }
  while(Date.now()<end){
   if(job.status==='done')return {ok:true,message:job.message||''};
   if(job.status==='failed')return {ok:false,message:job.message||'登录失败'};
   if(job.status==='need')return {ok:false,message:'需要人工验证'};
   await wait(pollMs);
   const r=await request(key,'GET','/login/'+job.id,undefined,port);
   if(r.status===200&&r.body)job=r.body;else if(r.status===404)return {ok:false,message:'登录任务丢失'};
  }
  return {ok:false,message:'重新登录超时'};
 };
}
module.exports={createRelogin};
