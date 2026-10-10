'use strict';
const test=require('node:test'),assert=require('node:assert'),fs=require('fs'),os=require('os'),path=require('path');
const {BrowserLease}=require('./browser-lease');
const {SlotOperations}=require('./slot-operations');
const tick=()=>new Promise(r=>setTimeout(r,20));
function fixture(file){
 const ids={A:'a'.repeat(64),B:'b'.repeat(64)},acct={A:10,B:22},running={A:true,B:true},calls=[];
 const slots=new Map(['A','B'].map(s=>[s,{active:0,requests:new Set(),executions:{},retirements:{},ready:true}]));
 const dispatch={slots,operations:new SlotOperations(),halted:false,checkpoint(){},update(s){slots.get(s).ready=true;},
  pool:{slots:new Map(['A','B'].map(s=>[s,{current:acct[s]}]))}};
 const driver={describe:async s=>({Id:ids[s],Config:{Labels:{'operit.account':String(acct[s])}},State:{Running:running[s]}}),
  stop:async s=>{calls.push('stop '+s);running[s]=false;},restartStopped:async(s,a,id)=>{assert.equal(id,ids[s]);calls.push('start '+s);running[s]=true;}};
 const client={waitReady:async(s,a)=>({account:a})};
 const rotation={running:new Set(),ready:()=>true};
 const scheduler={pump(){}};
 const lease=new BrowserLease({dispatch,driver,client,rotation,scheduler,isStopping:()=>false,file});
 return {lease,dispatch,running,calls};
}
const until=async f=>{for(let i=0;i<100&&!f();i++)await tick();assert.ok(f());};
test('single mode parks one worker, login pauses the only one, dual restores',async()=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'rm-')),'run-mode.json');
 const f=fixture(file);
 assert.equal(f.lease.modeStatus().phase,'dual');
 const m=f.lease.setMode({single:true});
 assert.equal(m.parked,'B');
 await until(()=>f.lease.modeStatus().phase==='parked');
 assert.equal(f.running.B,false);assert.equal(f.running.A,true);
 assert.ok(f.dispatch.operations.has('B'));
 const got=await f.lease.acquire('t');
 assert.equal(got.slot,'A');assert.equal(f.running.A,false);
 assert.throws(()=>f.lease.setMode({single:false}),/登录进行中/);
 await f.lease.release(false);
 assert.equal(f.running.A,true);assert.equal(f.running.B,false);
 // restart: mode persisted and re-parks without stopping again
 const g=fixture(file);g.running.B=false;g.lease.init();
 await until(()=>g.lease.modeStatus().phase==='parked');
 assert.deepEqual(g.calls,[]);
 g.lease.setMode({single:false});
 await until(()=>g.lease.modeStatus().phase==='dual');
 assert.equal(g.running.B,true);assert.ok(!g.dispatch.operations.has('B'));
 assert.equal(JSON.parse(fs.readFileSync(file)).single,false);
});
test('dual mode pauses the unusable worker instead of refusing',async()=>{
 const f=fixture(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'rm-')),'m.json'));
 f.dispatch.slots.get('A').ready=false;
 const first=await f.lease.acquire('x');assert.equal(first.slot,'A');
 await f.lease.release(false);
 f.dispatch.slots.get('A').ready=true;
 const got=await f.lease.acquire('x');assert.equal(got.slot,'B');
 await f.lease.release(false);assert.equal(f.running.B,true);
});
test('single mode refuses login before parking completes',async()=>{
 const f=fixture(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'rm-')),'m.json'));
 f.dispatch.slots.get('B').active=1;
 f.lease.setMode({single:true});
 await assert.rejects(f.lease.acquire('x'),/切换中|尚未就绪/);
 f.dispatch.slots.get('B').active=0;
 await until(()=>f.lease.modeStatus().phase==='parked');
});
