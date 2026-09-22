'use strict';
const http=require('http');
class WorkerClient {
 constructor(keys){this.keys=keys;}
 status(slot,expectedAccount){
  if(['A','B'].includes(slot)===false)return Promise.reject(Error('Invalid slot'));
  const key=this.keys[slot];
  if(typeof key!=='string'||key.length<32)return Promise.reject(Error('Missing internal key'));
  return new Promise((resolve,reject)=>{
   let settled=false,timer;
   const finish=(error,value)=>{
    if(settled)return;settled=true;clearTimeout(timer);
    if(error)reject(error);else resolve(value);
   };
   const req=http.get({
    hostname:'127.0.0.1',port:slot==='A'?8891:8892,
    path:'/internal/status',headers:{'X-Worker-Key':key},agent:false
   },res=>{
    let body='',size=0;
    res.on('data',chunk=>{
     size+=chunk.length;
     if(size>16384){finish(Error('Oversized worker status'));res.destroy();req.destroy();return;}
     body+=chunk;
    });
    res.on('aborted',()=>finish(Error('Worker status response aborted')));
    res.on('error',()=>finish(Error('Worker status response failed')));
    res.on('close',()=>{if(!res.complete)finish(Error('Worker status response incomplete'));});
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
      finish(undefined,s);
     }catch(error){finish(error);}
    });
   });
   // A request close can precede an incomplete response. Only settlement clears the deadline.
   timer=setTimeout(()=>{finish(Error('Worker status deadline exceeded'));req.destroy();},5000);
   req.on('error',error=>finish(error));
  });
 }
 retireExecution(ticket){return this.execution(ticket,true);}
 execution(ticket,retire=false) {
  const {slot,account,id,workerEpoch}=ticket;
  const uuid=/^[a-f0-9-]{36}$/;
  const key=this.keys[slot];
  if(!['A','B'].includes(slot)||!Number.isSafeInteger(account)||account<1||
     !uuid.test(id||'')||!uuid.test(workerEpoch||'')||
     typeof key!=='string'||key.length<32) {
    return Promise.reject(Error('Invalid execution query'));
  }
  return new Promise((resolve,reject)=>{
    let settled=false,timer;
    const finish=(error,data)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error)reject(error);else resolve(data);
    };
    const req=http.request({
      method:retire?'POST':'GET',hostname:'127.0.0.1',port:slot==='A'?8891:8892,
      path:(retire?'/internal/retire-execution/':'/internal/executions/')+id,
      headers:{...(Number.isSafeInteger(ticket.admissionDeadline)?{'X-Admission-Deadline':String(ticket.admissionDeadline)}:{}),'X-Worker-Key':key,'X-Worker-Epoch':workerEpoch,'X-Execution-Account':String(account)},agent:false
    },res=>{
      let size=0;const chunks=[];
      res.on('data',chunk=>{
        size+=chunk.length;
        if(size>262144){
          finish(Error('Execution response too large'));res.destroy();req.destroy();return;
        }
        chunks.push(chunk);
      });
      res.on('aborted',()=>finish(Error('Execution response aborted')));
      res.on('error',()=>finish(Error('Execution response failed')));
      res.on('end',()=>{
        try {
          if(res.statusCode!==200)throw Error('Execution endpoint unavailable');
          const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(retire){if(data.retired!==true||data.account!==account||data.slot!==slot||data.workerEpoch!==workerEpoch||data.attemptId!==id)throw Error('Invalid retirement receipt');return finish(undefined,data);}
          if(data.account!==account||data.slot!==slot||typeof data.found!=='boolean')
            throw Error('Execution ownership mismatch');
          if(data.workerEpoch!==workerEpoch)throw Error('Worker incarnation changed');
          // Not found is NOT proof that a previously forwarded request ended.
          if(!data.found){ if(data.admissionClosed===true && (data.attemptId!==id || !Number.isSafeInteger(ticket.admissionDeadline) || data.admissionDeadline!==ticket.admissionDeadline))throw Error('Invalid closed admission evidence'); return finish(undefined,data); }
          const r=data.record;
          if(!r||r.requestId!==id||r.attemptId!==id||r.account!==account||
             r.slot!==slot||r.workerEpoch!==workerEpoch||
             typeof r.sealed!=='boolean'||typeof r.releasable!=='boolean'||
             !Array.isArray(r.operations)||r.operations.length>1000||
             ![null,'success','failed','cancelled'].includes(r.response))
            throw Error('Invalid execution record');
          const seen=new Set();
          for(const op of r.operations){
            if(!op||typeof op.operationId!=='string'||!op.operationId||
               seen.has(op.operationId)||typeof op.sessionId!=='string'||!op.sessionId||
               !['running','uncertain','settled'].includes(op.state))
              throw Error('Invalid operation evidence');
            seen.add(op.operationId);
          }
          const confirmed=r.sealed && r.response !== null && r.operations.every(op=>op.state==='settled');
          if(r.releasable!==confirmed)throw Error('Inconsistent completion evidence');
          finish(undefined,data);
        } catch(error){finish(error);}
      });
    });
    req.end();
    req.on('error',()=>finish(Error('Execution query unavailable')));
    timer=setTimeout(()=>{
      finish(Error('Execution query deadline exceeded'));req.destroy();
    },5000);
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
    if(s.executionProtocol===2 && /^[a-f0-9-]{36}$/.test(s.workerEpoch||"") && s.ready && s.busy===false && s.browserOperations===0 && s.activeRequests===0)return s;
   }catch(error){
    if(error.message==='Worker account mismatch'||error.message==='Worker quarantined')throw error;
   }
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw Error('Worker readiness deadline exceeded');
 }
}
module.exports={WorkerClient};
