'use strict';
const fs=require('fs'),path=require('path');
const {restore}=require('./restore-dispatch');
const {WorkerClient}=require('./worker-client');
const {WorkerDriver}=require('./worker-driver');
const {RotationController}=require('./rotation-controller');
const {RequestScheduler}=require('./request-scheduler');
const {forwardWorker}=require('./forward-worker');
const {createServer}=require('./coordinator-http');
async function main(){
 const root=process.env.DUAL_ROOT||'/opt/ais2api/dual-runtime';
 const cfg=JSON.parse(fs.readFileSync(path.join(root,'coordinator.json'),'utf8'));
 const dispatch=restore(path.join(root,'state.json'));
 const client=new WorkerClient(Object.fromEntries(['A','B'].map(s=>[s,cfg.workers[s].control])));
 const driver=new WorkerDriver(root,cfg.image,client);
 const rotation=new RotationController(dispatch,driver);
 const scheduler=new RequestScheduler(dispatch,client,forwardWorker,cfg.workers);
 let stopping=false,ticking=false;
 async function tick(){
  if(stopping||ticking||dispatch.halted)return;
  ticking=true;
  try{
   for(const slot of ['A','B']){
    const owner=dispatch.pool.slots.get(slot),state=dispatch.slots.get(slot);
    // Busy/uncertain requests and interrupted rotations require explicit reconciliation.
    if(!owner||owner.pending||rotation.running.has(slot)||rotation.failures.has(slot))continue;
    if(state.active>0){
     try{
      const probe=await client.status(slot,owner.current);
      if(probe.busy===false && probe.browserOperations===0 && probe.activeRequests===0 && probe.quarantined===false && probe.ready===true){
       state.requests.clear();state.active=0;
       dispatch.checkpoint();
       console.log('[Tick]',slot,'cleared orphaned requests');
      }
     }catch{}
    }
    if(state.active>0)continue;
    try{
     const current=await client.status(slot,owner.current);
     dispatch.update(slot,current);
     if(current.cooldownUntil>Date.now())dispatch.pool.cooldown(owner.current,current.cooldownUntil);
     if(state.ready && (state.usesFlash37>=100||state.usesFlash38>=100||state.usesPro>=10)){
      rotation.rotate(slot).then(result=>{
       if(!result.waiting)console.log('[Rotation]',slot,'account',result.account);
      }).catch(()=>console.error('[Rotation]',slot,'blocked; manual reconciliation required'));
     }
    }catch{state.ready=false;}
   }
   dispatch.checkpoint();
   scheduler.pump();
  }finally{ticking=false;}
 }
 let lastMode='unknown';
 const status=()=>({
  halted:dispatch.halted,queue:scheduler.queue.length,
  streamingMode:lastMode,
  slots:Object.fromEntries([...dispatch.slots].map(([slot,s])=>[slot,{
   account:dispatch.pool.slots.get(slot)?.current,
   pending:dispatch.pool.slots.get(slot)?.pending?.id,
   active:s.active,ready:s.ready,usesFlash37:s.usesFlash37,usesFlash38:s.usesFlash38,usesPro:s.usesPro,
   rotationBlocked:rotation.failures.has(slot)
  }])),
  accounts:dispatch.pool.ids.map(id=>{
   let name='N/A (未命名)';
   try{const d=JSON.parse(fs.readFileSync('/opt/ais2api/auth/auth-'+id+'.json','utf8'));if(typeof d.accountName==='string'&&d.accountName)name=d.accountName;}catch{}
   const owner=dispatch.pool.owners.get(id);
   const cooldownUntil=dispatch.pool.cooldowns.get(id)||0;
   return {id,name,owner:owner||null,cooldownUntil};
  })
 });
 await tick();
 const actions={
  async setMode(mode){
   const results={};
   for(const slot of ['A','B']){
    try{await client.setMode(slot,mode);results[slot]='ok';}
    catch(error){results[slot]=String(error.message||error);}
   }
   if(results.A==='ok'||results.B==='ok')lastMode=mode;
   return {mode,results};
  },
  async rotate(slot,targetAccount){
   const targets=slot===undefined?['A','B']:[slot];
   const started=[];const skipped=[];
   for(const target of targets){
    const state=dispatch.slots.get(target),owner=dispatch.pool.slots.get(target);
    if(owner?.pending||rotation.running.has(target)||rotation.failures.has(target)){skipped.push({slot:target,reason:'busy or blocked'});continue;}
    if(!state.ready||state.active>0){skipped.push({slot:target,reason:'not idle'});continue;}
    if(targetAccount!==undefined&&targetAccount!==null){
     if(dispatch.pool.ids.includes(targetAccount)===false)return {started,skipped:[{slot:target,reason:'unknown account'}]};
     if(dispatch.pool.owners.has(targetAccount)||((dispatch.pool.cooldowns.get(targetAccount)||0)>Date.now()))return {started,skipped:[{slot:target,reason:'target occupied or cooling'}]};
     if(dispatch.pool.slots.get(target)?.current===targetAccount)return {started,skipped:[{slot:target,reason:'target already active'}]};
    }
    rotation.rotate(target,true,targetAccount).then(result=>{
     console.log('[ManualRotation]',target,'account',result.account);
    }).catch(error=>console.error('[ManualRotation]',target,'failed:',String(error.message||error)));
    started.push(target);
   }
   return {started,skipped};
  },
  async syncAccounts(){
   const files=fs.readdirSync('/opt/ais2api/auth').filter(n=>/^auth-\d+\.json$/.test(n)).map(n=>Number(n.match(/\d+/)[0])).sort((a,b)=>a-b);
   const added=[];
   for(const id of files){
    if(dispatch.pool.ids.includes(id))continue;
    dispatch.pool.ids.push(id);
    dispatch.pool.ids.sort((a,b)=>a-b);
    added.push(id);
   }
   if(added.length)dispatch.checkpoint();
   return {added,pool:dispatch.pool.ids};
  }
 };
 const server=createServer({keys:cfg.apiKeys,models:JSON.parse(fs.readFileSync(path.join(root,'code','models.json'),'utf8')),scheduler,status,actions});
 await new Promise((resolve,reject)=>{
  server.once('error',reject);server.listen(8890,'127.0.0.1',resolve);
 });
 const timer=setInterval(()=>tick().catch(()=>{
  dispatch.halted=true;
  console.error('[Coordinator] checkpoint or health reconciliation failed; dispatch stopped');
 }),2000);
 console.log('[Coordinator] loopback 8890; concurrency 2; 80 uses per worker');
 async function shutdown(){
  if(stopping)return;stopping=true;clearInterval(timer);scheduler.close();
  server.close();
  const deadline=Date.now()+620000;
  while(Date.now()<deadline && ([...dispatch.slots.values()].some(s=>s.active>0)||rotation.running.size)){
   await new Promise(r=>setTimeout(r,500));
  }
  try{dispatch.checkpoint();}catch{}
  process.exit(0);
 }
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
main().catch(()=>{console.error('[Coordinator] startup failed; details suppressed');process.exitCode=1;});
