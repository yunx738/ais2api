'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CoordinatorMonitor}=require('./coordinator-monitor');
const {CatalogController}=require('./catalog-controller');
const {SlotOperations}=require('./slot-operations');

function fixture(overrides={}) {
 const updates=[],calls={A:0,B:0};
 const dispatch={halted:false,slots:new Map(['A','B'].map(s=>[s,{ready:true,active:0}])),
  pool:{slots:new Map([['A',{current:1}],['B',{current:2}]]),cooldown(){}},
  operations:new SlotOperations(),checkpoint(){},
  update(slot,probe){updates.push(slot);this.slots.get(slot).ready=probe.ready;}};
 const catalogs={jobs:new Map(),cache:new Map(),async read(){},async reconcile(){},async start(){}};
 const rotation={running:new Set(),failures:new Map()};
 const client={async status(slot){calls[slot]++;return {ready:true,cooldownUntil:0};}};
 const scheduler={pump(){},pendingPlans(){return [];}};
 const monitor=new CoordinatorMonitor({dispatch,catalogs,rotation,client,scheduler,
  recovery:{async check(){}},routing:{rotationPlan(){}},timeoutMs:25,...overrides});
 return {monitor,dispatch,catalogs,rotation,client,scheduler,updates,calls};
}

test('a hung A health request never delays B or overlaps a second A poll',async()=>{
 const f=fixture();
 f.client.status=async slot=>{f.calls[slot]++;if(slot==='A')return new Promise(()=>{});return {ready:true,cooldownUntil:0};};
 f.monitor.tick();const a=f.monitor.running.get('A');
 await f.monitor.running.get('B');
 assert.deepEqual(f.updates,['B']);assert.equal(f.calls.A,1);
 f.monitor.tick();await f.monitor.running.get('B');
 assert.equal(f.calls.A,1);assert.equal(f.calls.B,2);
 await a;
 assert.equal(f.dispatch.halted,false);assert.equal(f.dispatch.slots.get('A').ready,false);
 assert.equal(f.monitor.status('A').failureCount,1);
 assert.equal(f.monitor.status('B').error,null);f.monitor.close();
});

test('closing monitor fences a late healthy observation',async()=>{
 const f=fixture();let resolve;
 f.client.status=slot=>slot==='A'?new Promise(r=>{resolve=r;}):Promise.resolve({ready:true});
 f.monitor.tick();const a=f.monitor.running.get('A');
 await f.monitor.running.get('B');f.monitor.close();resolve({ready:true});await a;
 assert.deepEqual(f.updates,['B']);
});

test('account change during a probe cannot apply stale health to replacement',async()=>{
 const f=fixture();let resolve;
 f.client.status=slot=>slot==='A'?new Promise(r=>{resolve=r;}):Promise.resolve({ready:true});
 f.monitor.tick();const a=f.monitor.running.get('A');
 await f.monitor.running.get('B');f.dispatch.pool.slots.get('A').current=3;
 resolve({ready:true});await a;assert.deepEqual(f.updates,['B']);f.monitor.close();
});

test('catalog start on B is independent of a catalog operation on A',async()=>{
 const f=fixture();let refreshed;
 f.catalogs.jobs.set('A',{});
 f.dispatch.slots.get('B').workerEpoch='epoch-b';
 f.catalogs.cache.set('B',{account:2,workerEpoch:'epoch-b',observedAt:Date.now(),syncing:false});
 f.catalogs.start=async slot=>{refreshed=slot;};
 f.monitor.tick();await Promise.all(f.monitor.running.values());
 assert.equal(refreshed,'B');f.monitor.close();
});

test('catalog reads deduplicate and late response after timeout cannot publish stale cache',async()=>{
 const f=fixture();let release,calls=0;
 const catalogs=new CatalogController({...f,call:()=>{calls++;return new Promise(r=>{release=r;});},timeoutMs:15});
 const first=catalogs.read('A'),second=catalogs.read('A');
 const result=await Promise.allSettled([first,second]);
 assert.equal(calls,1);assert(result.every(r=>r.status==='rejected'));
 release({account:1,workerEpoch:'old'});await new Promise(r=>setImmediate(r));
 assert.equal(catalogs.cache.has('A'),false);assert.equal(catalogs.reading.size,0);
 catalogs.call=async()=>({account:1,workerEpoch:'fresh'});
 await catalogs.read('A');assert.equal(catalogs.cache.get('A').workerEpoch,'fresh');
});

test('catalog POST timeout retains durable uncertainty and slot lease',async()=>{
 const f=fixture();f.scheduler.executing=new Set();
 const epoch='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 f.client.status=async()=>({ready:true,busy:false,quarantined:false,activeRequests:0,browserOperations:0,cooldownUntil:0,workerEpoch:epoch});
 const catalogs=new CatalogController({...f,call:()=>new Promise(()=>{}),timeoutMs:15});
 const result=await catalogs.start('A');
 assert.equal(result.pending,true);assert.equal(f.dispatch.operations.has('A'),true);
 assert.equal(f.dispatch.slots.get('A').catalogTask.sent,true);
 assert.equal(catalogs.jobs.get('A').phase,'uncertain');
 assert.equal(f.dispatch.slots.get('B').ready,true);
});
