'use strict';
const http=require('http');
class WorkerClient {
 constructor(keys){this.keys=keys;}
 status(slot,expectedAccount){
  if(['A','B'].includes(slot)===false)return Promise.reject(Error('Invalid slot'));
  const key=this.keys[slot];
  if(typeof key!=='string'||key.length<32)return Promise.reject(Error('Missing internal key'));
  return new Promise((resolve,reject)=>{
   const req=http.get({
    hostname:'127.0.0.1',port:slot==='A'?8891:8892,
    path:'/internal/status',headers:{'X-Worker-Key':key},agent:false
   },res=>{
    let body='',size=0;
    res.on('data',chunk=>{
     size+=chunk.length;
     if(size>16384){req.destroy(Error('Oversized worker status'));return;}
     body+=chunk;
    });
    res.on('error',reject);
    res.on('end',()=>{
     try{
      if(res.statusCode!==200)throw Error('Worker status rejected');
      const s=JSON.parse(body);
      if(s.account!==expectedAccount)throw Error('Worker account mismatch');
      for(const name of ['ready','busy','quarantined']){
       if(typeof s[name]!=='boolean')throw Error('Invalid worker status');
      }
      for(const name of ['browserOperations','activeRequests']){
       if(Number.isSafeInteger(s[name])===false||s[name]<0)throw Error('Invalid operation count');
      }
      if(Number.isFinite(s.cooldownUntil)===false||s.cooldownUntil<0)throw Error('Invalid cooldown');
      resolve(s);
     }catch(error){reject(error);}
    });
   });
   const timer=setTimeout(()=>req.destroy(Error('Worker status deadline exceeded')),5000);
   req.on('close',()=>clearTimeout(timer));
   req.on('error',reject);
  });
 }
 setMode(slot,mode){
  if(['A','B'].includes(slot)===false)return Promise.reject(Error('Invalid slot'));
  if(mode!=='fake'&&mode!=='real')return Promise.reject(Error('Invalid mode'));
  const key=this.keys[slot];
  if(typeof key!=='string'||key.length<32)return Promise.reject(Error('Missing internal key'));
  const payload=JSON.stringify({mode});
  return new Promise((resolve,reject)=>{
   const req=http.request({hostname:'127.0.0.1',port:slot==='A'?8891:8892,path:'/internal/set-mode',method:'POST',headers:{'X-Worker-Key':key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)},agent:false},res=>{
    let body='';
    res.on('data',chunk=>{body+=chunk;});
    res.on('error',reject);
    res.on('end',()=>{try{if(res.statusCode!==200)throw Error('Worker rejected mode change');resolve(JSON.parse(body));}catch(error){reject(error);}});
   });
   req.setTimeout(5000,()=>req.destroy(Error('Worker mode deadline exceeded')));
   req.on('error',reject);
   req.end(payload);
  });
 }
 async waitReady(slot,account,timeoutMs=120000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
   try{
    const s=await this.status(slot,account);
    if(s.quarantined)throw Error('Worker quarantined');
    if(s.ready && s.busy===false && s.browserOperations===0 && s.activeRequests===0)return s;
   }catch(error){
    if(error.message==='Worker account mismatch'||error.message==='Worker quarantined')throw error;
   }
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw Error('Worker readiness deadline exceeded');
 }
}
module.exports={WorkerClient};
