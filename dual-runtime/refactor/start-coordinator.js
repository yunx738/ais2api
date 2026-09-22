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
 const {openHistory}=require('./history-startup');
 const {createRecordedForward}=require('./recorded-forward');
 const history=await openHistory(path.join(root,'request-history'));
 if(!history.status().ready)console.error('[Analytics] history unavailable; generation remains enabled');
 const {ModelPriceStore}=require('./model-price-store');
 const priceStore=new ModelPriceStore(path.join(root,'model-prices.json'));
 const recordedForward=createRecordedForward({history,forward:forwardWorker,priceFor:model=>priceStore.get(model)});
 const scheduler=new RequestScheduler(dispatch,client,recordedForward,cfg.workers);
 const {QuarantineRecovery}=require('./quarantine-recovery');
 const recovery=new QuarantineRecovery(dispatch,scheduler,client,driver,rotation);
 const {CatalogController}=require('./catalog-controller');
 const {createCatalogWorkerClient}=require('./catalog-worker-client');
 const catalogs=new CatalogController({
  dispatch,scheduler,client,rotation,call:createCatalogWorkerClient(cfg.workers)
 });
 const {CatalogRouting}=require("./catalog-routing");
 const {ModelPolicyStore}=require("./model-policy-store");
 const policyStore=new ModelPolicyStore(path.join(root,"model-policies.json"),cfg.modelPolicies||{});
 const routing=new CatalogRouting(dispatch,catalogs,policyStore.policies);
 scheduler.resolveModel=(route,body,options)=>routing.resolve(route,body,options);
 dispatch.quotaExhausted=(slot,plan)=>routing.exhausted(slot,plan);
 let stopping=false;
 const {RetiredResourceCleanup}=require('./retired-resource-cleanup');
 const cleanup=new RetiredResourceCleanup({dispatch,driver,root,options:cfg.retiredCleanup===undefined?{}:cfg.retiredCleanup,
  isStopping:()=>stopping,hasWaiting:()=>scheduler.queue.length>0});
 rotation.onRetired=(slot,marker)=>cleanup.record(slot,marker);
 const {CoordinatorMonitor}=require('./coordinator-monitor');
 const monitor=new CoordinatorMonitor({dispatch,client,catalogs,recovery,rotation,routing,scheduler});
 let lastMode='unknown';
 const status=()=>({
  halted:dispatch.halted,queue:scheduler.queue.length,scheduling:scheduler.status(),
  streamingMode:lastMode,
  analytics:recordedForward.status(),
  retiredCleanup:cleanup.status(),
  quotaMode:"per-account-per-model",quotaLimits:{flash:100,pro:10},
  slots:Object.fromEntries([...dispatch.slots].map(([slot,s])=>[slot,{
   account:dispatch.pool.slots.get(slot)?.current,
   pending:dispatch.pool.slots.get(slot)?.pending?.id,
   active:s.active,ready:s.ready,
   quota:Number.isSafeInteger(dispatch.pool.slots.get(slot)?.current)?dispatch.quotas.summary(dispatch.pool.slots.get(slot).current,policyStore.policies):undefined,
   healthCheck:monitor.status(slot),workerEpoch:s.workerEpoch,workerHealth:s.workerHealth,pendingRetirements:Object.keys(s.retirements||{}).length,
   pendingExecutions:Object.values(s.executions||{}).map(t=>({id:t.id,phase:t.phase,createdAt:t.createdAt})),
   legacyUnresolved:[...s.requests].filter(id=>!s.executions?.[id]).length,
   operation:dispatch.operations.status(slot),rotationBlocked:rotation.failures.has(slot),
   rotationFailure:rotation.failures.has(slot)?{
    reason:rotation.failures.get(slot).reason,retryable:rotation.failures.get(slot).retryable===true,
    retryAt:rotation.failures.get(slot).retryAt||null
   }:undefined
  }])),
  accounts:dispatch.pool.ids.map(id=>{
   let name='N/A (未命名)';
   try{const d=JSON.parse(fs.readFileSync('/opt/ais2api/auth/auth-'+id+'.json','utf8'));if(typeof d.accountName==='string'&&d.accountName)name=d.accountName;}catch{}
   const owner=dispatch.pool.owners.get(id);
   const cooldownUntil=dispatch.pool.cooldowns.get(id)||0;
   return {id,name,owner:owner||null,cooldownUntil,quota:dispatch.quotas.summary(id,policyStore.policies)};
  })
 });
 monitor.tick();
 const actions={
  prices(){return {...priceStore.snapshot(),models:[...routing.policies.keys()].sort()};},
  savePrice(body){
   if(!body || !routing.policies.has(body.model))throw Object.assign(Error('Configured canonical model required'),{statusCode:400});
   const saved=priceStore.set(body);
   return {...saved,models:[...routing.policies.keys()].sort()};
  },
  historyList(options){return {...history.list(options),recording:recordedForward.status()};},
  historySummary(options){return {...history.summary(options),recording:recordedForward.status()};},
  async models(){
   const errors={};
   await Promise.all(['A','B'].map(async slot=>{
    try{await catalogs.read(slot);}catch{errors[slot]='catalog_status_unavailable';}
   }));
   return {slots:catalogs.status(),errors,generationRoutingIntegrated:true,configuredPolicies:routing.policies.size,policyState:policyStore.snapshot()};
  },
  async saveModelPolicy(body){
   if(stopping||dispatch.halted||scheduler.queue.length||scheduler.executing.size||
      [...dispatch.slots].some(([slot,s])=>s.active>0||dispatch.operations.has(slot)))
    return {saved:false,reason:"requests_or_operations_busy"};
   const known=[...dispatch.pool.slots].some(([slot,owner])=>
    routing.eligible(slot,owner.current,body.model));
   if(!known)return {saved:false,reason:"model_not_in_fresh_catalog"};
   const result=policyStore.set(body);
   routing.policies=new Map(Object.entries(result.policies).map(([id,p])=>[id,Object.freeze({...p})]));
   return {saved:true,...result};
  },
  async syncModels(slot){
   if(stopping)return {accepted:false,reason:'coordinator_stopping'};
   return catalogs.start(slot);
  },
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
   if(stopping)return {started:[],skipped:[{slot,reason:'coordinator_stopping'}]};
   const targets=slot===undefined?['A','B']:[slot];
   const started=[];const skipped=[];
   for(const target of targets){
    const state=dispatch.slots.get(target),owner=dispatch.pool.slots.get(target);
    if(dispatch.operations.has(target)||owner?.pending||rotation.running.has(target)||rotation.failures.has(target)){skipped.push({slot:target,reason:'busy or blocked'});continue;}
    if(!state.ready||state.active>0){skipped.push({slot:target,reason:'not idle'});continue;}
    if(targetAccount!==undefined&&targetAccount!==null){
     if(dispatch.pool.ids.includes(targetAccount)===false)return {started,skipped:[{slot:target,reason:'unknown account'}]};
     if(dispatch.pool.owners.has(targetAccount)||((dispatch.pool.cooldowns.get(targetAccount)||0)>Date.now()))return {started,skipped:[{slot:target,reason:'target occupied or cooling'}]};
     if(dispatch.pool.slots.get(target)?.current===targetAccount)return {started,skipped:[{slot:target,reason:'target already active'}]};
    }
    const available=rotation.preflight(target,targetAccount);
    if(!available.available){skipped.push({slot:target,reason:available.reason});continue;}
    rotation.rotate(target,true,targetAccount).then(result=>{
     console.log('[ManualRotation]',target,'account',result.account);
    }).catch(error=>console.error('[ManualRotation]',target,'failed:',String(error.message||error)));
    started.push(target);
   }
   return {started,skipped};
  },
  async syncAccounts(){
   if(stopping)return {added:[],reason:'coordinator_stopping'};
   const files=fs.readdirSync('/opt/ais2api/auth').filter(n=>/^auth-[1-9]\d*\.json$/.test(n)).map(n=>Number(n.match(/\d+/)[0])).filter(Number.isSafeInteger).sort((a,b)=>a-b);
   const added=[];
   for(const id of files){
    if(dispatch.pool.ids.includes(id))continue;
    dispatch.quotas.account(id,true);
    dispatch.pool.ids.push(id);
    dispatch.pool.ids.sort((a,b)=>a-b);
    added.push(id);
   }
   if(added.length)dispatch.checkpoint();
   return {added,pool:dispatch.pool.ids};
  }
 };
 const server=createServer({keys:cfg.apiKeys,models:()=>routing.list(),scheduler,status,actions});
 await new Promise((resolve,reject)=>{
  server.once('error',reject);server.listen(8890,'127.0.0.1',resolve);
 });
 const timer=setInterval(()=>monitor.tick(),2000);
 const cleanupTimer=setInterval(()=>cleanup.tick(),60000);cleanupTimer.unref();
 console.log('[Coordinator] loopback 8890; protocol v2; per-slot concurrency 2; explicit model quotas');
 async function shutdown(){
  if(stopping)return;stopping=true;clearInterval(timer);clearInterval(cleanupTimer);cleanup.close();monitor.close();scheduler.close();
  server.close();
  const deadline=Date.now()+620000;
  while(Date.now()<deadline && ([...dispatch.slots.values()].some(s=>s.active>0||Object.keys(s.retirements||{}).length>0)||rotation.running.size||catalogs.jobs.size)){
   await scheduler.reconcile();
   await Promise.all(["A","B"].map(slot=>catalogs.reconcile(slot)));
   await new Promise(r=>setTimeout(r,500));
  }
  try{dispatch.checkpoint();}catch{}
  process.exit(0);
 }
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
main().catch(()=>{console.error('[Coordinator] startup failed; details suppressed');process.exitCode=1;});
