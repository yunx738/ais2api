
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {randomUUID}=require('crypto');
const {DispatchCore}=require('./dispatch-core');
const {save}=require('./dispatch-state');
const {restore}=require('./restore-dispatch');
const {CatalogRouting}=require('./catalog-routing');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ais-quota-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json');
 const pool={ids:[4,5,6],cursor:0,sequence:0,slots:new Map([['A',{current:4}],['B',{current:5}]]),
  cooldowns:new Map(),owners:new Map([[4,'A'],[5,'B']])};
 pool.commit=ticket=>{pool.owners.delete(pool.slots.get(ticket.slot).current);pool.slots.set(ticket.slot,{current:ticket.id});pool.owners.set(ticket.id,ticket.slot);};
 const d=new DispatchCore(pool,x=>save(x,file));
 for(const id of pool.ids)d.quotas.account(id,true);
 for(const [slot,owner] of pool.slots){
  const s=d.slots.get(slot);s.workerEpoch=randomUUID();s.ready=true;
 }
 return {d,file};
}
const plan=(model='gemini-3.8-flash',quotaFamily='flash')=>({model,quotaFamily});
const onlyA=slot=>slot==='A';
function release(d,ticket){
 d.finish(ticket,true);d.retire(ticket);d.slots.get(ticket.slot).ready=true;
}
test('admission persists canonical model charge and execution intent in one checkpoint',t=>{
 const {d,file}=fixture(t),id=randomUUID();
 const ticket=d.acquire(id,plan(),onlyA),raw=JSON.parse(fs.readFileSync(file));
 assert.equal(raw.version,2);
 assert.equal(raw.quotaLedger.accounts['4'].models[ticket.model].used,1);
 const execution=new Map(raw.dispatch.slots).get('A').executions[id];
 assert.equal(execution.model,ticket.model);assert.equal(execution.account,4);
 assert.equal(execution.kind,'flash');assert.equal(execution.workerEpoch,ticket.workerEpoch);
 assert.throws(()=>d.acquire(id,plan(),onlyA),/Duplicate/);
 assert.equal(d.quotas.view(4,ticket.model,'flash').used,1);
});
test('restart retains uncertain occupancy, retirement intent and quota without a second charge',t=>{
 const {d,file}=fixture(t),ticket=d.acquire(randomUUID(),plan(),onlyA);
 const recovered=restore(file),s=recovered.slots.get('A');
 assert.equal(s.ready,false);assert.equal(s.active,1);
 assert.equal(s.executions[ticket.id].phase,'reconciling');
 assert.equal(recovered.quotas.view(4,ticket.model,'flash').used,1);
 recovered.finish(ticket,true);
 assert.throws(()=>recovered.acquire(ticket.id,plan(),onlyA),/Duplicate/);
 const again=restore(file);
 assert.equal(again.slots.get('A').active,0);
 assert.equal(again.slots.get('A').retirements[ticket.id].model,ticket.model);
 assert.equal(again.quotas.view(4,ticket.model,'flash').used,1);
 again.retire(ticket);
 assert.equal(restore(file).quotas.view(4,ticket.model,'flash').used,1);
});
test('exhausted Pro model does not block another Pro or Flash model',t=>{
 const {d}=fixture(t);
 for(let i=0;i<10;i++)release(d,d.acquire(randomUUID(),plan('gemini-2.5-pro','pro'),onlyA));
 assert.equal(d.acquire(randomUUID(),plan('gemini-2.5-pro','pro'),onlyA),undefined);
 const second=d.acquire(randomUUID(),plan('gemini-3.1-pro-preview','pro'),onlyA);
 assert(second);release(d,second);
 assert(d.acquire(randomUUID(),plan(),onlyA));
 assert.equal(d.quotas.view(4,'gemini-2.5-pro','pro').used,10);
 assert.equal(d.quotas.view(4,'gemini-3.1-pro-preview','pro').used,1);
});
test('ownership changes and subsequent restore preserve every account balance',t=>{
 const {d,file}=fixture(t),ticket=d.acquire(randomUUID(),plan(),onlyA);
 release(d,ticket);d.commitRotation({slot:'A',id:6},true);
 d.slots.get('A').ready=true;
 release(d,d.acquire(randomUUID(),plan(),onlyA));
 d.commitRotation({slot:'A',id:4},true);
 const restored=restore(file);
 assert.equal(restored.pool.slots.get('A').current,4);
 assert.equal(restored.quotas.view(4,ticket.model,'flash').used,1);
 assert.equal(restored.quotas.view(6,ticket.model,'flash').used,1);
});
test('checkpoint failure halts dispatch and returns no executable ticket',t=>{
 const {d}=fixture(t);d.persist=()=>{throw Error('disk failure');};
 assert.throws(()=>d.acquire(randomUUID(),plan(),onlyA),/disk failure/);
 assert.equal(d.halted,true);assert.equal(d.slots.get('A').active,1);
 assert.equal(d.quotas.view(4,'gemini-3.8-flash','flash').used,1);
 assert.equal(d.acquire(randomUUID(),plan(),onlyA),undefined);
});
test('native URL and anti-truncation alias resolve to the same canonical quota',t=>{
 const {d}=fixture(t),model='gemini-3.8-flash',now=Date.now();
 const cache=new Map([['A',{account:4,workerEpoch:d.slots.get('A').workerEpoch,
  observedAt:now,syncing:false,snapshot:{account:4,stale:false,updatedAt:now,
   models:[{id:model,methods:['generateContent']}]}}]]);
 const routing=new CatalogRouting(d,{cache},{[model]:{quotaFamily:'flash',antiTruncation:true}});
 const a=routing.resolve('/v1/chat/completions',{model:'anti-truncation/'+model});
 const b=routing.resolve('/v1beta/models/'+model+':generateContent',{});
 assert.equal(a.model,b.model);assert.equal(a.quotaFamily,'flash');
 release(d,d.acquire(randomUUID(),a,a.eligible));
 release(d,d.acquire(randomUUID(),b,b.eligible));
 assert.equal(d.quotas.view(4,model,'flash').used,2);
 assert.deepEqual(Object.keys(d.quotas.snapshot().accounts['4'].models),[model]);
});
test('legacy checkpoint cannot silently start with empty model quota ledger',t=>{
 const {d,file}=fixture(t);d.checkpoint();
 const raw=JSON.parse(fs.readFileSync(file));raw.version=1;delete raw.quotaLedger;
 fs.writeFileSync(file,JSON.stringify(raw));
 assert.throws(()=>restore(file),/migration required/);
});
