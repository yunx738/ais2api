'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {AccountPool}=require('../code/account-pool');
const {DispatchCore}=require('./dispatch-core');
const {RotationController}=require('./rotation-controller');
const {WorkerDriver}=require('./worker-driver');
const {QuarantineRecovery}=require('./quarantine-recovery');
const {save}=require('./dispatch-state');
const {restore}=require('./restore-dispatch');
function ready(account){return {account,workerEpoch:randomUUID(),ready:true,busy:false,browserOperations:0,quarantined:false,hardQuarantine:false,activeRequests:0,pendingCompletions:0};}
function fixture(t){
 // This test sandbox does not map container UID 1000. Keep real credential
 // reads/writes, directory renames and checkpoints; stub only POSIX ownership.
 t.mock.method(fs,'fchownSync',()=>{});t.mock.method(fs,'chownSync',()=>{});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ais-lifecycle-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source');fs.mkdirSync(source);
 for(const id of [1,2,3,4])fs.writeFileSync(path.join(source,'auth-'+id+'.json'),JSON.stringify({cookies:[{name:'cookie-'+id}],origins:[]}));
 const pool=new AccountPool([1,2,3,4]),file=path.join(root,'state.json');
 const containers=new Map(),commands=[];
 for(const [slot,account] of [['A',1],['B',2]]){
  const id=(slot==='A'?'a':'b').repeat(64),auth=path.join(root,'slots',slot,'auth');
  fs.mkdirSync(auth,{recursive:true});fs.copyFileSync(path.join(source,'auth-'+account+'.json'),path.join(auth,'auth-'+account+'.json'));
  pool.slots.set(slot,{current:account,pending:null});pool.owners.set(account,slot);
  containers.set(id,{Id:id,Name:'/ais2api-dual-'+slot.toLowerCase(),
   Config:{Labels:{'operit.project':'ais2api-dual','operit.slot':slot,'operit.account':String(account)}},
   State:{Running:true,Pid:account,Status:'running'}});
 }
 const dispatch=new DispatchCore(pool,d=>save(d,file));
 for(const id of pool.ids)dispatch.quotas.account(id,true);
 for(const [slot,owner] of pool.slots)dispatch.update(slot,ready(owner.current));
 dispatch.quotaExhausted=()=>true;dispatch.checkpoint();
 const engine={fail:null,containers,commands};
 const find=name=>[...containers.values()].find(d=>d.Id===name||d.Name==='/'+name);
 engine.run=async(command,args)=>{
  assert.equal(command,'docker');commands.push([...args]);
  let stdout='';
  if(args[0]==='inspect'){
   const d=find(args[1]);if(!d)throw Error('Container not found');stdout=JSON.stringify([d]);
  }else if(args[0]==='ps'){
   const pattern=args[args.indexOf('--filter')+1].slice(5),regex=new RegExp(pattern);
   stdout=[...containers.values()].filter(d=>regex.test(d.Name)).map(d=>d.Id).join('\n');
  }else if(args[0]==='stop'){
   const d=find(args.at(-1));assert(d);d.State={Running:false,Pid:0,Status:'exited'};
  }else if(args[0]==='rename'){
   const d=find(args[1]);assert(d);d.Name='/'+args[2];
  }else if(args[0]==='create'){
   const name=args[args.indexOf('--name')+1];assert.equal(find(name),undefined,'must not create duplicate canonical target');
   const labels={};args.forEach((arg,i)=>{if(arg==='--label'){const [key,value]=args[i+1].split('=');labels[key]=value;}});
   const id='c'.repeat(64);assert.equal(containers.has(id),false,'target created exactly once');
   containers.set(id,{Id:id,Name:'/'+name,Config:{Labels:labels},State:{Running:false,Pid:0,Status:'created'}});stdout=id;
  }else if(args[0]==='start'){
   const d=find(args[1]);assert(d);d.State={Running:true,Pid:99,Status:'running'};
  }else assert.fail('Unexpected Docker command '+args[0]);
  if(engine.fail?.(args)){engine.fail=null;throw Error('Simulated lost command response');}
  return {stdout};
 };
 const client={status:async(slot,account)=>{
  const d=find('ais2api-dual-'+slot.toLowerCase());if(!d||!d.State.Running)throw Error('ECONNREFUSED');
  assert.equal(Number(d.Config.Labels['operit.account']),account);return ready(account);
 },waitReady:async(slot,account)=>client.status(slot,account)};
 const worker=()=>new WorkerDriver(root,'sha256:test',client,engine.run,{authSource:source});
 return {root,file,source,dispatch,engine,client,worker,find};
}
for(const crash of ['reservation','stop','container rename','old auth rename','new auth rename','create','start']){
 test('rotation resumes after crash at '+crash+' with real driver and persisted state',async t=>{
  const f=fixture(t),driver=f.worker();
  if(crash==='reservation')driver.describe=async()=>{throw Error('Simulated coordinator crash');};
  else if(['stop','container rename','create','start'].includes(crash)){
   const verb=crash==='container rename'?'rename':crash;f.engine.fail=args=>args[0]===verb;
  }else{
   const sync=driver.syncDirectory.bind(driver);let failed=false;
   driver.syncDirectory=dir=>{
    sync(dir);
    const names=fs.readdirSync(dir);
    if(!failed&&names.some(n=>n.startsWith('auth-retired-'))&&
       (crash==='old auth rename'?!names.includes('auth'):names.includes('auth')&&!names.some(n=>n.startsWith('auth-next-')))){
     failed=true;throw Error('Simulated coordinator crash after rename');
    }
   };
  }
  const rotation=new RotationController(f.dispatch,driver);
  await assert.rejects(rotation.rotate('A',true,3),/Simulated/);
  const checkpoint=JSON.parse(fs.readFileSync(f.file));
  assert.equal(new Map(checkpoint.pool.slots).get('A').pending.id,3);
  assert(new Map(checkpoint.dispatch.slots).get('A').rotation,'reservation has durable recovery intent');
  const restored=restore(f.file),resumed=new RotationController(restored,f.worker());
  assert.equal(await resumed.reconcile('A'),true);
  assert.equal(restored.pool.slots.get('A').current,3);assert.equal(restored.pool.slots.get('A').pending,null);
  assert.equal(restored.pool.owners.has(1),false);assert.equal(restored.pool.owners.get(3),'A');
  assert.equal(f.find('ais2api-dual-a').State.Running,true);
  assert.equal(f.engine.containers.get('a'.repeat(64)).State.Running,false);
  assert.equal(f.engine.commands.filter(args=>args[0]==='create').length,1);
  const base=path.join(f.root,'slots','A');
  assert.deepEqual(fs.readdirSync(path.join(base,'auth')),['auth-3.json']);
  const retired=fs.readdirSync(base).find(name=>name.startsWith('auth-retired-'));
  assert.deepEqual(fs.readdirSync(path.join(base,retired)),['auth-1.json']);
  assert.equal(restored.halted,false);
 });
}
test('Docker create timeout leaves stopped target recoverable without creating it twice',async t=>{
 const f=fixture(t);f.engine.fail=args=>args[0]==='create';
 const rotation=new RotationController(f.dispatch,f.worker());
 await assert.rejects(rotation.rotate('A',true,3));
 assert.equal(f.find('ais2api-dual-a').State.Status,'created');
 assert.equal(f.dispatch.slots.get('A').rotation.phase,'prepared');
 rotation.failures.get('A').retryAt=0;
 assert.equal(await rotation.reconcile('A'),true);
 assert.equal(f.engine.commands.filter(args=>args[0]==='create').length,1);
});
test('rotation refuses to stop replacement container after predecessor identity was pinned',async t=>{
 const f=fixture(t);f.engine.fail=args=>args[0]==='stop';
 const rotation=new RotationController(f.dispatch,f.worker());await assert.rejects(rotation.rotate('A',true,3));
 const predecessor=f.engine.containers.get('a'.repeat(64));predecessor.Name+='_moved';
 f.engine.containers.set('d'.repeat(64),{...predecessor,Id:'d'.repeat(64),Name:'/ais2api-dual-a',State:{Running:true,Pid:44,Status:'running'}});
 const before=f.engine.commands.length;rotation.failures.get('A').retryAt=0;
 assert.equal(await rotation.reconcile('A'),false);
 assert.equal(f.engine.commands.slice(before).some(args=>['stop','rename','create','start'].includes(args[0])),false);
 assert.equal(f.dispatch.pool.slots.get('A').pending.id,3);
});
function recovery(f,dispatch=f.dispatch){
 const scheduler={closed:false,executing:new Set()},rotation=new RotationController(dispatch,f.worker());
 return {scheduler,rotation,recovery:new QuarantineRecovery(dispatch,scheduler,f.client,f.worker(),rotation)};
}
test('ordinary idle OOM/exit recovers same account after unavailable control endpoint',async t=>{
 const f=fixture(t);f.find('ais2api-dual-a').State={Running:false,Pid:0,Status:'exited',OOMKilled:true};
 f.dispatch.quotas.charge(1,'fixture-flash','flash');
 const r=recovery(f);await r.recovery.check('A');
 assert.equal(f.find('ais2api-dual-a').State.Running,true);
 assert.equal(f.dispatch.pool.slots.get('A').current,1);
 assert.equal(f.dispatch.quotas.view(1,'fixture-flash','flash').used,1);
 assert.equal(f.dispatch.slots.get('A').recovery,undefined);
 assert.deepEqual(f.engine.commands.filter(args=>['stop','create','start'].includes(args[0])),[['start','a'.repeat(64)]]);
});
for(const obstruction of ['running but unreachable','active execution','retirement','foreign account','slot operation','shutdown']){
 test('exited-worker recovery preserves safety with '+obstruction,async t=>{
  const f=fixture(t),state=f.dispatch.slots.get('A'),r=recovery(f);
  f.client.status=async()=>{throw Error('ECONNREFUSED');};
  if(obstruction!=='running but unreachable')f.find('ais2api-dual-a').State={Running:false,Pid:0,Status:'exited'};
  if(obstruction==='active execution'){state.active=1;state.requests.add(randomUUID());}
  if(obstruction==='retirement')state.retirements[randomUUID()]={};
  if(obstruction==='foreign account')f.find('ais2api-dual-a').Config.Labels['operit.account']='4';
  if(obstruction==='slot operation')f.dispatch.operations.acquire('A','catalog');
  if(obstruction==='shutdown')r.scheduler.closed=true;
  await r.recovery.check('A');
  assert.equal(f.engine.commands.some(args=>['stop','start','create','rename'].includes(args[0])),false);
  assert.equal(f.dispatch.slots.get('A').recovery,undefined);
 });
}
test('a stopped recovery target retries after bounded backoff and survives coordinator restart',async t=>{
 const f=fixture(t),r=recovery(f);f.find('ais2api-dual-a').State={Running:false,Pid:0,Status:'exited'};
 const run=f.engine.run;let failed=false;
 const worker=new WorkerDriver(f.root,'sha256:test',f.client,async(command,args)=>{
  if(args[0]==='start'&&!failed){failed=true;throw Error('Docker temporarily unavailable');}return run(command,args);
 },{authSource:f.source});
 r.recovery.driver=worker;await r.recovery.check('A');
 assert.equal(f.dispatch.slots.get('A').recovery.phase,'starting');
 const restored=restore(f.file),again=recovery(f,restored);
 await again.recovery.check('A');assert.equal(f.find('ais2api-dual-a').State.Running,false);
 restored.slots.get('A').recoveryAttempts=[Date.now()-300001];
 await again.recovery.check('A');assert.equal(f.find('ais2api-dual-a').State.Running,true);
 assert.equal(restored.slots.get('A').recovery,undefined);
});
test('shutdown arriving during a status probe prevents any container mutation',async t=>{
 const f=fixture(t),r=recovery(f);f.find('ais2api-dual-a').State={Running:false,Pid:0,Status:'exited'};
 let release;f.client.status=()=>new Promise((_resolve,reject)=>{release=()=>reject(Error('offline'));});
 const checking=r.recovery.check('A');r.scheduler.closed=true;release();await checking;
 assert.equal(f.engine.commands.some(args=>['stop','start','create','rename'].includes(args[0])),false);
});
test('legacy pending reservation without a journal resumes only with the still-current canonical account',async t=>{
 const f=fixture(t);f.dispatch.pool.reserve('A',3);f.dispatch.slots.get('A').ready=false;f.dispatch.checkpoint();
 const restored=restore(f.file);assert.equal(restored.slots.get('A').rotation,undefined);
 const rotation=new RotationController(restored,f.worker());assert.equal(await rotation.reconcile('A'),true);
 assert.equal(restored.pool.slots.get('A').current,3);assert.equal(restored.pool.slots.get('A').pending,null);
 assert.equal(f.find('ais2api-dual-a').Config.Labels['operit.account'],'3');
 assert.equal(f.engine.containers.get('a'.repeat(64)).State.Running,false);
});
test('legacy already-canonical target without predecessor closure proof remains explicitly blocked',async t=>{
 const f=fixture(t);f.dispatch.pool.reserve('A',3);f.dispatch.slots.get('A').ready=false;f.dispatch.checkpoint();
 f.find('ais2api-dual-a').Name='/unknown-predecessor';
 f.engine.containers.set('c'.repeat(64),{Id:'c'.repeat(64),Name:'/ais2api-dual-a',
  Config:{Labels:{'operit.project':'ais2api-dual','operit.slot':'A','operit.account':'3'}},State:{Running:true,Pid:33,Status:'running'}});
 const restored=restore(f.file),rotation=new RotationController(restored,f.worker());
 assert.equal(await rotation.reconcile('A'),false);
 assert.equal(rotation.failures.get('A').retryable,false);
 assert.match(rotation.failures.get('A').reason,/closure proof.*manual reconciliation/);
 assert.equal(restored.pool.slots.get('A').current,1);assert.equal(restored.pool.slots.get('A').pending.id,3);
 assert.equal(f.engine.commands.some(args=>['stop','start','create','rename'].includes(args[0])),false);
});
test('retirement housekeeping is recorded only after the successful ownership checkpoint',async t=>{
 const f=fixture(t),rotation=new RotationController(f.dispatch,f.worker());
 const {RetiredResourceCleanup}=require('./retired-resource-cleanup');
 const cleanup=new RetiredResourceCleanup({dispatch:f.dispatch,driver:f.worker(),root:f.root});
 let recorded=0;
 rotation.onRetired=(slot,marker)=>{
  const persisted=restore(f.file);
  assert.equal(persisted.pool.slots.get(slot).current,3);
  assert.equal(persisted.pool.slots.get(slot).pending,null);
  assert.equal(persisted.slots.get(slot).rotation,undefined);
  assert.equal(cleanup.record(slot,marker),true);recorded++;
 };
 f.engine.fail=args=>args[0]==='create';
 await assert.rejects(rotation.rotate('A',true,3));
 assert.equal(recorded,0);assert.equal(fs.existsSync(path.join(f.root,'retired-resources')),false);
 rotation.failures.get('A').retryAt=0;assert.equal(await rotation.reconcile('A'),true);
 assert.equal(recorded,1);
 const receipts=cleanup.store.list();assert.equal(receipts.length,1);
 assert.equal(receipts[0].containerId,'a'.repeat(64));assert.equal(receipts[0].account,1);
});
test('unavailable retirement journal does not fail or undo a successful rotation',async t=>{
 const f=fixture(t),rotation=new RotationController(f.dispatch,f.worker());
 const {RetiredResourceCleanup}=require('./retired-resource-cleanup');
 const cleanup=new RetiredResourceCleanup({dispatch:f.dispatch,driver:f.worker(),root:f.root,store:{record(){throw Error('ENOSPC');}}});
 rotation.onRetired=(slot,marker)=>cleanup.record(slot,marker);
 assert.deepEqual(await rotation.rotate('A',true,3),{slot:'A',account:3});
 assert.equal(f.dispatch.halted,false);assert.equal(restore(f.file).pool.slots.get('A').current,3);
 assert.equal(cleanup.status().recordError,'retirement_receipt_unavailable');
 assert.equal(f.engine.containers.get('a'.repeat(64)).State.Running,false);
 assert(fs.readdirSync(path.join(f.root,'slots','A')).some(name=>name.startsWith('auth-retired-')));
});
