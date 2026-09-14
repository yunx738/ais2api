'use strict';
const fs=require('fs');
const {WorkerClient}=require('./worker-client');
const root='/opt/ais2api/dual-runtime';
const cfg=JSON.parse(fs.readFileSync(root+'/coordinator.json'));
const client=new WorkerClient(Object.fromEntries(['A','B'].map(s=>[s,cfg.workers[s].control])));
Promise.all([['A',4],['B',5]].map(async([slot,account])=>{
 const s=await client.waitReady(slot,account,180000);
 console.log('WORKER_READY',slot,'account',s.account,'active',s.activeRequests);
})).catch(()=>{console.error('Worker readiness not confirmed');process.exitCode=1;});
