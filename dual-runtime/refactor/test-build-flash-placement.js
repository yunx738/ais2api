'use strict';
// Build flash requests land on standard (Free) accounts first; Pro/Ultra only when the Free side can't take it.
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {AccountPool}=require('../code/account-pool');
const {DispatchCore}=require('./dispatch-core');
function setup(){
 const pool=new AccountPool([1,2]);
 for(const [slot,account] of [['A',1],['B',2]]){pool.slots.set(slot,{current:account,pending:null});pool.owners.set(account,slot);}
 const d=new DispatchCore(pool,()=>{});for(const id of pool.ids)d.quotas.account(id,true);
 d.slotLimit=()=>4;
 for(const [slot,account] of [['A',1],['B',2]])d.update(slot,{account,workerEpoch:randomUUID(),ready:true,busy:false,browserOperations:0,activeRequests:0,quarantined:false});
 return d;
}
const premium=id=>id===2; // B holds the Ultra account
function buildPlan(flash,cap){
 const busy=new Map();
 return {model:'build-x',quotaFamily:'ultra',
  ...(flash?{rank:(slot,account)=>premium(account)?1:0}:{}),
  admit(account){const n=busy.get(account)||0;if(n>=cap(account))return false;busy.set(account,n+1);return true;}};
}
test('flash: free account first regardless of the round-robin cursor',()=>{
 const d=setup();
 for(const cursor of [0,1,0,1]){d.cursor=cursor;const t=d.acquire(randomUUID(),buildPlan(true,()=>1));assert.equal(t.slot,'A');}
});
test('flash: falls back to the premium account when the free one is full',()=>{
 const d=setup(),p=buildPlan(true,()=>1);d.cursor=1;
 assert.equal(d.acquire(randomUUID(),p).slot,'A');
 assert.equal(d.acquire(randomUUID(),p).slot,'B');
});
test('no rank (pro / normal traffic): round robin unchanged',()=>{
 const d=setup(),p=buildPlan(false,()=>5),got=[];
 for(let i=0;i<4;i++)got.push(d.acquire(randomUUID(),p).slot);
 assert.deepEqual(got,['A','B','A','B']);
});
test('a throwing rank is treated as equal and does not break admission',()=>{
 const d=setup();
 const t=d.acquire(randomUUID(),{model:'build-x',quotaFamily:'ultra',rank:()=>{throw Error('x');},admit:()=>true});
 assert.ok(t);
});
test('BuildChannel attaches rank only for flash models',()=>{
 const fs=require('fs'),os=require('os'),path=require('path');
 const {BuildChannel}=require('./build-coordinator');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bfp-'));
 fs.writeFileSync(path.join(dir,'a.json'),JSON.stringify({1:'d5df4c44-02ed-4b2f-b71a-34fbc28e8861',2:'d5df4c44-02ed-4b2f-b71a-34fbc28e8862'}));
 const c=new BuildChannel({appsFile:path.join(dir,'a.json'),ledgerFile:path.join(dir,'l.json'),tierOf:id=>id===2?'ultra':'standard',isPremium:premium,log:{warn(){},error(){},info(){}}});
 const body=m=>JSON.stringify({model:m,messages:[{role:'user',content:'hi'}]});
 const f=c.resolve('/v1/chat/completions',body('build/gemini-3.8-flash-low'),{allowUnavailable:true});
 assert.equal(typeof f.rank,'function');assert.equal(f.rank('A',1),0);assert.equal(f.rank('B',2),1);
 const models=require('./build-routing').listModels().filter(m=>!/flash/.test(m));
 if(models.length){const p=c.resolve('/v1/chat/completions',body(models[0]),{allowUnavailable:true});assert.equal(p.rank,undefined);}
});
