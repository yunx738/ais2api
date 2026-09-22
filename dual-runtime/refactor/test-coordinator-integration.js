'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto'),{EventEmitter}=require('node:events');
const {AccountPool}=require('../code/account-pool');
const {DispatchCore}=require('./dispatch-core');
const {RequestScheduler}=require('./request-scheduler');
const {RotationController}=require('./rotation-controller');
const {CatalogController}=require('./catalog-controller');
const {CatalogRouting}=require('./catalog-routing');
const {CoordinatorMonitor}=require('./coordinator-monitor');

test('429 traverses settlement, spare rotation and fresh catalog before one successful retry',async t=>{
 const model='fixture-flash',pool=new AccountPool([1,2,3]),attempts=[],workers=new Map();
 for(const [slot,account] of [['A',1],['B',2]]){
  pool.slots.set(slot,{current:account,pending:null});pool.owners.set(account,slot);
  workers.set(slot,{account,epoch:randomUUID(),catalog:true});
 }
 const dispatch=new DispatchCore(pool,()=>{});
 for(const id of pool.ids)dispatch.quotas.account(id,true);
 const client={
  async status(slot,account){
   if(slot==='B')throw Error('Worker B offline');
   const w=workers.get(slot);assert.equal(w.account,account);
   return {account,workerEpoch:w.epoch,ready:true,busy:false,browserOperations:0,
    activeRequests:0,pendingCompletions:0,quarantined:false,cooldownUntil:0};
  },
  async execution(){return {found:true,record:{releasable:true}};},async retireExecution(){}
 };
 const scheduler=new RequestScheduler(dispatch,client,async(ticket,_route,_body,res)=>{
  attempts.push(ticket);
  if(ticket.account===1)return {status:429,retryAfter:'60',rejection:{status:429,
   headers:{'content-type':'application/json'},body:Buffer.from('{"error":"quota"}')}};
  assert.equal(ticket.account,3);assert.equal(workers.get('A').catalog,true);
  assert.equal(dispatch.slots.get('A').executions[attempts[0].id],undefined);
  res.statusCode=200;res.end('success');return {status:200};
 },{A:{},B:{}},{queueTimeoutMs:2000,controlTimeoutMs:40,confirmationTimeoutMs:40});
 const driver={validateAccount(){},async stop(){},
  async inspect(){return {running:false,processesStopped:true,id:'a'.repeat(64)};},
  async prepare(slot,account){workers.set(slot,{account,epoch:randomUUID(),catalog:false});},
  async start(){},waitReady:(slot,account)=>client.status(slot,account)
 };
 const rotation=new RotationController(dispatch,driver);
 const call=async(slot,account,jobId)=>{
  if(slot==='B')throw Error('Worker B offline');
  const w=workers.get(slot);assert.equal(w.account,account);
  if(jobId){w.catalog=true;w.jobId=jobId;return {accepted:true,account,jobId};}
  return {account,workerEpoch:w.epoch,jobId:w.jobId,syncing:false,
   ...(w.catalog?{snapshot:{account,updatedAt:Date.now(),stale:false,
    models:[{id:model,methods:['generateContent']}]}}:{})};
 };
 const catalogs=new CatalogController({dispatch,scheduler,client,rotation,call,timeoutMs:40});
 const routing=new CatalogRouting(dispatch,catalogs,{[model]:{quotaFamily:'flash',antiTruncation:false}});
 scheduler.resolveModel=(route,body)=>routing.resolve(route,body);
 dispatch.quotaExhausted=(slot,plan)=>routing.exhausted(slot,plan);
 const monitor=new CoordinatorMonitor({dispatch,scheduler,client,catalogs,rotation,routing,
  recovery:{async check(){}},timeoutMs:40});
 t.after(()=>{monitor.close();scheduler.close();});
 dispatch.update('A',await client.status('A',1));await catalogs.read('A');
 const res=new EventEmitter();Object.assign(res,{headersSent:false,writableEnded:false,destroyed:false});
 res.setHeader=()=>{};res.destroy=()=>{res.destroyed=true;res.emit('close');};
 res.end=text=>{res.output=text;res.headersSent=true;res.writableEnded=true;};
 scheduler.submit('/v1/chat/completions',Buffer.from(JSON.stringify({model})),res);
 const deadline=Date.now()+1500;
 while(!res.writableEnded&&Date.now()<deadline){
  monitor.tick();await Promise.allSettled(monitor.running.values());
  await new Promise(r=>setTimeout(r,2));
 }
 assert.equal(res.statusCode,200);assert.equal(res.output,'success');
 assert.deepEqual(attempts.map(a=>a.account),[1,3]);
 assert.notEqual(attempts[0].id,attempts[1].id);
 assert.equal(pool.slots.get('A').current,3);assert.equal(pool.owners.has(1),false);
 assert.equal(dispatch.quotas.view(1,model,'flash').used,1);
 assert.equal(dispatch.quotas.view(3,model,'flash').used,1);
 assert.equal(dispatch.halted,false);
});
