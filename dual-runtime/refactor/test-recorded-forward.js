'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRecordedForward:create}=require('./recorded-forward');
const ticket={id:'test-id',model:'gemini-test-flash',account:4,slot:'A',workerEpoch:'epoch'};
function fake(){
 const calls=[];
 return {calls,async begin(v){calls.push(['begin',v]);},async finish(id,v){calls.push(['finish',id,v]);},status(){return {ready:true};}};
}
function invoke(f,body={model:'anti-truncation/gemini-test-flash',stream:true,messages:[{content:'PRIVATE'}]}){
 return f(ticket,'/v1/chat/completions',Buffer.from(JSON.stringify(body)),{}, {api:'SECRET'});
}
test('canonical model and alias are recorded without prompt or credentials',async()=>{
 const h=fake(),result={status:200,metrics:{transportComplete:true}};
 const f=create({history:h,forward:async()=>result});
 assert.equal(await invoke(f),result);
 assert.equal(h.calls[0][1].requestedModel,'anti-truncation/gemini-test-flash');
 assert.equal(h.calls[0][1].model,ticket.model);
 assert.equal(h.calls[1][2].outcome,'success');
 assert.equal(JSON.stringify(h.calls).includes('PRIVATE'),false);
 assert.equal(JSON.stringify(h.calls).includes('SECRET'),false);
});
test('begin failure is visible without duplicate forwarding',async()=>{
 const h=fake();h.begin=async()=>{throw Error('disk');};let forwarded=0;
 const f=create({history:h,forward:async()=>{forwarded++;return {status:200};}});
 await invoke(f);
 assert.equal(forwarded,1);assert.equal(h.calls.length,0);
 assert.equal(f.status().beginFailures,1);
});
test('finish failure does not replace response result',async()=>{
 const h=fake();h.finish=async()=>{throw Error('disk');};
 const result={status:429,retryAfter:'60'};
 const f=create({history:h,forward:async()=>result});
 assert.equal(await invoke(f),result);assert.equal(f.status().finishFailures,1);
});
test('thrown forward error is preserved while uncertainty is recorded',async()=>{
 const h=fake(),error=Error('transport');
 const f=create({history:h,forward:async()=>{throw error;}});
 await assert.rejects(invoke(f),e=>e===error);
 assert.equal(h.calls[1][2].outcome,'uncertain');
});
test('200 application errors and disconnected streams are not successes',async()=>{
 for(const [result,expected] of [
  [{status:200,metrics:{applicationError:true,transportComplete:true}},'application_error'],
  [{cancelled:true},'cancelled'],
  [{status:200,metrics:{transportComplete:false}},'uncertain'],
  [{status:403},'http_error']
 ]){
  const h=fake();await invoke(create({history:h,forward:async()=>result}));
  assert.equal(h.calls[1][2].outcome,expected);
 }
});
test('request history never mutates execution ticket',async()=>{
 const h=fake(),before=JSON.stringify(ticket);
 await invoke(create({history:h,forward:async()=>({status:200})}));
 assert.equal(JSON.stringify(ticket),before);
});

test('continuation usage is not presented as a verified aggregate',async()=>{
 const h=fake();
 const result={status:200,metrics:{transportComplete:true,usageComplete:true,usage:{input:10,output:20}}};
 const f=create({history:h,forward:async()=>result});
 const actual=await invoke(f);
 assert.equal(actual,result);
 assert.equal(result.metrics.usageComplete,true);
 assert.equal(h.calls[1][2].metrics.usageComplete,false);
 assert.equal(h.calls[1][2].metrics.usage.output,20);
});
test('ordinary model usage completeness is preserved',async()=>{
 const h=fake();
 const result={status:200,metrics:{transportComplete:true,usageComplete:true}};
 await invoke(create({history:h,forward:async()=>result}),{model:'gemini-test-flash'});
 assert.equal(h.calls[1][2].metrics.usageComplete,true);
});
