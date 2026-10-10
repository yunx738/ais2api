'use strict';
const fs=require('fs');
// Keeps login browsers within budget. Dual mode pauses one of two workers;
// single mode keeps one worker parked and pauses the remaining one for a login.
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const fail=(m,code=409)=>Object.assign(Error(m),{statusCode:code});
class BrowserLease{
 constructor({dispatch,driver,client,rotation,scheduler,isStopping,file}){
  Object.assign(this,{dispatch,driver,client,rotation,scheduler,isStopping,file});
  this.lease=null;this.park=null;this.switching=null;this.lastError=null;
  this.mode=this.load();
 }
 load(){
  try{const m=JSON.parse(fs.readFileSync(this.file,'utf8'));
   return {single:m.single===true,parked:['A','B'].includes(m.parked)?m.parked:null};}
  catch{return {single:false,parked:null};}
 }
 save(){const t=this.file+'.tmp';fs.writeFileSync(t,JSON.stringify(this.mode),{mode:0o600});fs.renameSync(t,this.file);}
 other(x){return x==='A'?'B':'A';}
 status(){const l=this.lease;return l?{slot:l.slot,phase:l.phase,since:l.since,owner:l.owner}:null;}
 modeStatus(){
  const p=this.park;
  return {single:this.mode.single,parked:this.mode.parked,serving:this.mode.single&&this.mode.parked?this.other(this.mode.parked):null,
   phase:this.switching?this.switching:(this.mode.single?(p?.phase==='parked'?'parked':'pending'):'dual'),
   error:this.lastError,leaseActive:!!this.lease};
 }
 idle(slot){const s=this.dispatch.slots.get(slot),o=this.dispatch.pool.slots.get(slot);
  return o&&!o.pending&&Number.isSafeInteger(o.current)&&!s.active&&!s.requests.size&&!s.rotation&&!s.recovery&&!s.proxyApply&&
   !Object.keys(s.executions||{}).length&&!Object.keys(s.retirements||{}).length&&!this.rotation.running.has(slot);}
 async drain(slot,ms){
  const end=Date.now()+ms;
  while(!this.idle(slot)){if(Date.now()>end)throw Error('等待请求结束超时');await wait(1000);}
 }
 async stopOwned(slot){
  const d=await this.driver.describe(slot),account=this.dispatch.pool.slots.get(slot).current;
  if(d.Config?.Labels?.['operit.account']!==String(account))throw Error('实例身份不符');
  if(d.State?.Running===true)await this.driver.stop(slot);
  return {account,containerId:d.Id};
 }
 async resume(slot,account,containerId){
  const d=await this.driver.describe(slot);
  if(d.Id===containerId&&d.State?.Running!==true)await this.driver.restartStopped(slot,account,containerId);
  const fresh=await this.client.waitReady(slot,account,180000);
  if(this.rotation.ready(fresh,account))this.dispatch.update(slot,fresh);
 }
 // Called synchronously at startup, before the monitor or recovery can see a stopped parked worker.
 init(){if(this.mode.single&&this.mode.parked)this.tryPark();}
 tick(){
  if(!this.mode.single||this.park||this.switching||this.lease||this.isStopping()||this.dispatch.halted)return;
  if(Date.now()<(this.retryAt||0))return;
  this.tryPark();
 }
 tryPark(){
  const slot=this.mode.parked,o=this.dispatch.pool.slots.get(slot);
  if(!o||o.pending||this.rotation.running.has(slot))return;
  const op=this.dispatch.operations.acquire(slot,'login');
  if(!op)return;
  const p=this.park={slot,op,phase:'draining',since:Date.now()};
  this.dispatch.slots.get(slot).ready=false;
  this.switching='parking';
  (async()=>{
   await this.drain(slot,600000);
   p.phase='stopping';Object.assign(p,await this.stopOwned(slot));
   p.phase='parked';this.lastError=null;
  })().catch(e=>{
   this.lastError='停用失败：'+(e.message||'未知');
   try{this.dispatch.operations.release(op);}catch{}
   this.park=null;this.retryAt=Date.now()+60000;
  }).finally(()=>{this.switching=null;try{this.dispatch.checkpoint();}catch{}this.scheduler.pump();});
 }
 async unpark(){
  const p=this.park;if(!p)return;
  try{if(p.containerId)await this.resume(p.slot,p.account,p.containerId);}
  finally{try{this.dispatch.operations.release(p.op);}catch{}this.park=null;try{this.dispatch.checkpoint();}catch{}this.scheduler.pump();}
 }
 setMode(body){
  const single=body?.single;
  if(typeof single!=='boolean')throw fail('参数无效',400);
  if(this.lease)throw fail('登录进行中，结束后再切换');
  if(this.switching)throw fail('正在切换，请稍候');
  if(this.isStopping()||this.dispatch.halted)throw fail('调度不可用');
  if(single===this.mode.single)return this.modeStatus();
  if(single){
   const ready=x=>this.dispatch.slots.get(x).ready;
   const keep=['A','B'].find(ready)||'A';
   this.mode={single:true,parked:this.other(keep)};this.save();this.lastError=null;this.retryAt=0;
   this.tryPark();
  }else{
   this.mode={single:false,parked:null};this.save();this.lastError=null;
   this.switching='resuming';
   this.unpark().catch(e=>{this.lastError='恢复失败：'+(e.message||'未知');}).finally(()=>{this.switching=null;});
  }
  return this.modeStatus();
 }
 async acquire(owner){
  if(this.lease)throw fail('已有登录占用浏览器名额');
  if(this.switching)throw fail('运行模式切换中，请稍候');
  if(this.isStopping()||this.dispatch.halted)throw fail('调度不可用');
  let slot;
  if(this.mode.single){
   if(this.park?.phase!=='parked')throw fail('单实例模式尚未就绪');
   slot=this.other(this.park.slot);
  }else{
   // Pause an unusable worker first; otherwise B. Never refuse because of readiness.
   slot=['B','A'].find(x=>!this.dispatch.slots.get(x).ready)||'B';
  }
  const op=this.dispatch.operations.acquire(slot,'login');
  if(!op)throw fail('实例正在执行其他操作');
  const l=this.lease={slot,op,owner:String(owner||'').slice(0,40),phase:'draining',since:Date.now()};
  try{
   this.dispatch.slots.get(slot).ready=false;
   await this.drain(slot,180000);
   l.phase='stopping';Object.assign(l,await this.stopOwned(slot));
   l.phase='paused';return {slot,account:l.account,single:this.mode.single};
  }catch(e){await this.release(true).catch(()=>{});throw fail(e.message||'暂停失败');}
 }
 async release(force){
  const l=this.lease;if(!l)return {released:false};
  if(l.phase==='resuming'&&!force)return {released:false,resuming:true};
  l.phase='resuming';
  try{if(l.containerId)await this.resume(l.slot,l.account,l.containerId);}
  finally{
   this.dispatch.operations.release(l.op);this.lease=null;
   try{this.dispatch.checkpoint();}catch{}
   this.scheduler.pump();
  }
  return {released:true,slot:l.slot};
 }
}
module.exports={BrowserLease};
