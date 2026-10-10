'use strict';
const test=require('node:test'),a=require('node:assert/strict'),{randomUUID}=require('crypto');
const {DispatchCore}=require('./dispatch-core'),{AccountPool}=require('../code/account-pool'),{RotationController}=require('./rotation-controller'),{CoordinatorMonitor}=require('./coordinator-monitor');
function fixture(){
 const pool=new AccountPool([1,2,3]);for(const [slot,id] of [['A',1],['B',2]]){pool.slots.set(slot,{current:id,pending:null});pool.owners.set(id,slot);}
 const d=new DispatchCore(pool,()=>{});for(const id of pool.ids)d.quotas.account(id,true);
 const probe={account:1,workerEpoch:randomUUID(),executionProtocol:2,ready:false,busy:false,activeRequests:0,browserOperations:0,quarantined:false,hardQuarantine:false,pendingCompletions:0,cooldownUntil:Date.now()+86400000};
 d.update('A',probe);d.quotaExhausted=()=>true;
 let stopped=0;const driver={validateAccount(){},probeReady:async()=>probe,describe:async()=>({Id:'a'.repeat(64),Config:{Labels:{'operit.account':'1'}}}),
 stop:async()=>{stopped++;},inspect:async()=>({id:'a'.repeat(64),running:false,processesStopped:true}),prepare:async()=>{},start:async()=>{},waitReady:async()=>({...probe,account:3,ready:true,cooldownUntil:0})};
 const r=new RotationController(d,driver);return {d,r,driver,probe,stopped:()=>stopped};
}
test('idle unready worker can be manually switched with fresh re-probe',async()=>{const f=fixture();a.equal(f.r.preflight('A',3).available,true);const x=await f.r.rotate('A',true,3);a.equal(x.account,3);a.equal(f.stopped(),1);a.equal(f.d.pool.slots.get('B').current,2);});
test('unready without fresh positive idle evidence remains blocked',()=>{
 for(const patch of [{observedAt:Date.now()-7000},{account:99},{workerEpoch:randomUUID()},{busy:true},{activeRequests:1},{browserOperations:1},{pendingCompletions:1},{pendingCompletions:null},{quarantined:true},{hardQuarantine:true},{executionProtocol:undefined}]){const f=fixture();Object.assign(f.d.slots.get('A').workerHealth,patch);a.equal(f.r.preflight('A').available,false,JSON.stringify(patch));}
});
test('coordinator ledgers and outstanding lifecycle operations remain blocking',()=>{
 for(const key of ['rotation','recovery','proxyApply']){const f=fixture();f.d.slots.get('A')[key]={};a.equal(f.r.preflight('A').available,false);}
 for(const key of ['executions','retirements']){const f=fixture();f.d.slots.get('A')[key]={x:{}};a.equal(f.r.preflight('A').available,false);}
 const f=fixture();f.d.slots.get('A').requests.add('x');a.equal(f.r.preflight('A').available,false);
});
test('state becoming busy during fresh check cannot stop old worker',async()=>{const f=fixture();f.driver.probeReady=async()=>({...f.probe,busy:true});await a.rejects(f.r.rotate('A',true,3));a.equal(f.stopped(),0);a.equal(f.d.pool.slots.get('A').pending,null);a.equal(f.d.operations.has('A'),false);});
test('account cooldown auto-rotates even without a fresh model catalog',async()=>{
 const f=fixture();let called=false;f.r.rotate=async(slot,manual,target)=>{a.equal(slot,'A');a.equal(manual,false);a.equal(target,3);called=true;};
 const m=new CoordinatorMonitor({dispatch:f.d,client:{status:async()=>f.probe},catalogs:{jobs:new Map(),cache:new Map(),reconcile:async()=>{},read:async()=>{},start:async()=>{}},recovery:{check:async()=>{}},rotation:f.r,routing:{rotationPlan:()=>undefined},scheduler:{pendingPlans:()=>[],pump(){}}});
 await m.poll('A');a.equal(called,true);m.close();
});
