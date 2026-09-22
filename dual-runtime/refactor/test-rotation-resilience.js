'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AccountPool}=require('../code/account-pool');
const {DispatchCore}=require('./dispatch-core');
const {RotationController}=require('./rotation-controller');
const {QuarantineRecovery}=require('./quarantine-recovery');
const {CatalogRouting}=require('./catalog-routing');
const {WorkerDriver}=require('./worker-driver');
const {save}=require('./dispatch-state');
const {restore}=require('./restore-dispatch');
const model='gemini-example-flash',other='gemini-other-flash';
const plan={model,quotaFamily:'flash'};
function fixture(ids=[1,2,3,4]){
 const pool=new AccountPool(ids);
 for(const [slot,id] of [['A',1],['B',2]]){pool.slots.set(slot,{current:id,pending:null});pool.owners.set(id,slot);}
 const dispatch=new DispatchCore(pool,()=>{});
 for(const id of ids)dispatch.quotas.account(id,true);
 for(const state of dispatch.slots.values()){state.ready=true;state.workerEpoch=randomUUID();}
 dispatch.quotaExhausted=()=>true;
 return dispatch;
}
function ready(account){return {account,workerEpoch:randomUUID(),ready:true,busy:false,browserOperations:0,quarantined:false,activeRequests:0,pendingCompletions:0};}
function driver(){
 const accounts=new Map([['A',1],['B',2]]),oldIds={A:'a'.repeat(64),B:'b'.repeat(64)};
 return {
  stop:async()=>{},inspect:async slot=>({running:false,processesStopped:true,id:oldIds[slot]}),
  prepare:async(slot,account)=>accounts.set(slot,account),start:async()=>{},
  waitReady:async(slot,account)=>ready(account),probeReady:async(slot,account)=>ready(account),
  describe:async slot=>({Id:accounts.get(slot)<=2?oldIds[slot]:'c'.repeat(64),Config:{Labels:{'operit.account':String(accounts.get(slot))}},State:{Running:true,Pid:200}})
 };
}
function routing(dispatch){
 const now=Date.now(),cache=new Map();
 for(const [slot,owner] of dispatch.pool.slots)cache.set(slot,{account:owner.current,workerEpoch:dispatch.slots.get(slot).workerEpoch,
  observedAt:now,syncing:false,snapshot:{account:owner.current,stale:false,updatedAt:now,
   models:[model,other].map(id=>({id,methods:['generateContent']}))}});
 return new CatalogRouting(dispatch,{cache},Object.fromEntries([model,other].map(id=>[id,{quotaFamily:'flash',antiTruncation:false}])));
}
test('a hung rotation in A does not stop B from switching independently',async()=>{
 const d=fixture(),fake=driver(),r=new RotationController(d,fake);
 let release;const gate=new Promise(resolve=>{release=resolve;});
 fake.stop=slot=>slot==='A'?gate:Promise.resolve();
 const a=r.rotate('A',true,3);
 assert.equal(d.operations.has('A'),true);
 const b=await r.rotate('B',true,4);
 assert.equal(b.account,4);assert.equal(d.pool.slots.get('B').current,4);
 assert.equal(d.pool.slots.get('A').pending.id,3);
 release();await a;assert.equal(d.pool.slots.get('A').current,3);
 assert.equal(r.running.size,0);
});
test('uncertain stop retains both account reservations but only blocks its slot',async()=>{
 const d=fixture(),fake=driver(),r=new RotationController(d,fake);
 fake.stop=async slot=>{if(slot==='A')throw Error('Docker timeout');};
 await assert.rejects(r.rotate('A',true,3),/timeout/);
 assert.equal(d.pool.owners.get(1),'A');assert.equal(d.pool.owners.get(3),'A');
 assert.equal(r.failures.get('A').retryable,true);
 assert.equal(await r.reconcile('A'),false);
 assert.equal((await r.rotate('B',true,4)).account,4);
});
test('target readiness timeout is safely reconciled without repeating lifecycle commands',async()=>{
 const d=fixture(),fake=driver(),r=new RotationController(d,fake);
 fake.waitReady=async()=>{throw Error('Readiness timeout');};
 await assert.rejects(r.rotate('A',true,3),/timeout/);
 assert.equal(d.pool.slots.get('A').current,1);
 assert.equal(d.slots.get('A').rotation.phase,'started');
 assert.equal(r.failures.get('A').retryable,true);
 // Simulate coordinator restart: only the durable ownership/closure marker remains.
 const recovered=new RotationController(d,{...fake,stop:async()=>assert.fail('must not stop again'),start:async()=>assert.fail('must not start again')});
 assert.equal(await recovered.reconcile('A'),true);
 assert.equal(d.pool.slots.get('A').current,3);
 assert.equal(d.pool.owners.has(1),false);assert.equal(d.slots.get('A').rotation,undefined);
});
test('the first ownership commit checkpoint can restart without a stale rotation marker',async t=>{
 const d=fixture(),fake=driver(),r=new RotationController(d,fake);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ais-rotation-crash-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json');let firstCommitted;
 d.persist=state=>{
  save(state,file);
  if(state.pool.slots.get('A').current===3&&!firstCommitted)firstCommitted=fs.readFileSync(file);
 };
 await r.rotate('A',true,3);
 // Restore precisely the first checkpoint with the new owner, before any
 // following readiness/status checkpoint can repair the transaction.
 fs.writeFileSync(file,firstCommitted);
 const restored=restore(file);
 assert.equal(restored.pool.slots.get('A').current,3);
 assert.equal(restored.pool.slots.get('A').pending,null);
 assert.equal(restored.slots.get('A').rotation,undefined);
 restored.update('A',ready(3));
 assert.equal(restored.slots.get('A').ready,true);
});
test('legacy global 429 cooldown survives restore without freezing another healthy account',t=>{
 const d=fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'ais-legacy-cooldown-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json'),until=Date.now()+3600000;
 d.globalUntil=until;d.pool.cooldown(1,until);
 d.quotas.defer(2,other,'flash',until);
 d.quotas.charge(1,model,'flash');
 save(d,file);
 const restored=restore(file);
 restored.update('A',ready(1));restored.update('B',ready(2));
 assert.equal(restored.globalUntil,until);
 assert.equal(restored.pool.cooldowns.get(1),until);
 assert.equal(restored.quotas.view(1,model,'flash').used,1);
 assert.equal(restored.acquire(randomUUID(),plan,slot=>slot==='A'),undefined);
 assert.equal(restored.acquire(randomUUID(),{model:other,quotaFamily:'flash'},slot=>slot==='B'),undefined);
 const ticket=restored.acquire(randomUUID(),plan);
 assert.equal(ticket.slot,'B');assert.equal(ticket.account,2);
});
test('reconciliation refuses wrong identity, missing closure proof or unresolved execution',async()=>{
 const d=fixture(),fake=driver(),r=new RotationController(d,fake);
 fake.waitReady=async()=>{throw Error('timeout');};
 await assert.rejects(r.rotate('A',true,3));
 r.failures.get('A').retryAt=0;
 fake.describe=async()=>({Id:'d'.repeat(64),Config:{Labels:{'operit.account':'4'}},State:{Running:true}});
 assert.equal(await r.reconcile('A'),false);assert.equal(d.pool.slots.get('A').pending.id,3);
 r.failures.get('A').retryAt=0;delete d.slots.get('A').rotation.oldContainerId;
 assert.equal(await r.reconcile('A'),false);assert.equal(d.pool.slots.get('A').current,1);
 d.slots.get('A').rotation.oldContainerId='a'.repeat(64);d.slots.get('A').executions.orphan={};
 assert.equal(await r.reconcile('A'),false);
});
test('explicit manual target never silently switches to a different available account',async()=>{
 const d=fixture(),r=new RotationController(d,driver());
 assert.match(r.preflight('A',2).reason,/unavailable/);
 await assert.rejects(r.rotate('A',true,2),/unavailable/);
 assert.equal(d.pool.slots.get('A').pending,null);assert.equal(d.pool.owners.has(3),false);
 d.pool.cooldown(3,Date.now()+60000);
 await assert.rejects(r.rotate('A',true,3),/unavailable/);
 assert.equal(r.preflight('A').target,4);
});
test('invalid target credentials preserve the running account and back off only that spare',async()=>{
 const d=fixture(),fake=driver(),r=new RotationController(d,fake);let stopped=false;
 fake.stop=async()=>{stopped=true;};
 fake.validateAccount=account=>{if(account===3)throw Error('Invalid auth source');};
 assert.deepEqual(r.preflight('A',3),{available:false,reason:'Target account credentials unavailable'});
 assert.equal(stopped,false);assert.equal(d.slots.get('A').ready,true);
 assert.equal(d.pool.cooldowns.has(3),false);assert.equal(d.pool.slots.get('A').pending,null);
 await assert.rejects(r.rotate('A',true,3),{code:'ACCOUNT_AUTH_INVALID'});
 assert.equal(stopped,false);assert.equal(d.slots.get('A').ready,true);
 assert.equal(d.pool.slots.get('A').current,1);assert.equal(d.pool.slots.get('A').pending,null);
 assert.equal(r.failures.has('A'),false);assert.equal(d.pool.owners.has(3),false);
 assert(d.pool.cooldowns.get(3)>Date.now());
 assert.equal((await r.rotate('A',true)).account,4);
});
test('one demanded throttled model triggers rotation while other models still have quota',()=>{
 const d=fixture(),r=routing(d);
 d.quotas.defer(1,model,'flash',Date.now()+60000);
 assert.equal(r.exhausted('A'),false);
 assert.equal(r.exhausted('A',plan),true);
 assert.equal(r.rotationPlan('A',[plan]).target,3);
 assert.equal(r.rotationPlan('A',[]),undefined);
});
test('automatic rotation skips owned, cooled, exhausted and retry-excluded accounts',()=>{
 const d=fixture([1,2,3,4,5,6]),r=routing(d);
 d.quotas.defer(1,model,'flash',Date.now()+60000);
 d.pool.cooldown(3,Date.now()+60000);
 for(let i=0;i<100;i++)d.quotas.charge(4,model,'flash');
 const demand={...plan,excludedAccounts:[5]};
 assert.equal(r.rotationPlan('A',[demand]).target,6);
 assert.equal(d.rotationCandidate(undefined,demand),6);
 d.quotaExhausted=(slot,p)=>r.exhausted(slot,p);
 const ticket=d.reserveRotation('A',false,undefined,demand);
 assert.equal(ticket.id,6);
});
test('all cooling models and account authentication cooldown can rotate without emptying every daily counter',()=>{
 const d=fixture(),r=routing(d);
 for(const id of [model,other])d.quotas.defer(1,id,'flash',Date.now()+60000);
 assert.equal(r.exhausted('A'),true);assert.equal(r.rotationPlan('A').target,3);
 d.pool.cooldown(2,Date.now()+60000);
 assert.equal(r.rotationPlan('B',[plan]).target,3);
});
test('recovery of B is independent of a rotation in A and a late readiness success clears only B',async()=>{
 const d=fixture(),fake=driver(),r=new RotationController(d,fake),scheduler={executing:new Set(),closed:false};
 r.running.add('A');let running=true,recovered=false;
 const containerId='b'.repeat(64);
 fake.describe=async()=>({Id:containerId,Config:{Labels:{'operit.account':'2'}},State:{Running:running,Pid:running?42:0,Status:running?'running':'exited'}});
 fake.stop=async()=>{running=false;};fake.run=async()=>{running=true;};
 fake.restartStopped=async()=>{running=true;};
 const client={status:async()=>recovered?ready(2):{account:2,hardQuarantine:true,pendingCompletions:0,quarantined:true,busy:false,activeRequests:0},
  waitReady:async()=>{throw Error('Readiness timeout');}};
 const recovery=new QuarantineRecovery(d,scheduler,client,fake,r);
 await recovery.check('B');
 assert.equal(d.slots.get('B').recovery.phase,'waiting');assert.equal(r.failures.get('B').retryable,true);
 r.failures.get('B').retryAt=0;recovered=true;
 await recovery.check('B');
 assert.equal(d.slots.get('B').recovery,undefined);assert.equal(r.failures.has('B'),false);
 assert.equal(r.running.has('A'),true);assert.equal(d.pool.slots.get('B').current,2);
});
test('broken credential source fails before renaming old container or credential directory',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ais-stage-auth-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const auth=path.join(root,'slots','A','auth');fs.mkdirSync(auth,{recursive:true});
 fs.writeFileSync(path.join(auth,'old.json'),'old');
 const source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'auth-3.json'),'invalid');
 let commands=0;
 const worker=new WorkerDriver(root,'sha256:test',{},async()=>{commands++;assert.fail('Docker mutation must not run');},{authSource:source});
 worker.describe=async()=>({Id:'a'.repeat(64),State:{Running:false,Pid:0,Status:'exited'}});
 await assert.rejects(worker.prepare('A',3));
 assert.equal(commands,0);assert.equal(fs.readFileSync(path.join(auth,'old.json'),'utf8'),'old');
 assert.deepEqual(fs.readdirSync(path.join(root,'slots','A')),['auth']);
});
