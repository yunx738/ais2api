const fs=require('fs');
const {WorkerClient}=require('./worker-client');
const root='/opt/ais2api/dual-runtime';
const cfg=JSON.parse(fs.readFileSync(root+'/coordinator.json'));
const client=new WorkerClient(Object.fromEntries(['A','B'].map(s=>[s,cfg.workers[s].control])));
(async()=>{
 const results=await Promise.allSettled([['A',4],['B',5]].map(async([slot,account])=>{
  try{
   const s=await client.waitReady(slot,account,120000);
   console.log('WORKER_READY',slot,JSON.stringify(s));
  }catch{
   try{console.log('WORKER_NOT_READY',slot,JSON.stringify(await client.status(slot,account)));}
   catch{console.log('WORKER_STATUS_UNAVAILABLE',slot);}
   throw Error('Worker not ready');
  }
 }));
 if(results.some(r=>r.status==='rejected'))process.exitCode=1;
})().catch(()=>{process.exitCode=1;});
