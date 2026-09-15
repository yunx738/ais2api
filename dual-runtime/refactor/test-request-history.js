'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs/promises'),os=require('os'),path=require('path'),{randomUUID}=require('crypto');
const {RequestHistory:H}=require('./request-history');
const {normalizeUsage}=require('./usage-metrics');
async function fixture(t,opts={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ais-history-test-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return {dir,h:await new H(dir,opts).init()};
}
const record=()=>({id:randomUUID(),model:'gemini-test-flash',account:4,slot:'A'});
test('atomic records survive restart; pending is not fabricated success',async t=>{
 const {dir,h}=await fixture(t);const r=record();await h.begin(r);
 const recovered=await new H(dir).init();
 assert.equal(recovered.list().items[0].outcome,'pending');
 assert.equal(recovered.summary().pending,1);
 assert.equal((await fs.stat(path.join(dir,r.id+'.json'))).mode&0o777,0o600);
});
test('duplicate begin and finish are idempotent',async t=>{
 const {h}=await fixture(t);const r=record();
 await Promise.all([h.begin(r),h.begin(r)]);
 await h.finish(r.id,{outcome:'success'});await h.finish(r.id,{outcome:'http_error'});
 assert.equal(h.list().total,1);assert.equal(h.summary().success,1);
 await assert.rejects(h.begin({...r,account:5}),/conflict/);
});
test('body, credentials and raw errors never persist',async t=>{
 const {dir,h}=await fixture(t);const r=record();
 await h.begin({...r,body:'PRIVATE',apiKey:'SECRET'});
 await h.finish(r.id,{outcome:'application_error',error:'PRIVATE',metrics:{secret:'SECRET',usage:{format:'openai',input:1,output:2,secret:'SECRET'}}});
 const text=await fs.readFile(path.join(dir,r.id+'.json'),'utf8');
 assert.equal(text.includes('PRIVATE'),false);assert.equal(text.includes('SECRET'),false);
});
test('filters, pagination and unknown statistics are explicit',async t=>{
 let now=1000;const {h}=await fixture(t,{clock:()=>now});
 for(let i=0;i<3;i++){const r=record();r.account=i===2?5:4;await h.begin(r);now++;}
 assert.equal(h.list({account:4,pageSize:1,page:2}).items.length,1);
 assert.equal(h.list({account:4}).total,2);
 const s=h.summary();assert.equal(s.tokenUnknownRequests,3);
 assert.equal(s.pricedRequests,0);assert.equal(s.averageDurationMs,null);
 assert.throws(()=>h.list({pageSize:1000}),/pagination/);
});
test('known totals and estimated costs remain separate from missing data',async t=>{
 const {h}=await fixture(t);const r=record();
 const price={currency:'USD',revision:'test',inputPerMillion:2,outputPerMillion:8,cachedPerMillion:2,reasoningPerMillion:null,reasoningMode:'included'};
 await h.begin({...r,price});
 await h.finish(r.id,{outcome:'success',httpStatus:200,metrics:{
  usageComplete:true,transportComplete:true,durationMs:100,
  usage:normalizeUsage({usage:{prompt_tokens:1000,completion_tokens:200,total_tokens:1200}})
 }});
 await h.begin(record());
 const s=h.summary();assert.equal(s.knownTokenTotal,1200);
 assert.equal(s.estimatedCostKnownSubtotal,0.0036);
 assert.equal(s.pricedRequests,1);assert.equal(s.unpricedRequests,1);
});
test('corrupt records fail startup without deletion',async t=>{
 const {dir}=await fixture(t);const file=path.join(dir,randomUUID()+'.json');
 await fs.writeFile(file,'{broken');
 await assert.rejects(new H(dir).init());
 assert.equal(await fs.readFile(file,'utf8'),'{broken');
});
test('disk failure is visible and does not clear in-memory history',async t=>{
 const {dir,h}=await fixture(t);const r=record();await h.begin(r);
 const moved=dir+'-moved';await fs.rename(dir,moved);
 try{
  await assert.rejects(h.finish(r.id,{outcome:'success'}),/persistence/);
  assert.equal(h.status().degraded,true);assert.equal(h.list().total,1);
 }finally{await fs.rename(moved,dir);}
});
