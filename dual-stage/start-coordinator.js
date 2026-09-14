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
    if(!owner||owner.pending||state.busy||rotation.running.has(slot)||rotation.failures.has(slot))continue;
    try{
     const current=await client.status(slot,owner.current);
     dispatch.update(slot,current);
     if(current.cooldownUntil>Date.now())dispatch.pool.cooldown(owner.current,current.cooldownUntil);
     if(state.ready && state.uses>=80){
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
 const status=()=>({
  halted:dispatch.halted,queue:scheduler.queue.length,
  slots:Object.fromEntries([...dispatch.slots].map(([slot,s])=>[slot,{
   account:dispatch.pool.slots.get(slot)?.current,
   pending:dispatch.pool.slots.get(slot)?.pending?.id,
   busy:s.busy,ready:s.ready,uses:s.uses,
   rotationBlocked:rotation.failures.has(slot)
  }]))
 });
 await tick();
 const server=createServer({keys:cfg.apiKeys,models:JSON.parse(fs.readFileSync(path.join(root,'code','models.json'),'utf8')),scheduler,status});
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
  while(Date.now()<deadline && ([...dispatch.slots.values()].some(s=>s.busy)||rotation.running.size)){
   await new Promise(r=>setTimeout(r,500));
  }
  try{dispatch.checkpoint();}catch{}
  process.exit(0);
 }
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
main().catch(()=>{console.error('[Coordinator] startup failed; details suppressed');process.exitCode=1;});
