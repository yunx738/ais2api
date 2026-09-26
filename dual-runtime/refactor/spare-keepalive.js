'use strict';
const fs=require('fs'),path=require('path'),http=require('http');
const {readAuth,writeAuth,cookieExpiry}=require('./auth-maintenance');
const PERIOD=3*86400000,RETRY=12*3600000,GAP=1800000,START_DELAY=600000,HOST_MIN=450*1048576;
const RESULTS=new Set(['ok','login_required','region_blocked','proxy_error','timeout','unexpected_page','no_cookies','request_failed','auth_file_changed','too_large','failed']);
function hostAvailable(){try{const m=fs.readFileSync('/proc/meminfo','utf8').match(/MemAvailable:\s+(\d+)/);return m?Number(m[1])*1024:0;}catch{return 0;}}
function post(client,slot,body,timeout){
 return new Promise((resolve,reject)=>{
  const payload=Buffer.from(JSON.stringify(body));let done=false,timer;
  const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(v);};
  const req=http.request({hostname:'127.0.0.1',port:slot==='A'?8891:8892,method:'POST',path:'/internal/auth/keepalive',agent:false,
   headers:{'X-Worker-Key':client.keys[slot],'Content-Type':'application/json','Content-Length':payload.length}},res=>{
    let size=0;const chunks=[];
    res.on('data',b=>{size+=b.length;if(size>400000){finish(Error('too_large'));res.destroy();req.destroy();return;}chunks.push(b);});
    res.on('error',()=>finish(Error('request_failed')));res.on('aborted',()=>finish(Error('request_failed')));
    res.on('end',()=>{try{if(res.statusCode!==200)throw Error();finish(null,JSON.parse(Buffer.concat(chunks)));}catch{finish(Error('request_failed'));}});
   });
  req.on('error',()=>finish(Error('request_failed')));
  timer=setTimeout(()=>{finish(Error('request_failed'));req.destroy();},timeout);
  req.end(payload);
 });
}
class SpareKeepalive{
 constructor({dispatch,driver,client,scheduler,rotation,occupied,isStopping,slot='A',now=Date.now,memory=hostAvailable,request=post}){
  Object.assign(this,{dispatch,driver,client,scheduler,rotation,occupied,isStopping,slot,now,memory,request});
  this.startedAt=now();this.running=null;this.nextTryAt=0;this.lastSkip=null;
 }
 record(id){return this.dispatch.authSaves?.[id]||{};}
 dueAt(id){
  const r=this.record(id),good=Math.max(r.keepaliveAt||0,r.savedAt||0);
  const fail=r.keepaliveAttemptAt&&r.keepaliveResult!=='ok'?r.keepaliveAttemptAt+RETRY:0;
  return Math.max(good?good+PERIOD:0,fail);
 }
 lastGlobal(){return Math.max(0,...Object.values(this.dispatch.authSaves||{}).map(r=>r?.keepaliveAttemptAt||0));}
 spares(){const d=this.dispatch;return d.pool.ids.filter(id=>!d.accountFlags[id]&&!d.pool.owners.has(id)&&!this.occupied(id));}
 idle(){
  const d=this.dispatch,s=d.slots.get(this.slot),o=d.pool.slots.get(this.slot);
  return !this.isStopping()&&!d.halted&&!this.scheduler.queue.length&&o&&!o.pending&&Number.isSafeInteger(o.current)&&
   s.ready&&!s.active&&!s.requests.size&&!s.rotation&&!s.recovery&&!s.proxyApply&&!s.catalogTask&&
   !Object.keys(s.executions||{}).length&&!Object.keys(s.retirements||{}).length&&
   !this.rotation.running.size&&!d.operations.has(this.slot);
 }
 status(){return {enabled:true,slot:this.slot,periodDays:3,gapMinutes:30,running:this.running,
  nextTryAt:Math.max(this.nextTryAt,this.lastGlobal()+GAP,this.startedAt+START_DELAY),lastSkip:this.lastSkip};}
 tick(){
  const now=this.now();
  if(this.running!==null||this.isStopping()||this.dispatch.halted)return;
  if(now<this.startedAt+START_DELAY||now<this.nextTryAt||now-this.lastGlobal()<GAP)return;
  const list=this.spares().filter(id=>this.dueAt(id)<=now).sort((a,b)=>this.dueAt(a)-this.dueAt(b));
  if(!list.length)return;
  if(this.memory()<HOST_MIN){this.lastSkip='low_memory';this.nextTryAt=now+600000;return;}
  if(!this.idle())return;
  const lease=this.dispatch.operations.acquire(this.slot,'auth');if(!lease)return;
  this.running=list[0];
  return this.run(list[0]).catch(()=>{}).finally(()=>{
   this.running=null;this.dispatch.operations.release(lease);this.scheduler.pump();
  });
 }
 async run(id){
  const d=this.dispatch,slot=this.slot,s=d.slots.get(slot),current=d.pool.slots.get(slot).current;
  const skip=(why,ms)=>{this.lastSkip=why;this.nextTryAt=this.now()+ms;};
  let probe;
  try{probe=await this.client.status(slot,current);}catch{return skip('worker_unavailable',600000);}
  if(probe.keepaliveProtocol!==1)return skip('worker_upgrade_pending',21600000);
  if(!probe.ready||probe.busy||probe.quarantined||probe.hardQuarantine||probe.activeRequests!==0||
    probe.browserOperations!==0||(probe.pendingCompletions||0)!==0||!/^[a-f0-9-]{36}$/.test(probe.workerEpoch||''))
   return skip('worker_busy',600000);
  const file=path.join(this.driver.authSource,'auth-'+id+'.json');
  let original;try{original=readAuth(file);}catch{return skip('auth_unreadable',600000);}
  const attemptAt=this.now();let res;
  try{res=await this.request(this.client,slot,{account:id,expectedEpoch:probe.workerEpoch,
   state:{cookies:original.data.cookies,origins:original.data.origins}},130000);}
  catch(e){res={result:e.message==='too_large'?'too_large':'request_failed'};}
  if(['busy','low_memory'].includes(res?.result))return skip(res.result,600000);
  let result=RESULTS.has(res?.result)?res.result:'failed';
  const rec={...this.record(id),keepaliveAttemptAt:attemptAt};
  if(result==='ok'){
   try{
    if(res.account!==id||!Array.isArray(res.state?.cookies)||!Array.isArray(res.state?.origins))throw Error('failed');
    const next=cookieExpiry(res.state);if(!next.keyCookies)throw Error('no_cookies');
    if(d.accountFlags[id]||d.pool.owners.has(id)||this.occupied(id))throw Error('failed');
    const prev=cookieExpiry(original.data).expiresAt;
    writeAuth(file,original,res.state);
    Object.assign(rec,{keepaliveAt:this.now(),savedAt:this.now(),slot:'keepalive',previousExpiresAt:prev??null,
     expiresAt:next.expiresAt??null,extended:Number.isFinite(prev)&&Number.isFinite(next.expiresAt)&&next.expiresAt>prev,lastResult:'saved'});
   }catch(e){result=RESULTS.has(e.message)?e.message:'failed';}
  }
  rec.keepaliveResult=result;
  if(result==='login_required'&&!d.accountFlags[id]&&!d.pool.owners.has(id)&&!this.occupied(id))
   d.accountFlags[id]={status:'invalid',reason:'login_required',at:this.now()};
  d.authSaves={...(d.authSaves||{}),[id]:rec};this.lastSkip=null;
  try{d.checkpoint();}catch{d.halted=true;}
 }
}
module.exports={SpareKeepalive,PERIOD,GAP};
