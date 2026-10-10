'use strict';
const test=require('node:test'),a=require('node:assert/strict'),{randomUUID}=require('crypto');
const {DispatchCore}=require('./dispatch-core'),{AccountPool}=require('../code/account-pool'),{RotationController}=require('./rotation-controller');
const OLD='a'.repeat(64),NEW='b'.repeat(64);
function fixture(){
 const pool=new AccountPool([1,2,3,4]);for(const [slot,id] of [['A',1],['B',2]]){pool.slots.set(slot,{current:id,pending:null});pool.owners.set(id,slot);}
 const d=new DispatchCore(pool,()=>{});for(const id of pool.ids)d.quotas.account(id,true);
 const epoch=randomUUID();
 const log=[];let running=true,label='1',id=OLD;
 const driver={validateAccount(){},
  describe:async()=>({Id:id,Config:{Labels:{'operit.account':label}},State:{Running:running,Pid:running?9:0,Status:running?'running':'exited'}}),
  stop:async slot=>{log.push('stop:'+slot);running=false;},
  inspect:async()=>({id,running,processesStopped:!running}),
  prepare:async(slot,acc)=>{log.push('prepare:'+acc);},
  start:async(slot,acc)=>{log.push('start:'+acc);label=String(acc);id=NEW;running=true;},
  restartStopped:async(slot,acc,cid)=>{log.push('restart:'+acc);a.equal(cid,OLD);running=true;},
  waitReady:async(slot,acc)=>({account:acc,workerEpoch:epoch,executionProtocol:2,ready:true,busy:false,activeRequests:0,browserOperations:0,quarantined:false,hardQuarantine:false,pendingCompletions:0})};
 const r=new RotationController(d,driver);return {d,r,log};
}
function busy(f){
 const s=f.d.slots.get('A'),rid=randomUUID();
 s.active=1;s.requests.add(rid);s.executions[rid]={id:rid,slot:'A',account:1,phase:'running'};s.ready=false;
 f.r.failures.set('A',{reason:'old',retryAt:Date.now()+999999});
 f.d.rotationThrottle={lastAt:Date.now()};
}
test('manual rotate ignores interval, block, unready and in-flight requests',async()=>{
 const f=fixture();busy(f);f.d.pool.cooldowns.set(3,Date.now()+86400000);
 const res=f.r.forceRotate('A',3);a.equal(res.account,3);a.equal(res.activeRequests,1);await res.done;
 a.equal(f.r.manual.get('A').phase,'ok',f.r.manual.get('A').error);a.equal(f.r.manual.get('A').interrupted,1);
 a.equal(f.d.pool.slots.get('A').current,3);a.equal(f.d.slots.get('A').active,0);a.equal(f.d.operations.has('A'),false);a.equal(f.r.running.has('A'),false);
 a.deepEqual(f.log,['stop:A','prepare:3','start:3']);a.equal(f.r.failures.has('A'),false);
 a.equal(f.d.pool.slots.get('B').current,2);
});
test('manual restart keeps account and clears its cooldown',async()=>{
 const f=fixture();busy(f);f.d.pool.cooldowns.set(1,Date.now()+86400000);
 const res=f.r.forceRestart('A');await res.done;
 a.equal(f.r.manual.get('A').phase,'ok',f.r.manual.get('A').error);
 a.equal(f.d.pool.slots.get('A').current,1);a.equal(f.d.pool.cooldowns.has(1),false);a.deepEqual(f.log,['stop:A','restart:1']);
});
test('only concrete conflicts are reported',()=>{
 const f=fixture();
 a.throws(()=>f.r.forceRotate('A',2),/正被实例 B 使用/);
 f.d.accountFlags[4]={status:'invalid'};a.throws(()=>f.r.forceRotate('A',4),/已标记失效/);
 const lease=f.d.operations.acquire('A','auth');a.throws(()=>f.r.forceRestart('A'),/保存登录态/);f.d.operations.release(lease);
 a.equal(f.log.length,0);
});
test('automatic rotation keeps the global interval',()=>{
 const f=fixture();f.d.rotationThrottle={lastAt:Date.now()};a.match(f.r.gate('A'),/5 minutes/);
});
