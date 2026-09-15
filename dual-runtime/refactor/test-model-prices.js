'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {ModelPriceStore:S}=require('./model-price-store');
const {RequestHistory:H}=require('./request-history');
const {normalizeUsage}=require('./usage-metrics');
const {randomUUID}=require('crypto');
const price=()=>({currency:'USD',inputPerMillion:2,outputPerMillion:8,cachedPerMillion:2,reasoningPerMillion:0,reasoningMode:'included'});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ais-price-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'prices.json');return {dir,file,s:new S(file)};
}
test('absent model prices stay absent; saving survives restart',t=>{
 const {file,s}=fixture(t);assert.equal(s.get('gemini-test'),undefined);
 s.set({model:'gemini-test',revision:0,price:price()});
 assert.equal(new S(file).get('gemini-test').inputPerMillion,2);
 assert.equal(fs.statSync(file).mode&0o777,0o600);
});
test('stale revision cannot overwrite price',t=>{
 const {s}=fixture(t);s.set({model:'gemini-test',revision:0,price:price()});
 assert.throws(()=>s.set({model:'gemini-test',revision:0,price:price()}),e=>e.statusCode===409);
 assert.equal(s.revision,1);
});
test('invalid prices, alias IDs and unsupported currencies are rejected',t=>{
 const {s}=fixture(t);
 for(const p of [{...price(),inputPerMillion:-1},{...price(),currency:'CNY'},{...price(),outputPerMillion:Infinity}]){
  assert.throws(()=>s.set({model:'gemini-test',revision:0,price:p}),e=>e.statusCode===400);
 }
 assert.throws(()=>s.set({model:'anti-truncation/gemini-test',revision:0,price:price()}));
 assert.equal(s.revision,0);
});
test('returned snapshots cannot mutate authoritative prices',t=>{
 const {s}=fixture(t);s.set({model:'gemini-test',revision:0,price:price()});
 const p=s.get('gemini-test');p.inputPerMillion=500;
 const snap=s.snapshot();snap.prices['gemini-test'].inputPerMillion=500;
 assert.equal(s.get('gemini-test').inputPerMillion,2);
});
test('corrupt price configuration is preserved',t=>{
 const {file}=fixture(t);fs.writeFileSync(file,'broken');
 assert.throws(()=>new S(file));assert.equal(fs.readFileSync(file,'utf8'),'broken');
});
test('disk failure blocks writes without silently adopting new rates',t=>{
 const {s,file}=fixture(t);s.file=path.join(file,'missing','price.json');
 assert.throws(()=>s.set({model:'gemini-test',revision:0,price:price()}),e=>e.statusCode===503);
 assert.equal(s.blocked,true);assert.equal(s.revision,0);
 assert.equal(s.get('gemini-test'),undefined);
});
test('historical request keeps admission-time price after price edit',async t=>{
 const {dir,s}=fixture(t);const model='gemini-test';
 s.set({model,revision:0,price:price()});
 const h=await new H(path.join(dir,'history')).init(),id=randomUUID();
 await h.begin({id,model,account:4,price:s.get(model)});
 s.set({model,revision:1,price:{...price(),outputPerMillion:80}});
 await h.finish(id,{outcome:'success',httpStatus:200,metrics:{
  usageComplete:true,transportComplete:true,
  usage:normalizeUsage({usage:{prompt_tokens:1000,completion_tokens:200,total_tokens:1200}})
 }});
 const row=h.list().items[0];
 assert.equal(row.cost.amount,0.0036);assert.equal(row.cost.priceRevision,'1');
 assert.equal(s.get(model).revision,'2');
});
