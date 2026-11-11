'use strict';
const test=require('node:test'),assert=require('assert'),fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','code','unified-server.runtime.js'),'utf8');
const a=src.indexOf('const AT = (function');const b=src.indexOf('})();',a)+5;
const AT=new Function(src.slice(a,b)+'\nreturn AT;')();
const ms=src.indexOf('  async _atContinueUntilAnswer(');const me=src.indexOf('  _getKeepAliveChunk(req)',ms);
const obj=new Function('AT','return {'+src.slice(ms,me)+'};')(AT);
const text=n=>'x'.repeat(n);
const round=(finish,chars,extra={})=>({candidates:[{finishReason:finish,content:{parts:chars?[{text:text(chars)}]:[]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:chars},...extra});
const answer=(n)=>({candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:'emit_answer',args:{answer:text(n)}}}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:n}});
function mk(replies){const sent=[];const logs=[];
 const h=Object.assign(Object.create(obj),{logger:{info:m=>logs.push(m),warn:m=>logs.push(m)},_atWaitOperationDone:async()=>true,_generateRequestId:()=>'c'+sent.length,
  _forwardRequest(r){sent.push(JSON.parse(r.body));},
  connectionRegistry:{createMessageQueue:()=>{let i=0;const reply=replies.shift();return {dequeue:async()=>{i++;if(i===1)return {event_type:'header'};if(i===2)return {event_type:'chunk',data:JSON.stringify(reply)};return {type:'STREAM_END'};}};},removeMessageQueue(){}}});
 return {h,sent,logs};}
const res={destroyed:false,writableEnded:false,on(){},removeListener(){}};
const body={contents:[{role:'user',parts:[{text:'q'}]}],generationConfig:{maxOutputTokens:65536}};
test('15522 chars cut off by finish=OTHER within 6 minutes: original request resent, nothing partial returned',async()=>{
 const {h,sent,logs}=mk([answer(900)]);const r=await h._atContinueUntilAnswer(round('OTHER',15522),body,res,'anti-truncation/m','r',Date.now()-60000);
 assert.equal(sent.length,1);assert.deepEqual(sent[0],body,'retry uses the original request body');
 assert.equal(r.answer.length,900);assert.ok(!r.partial);
 assert.ok(logs.some(m=>/retrying original request 1\/3/.test(m)));
});
test('small output within 6 minutes: original request resent, tokens of both rounds counted',async()=>{
 const {h,sent}=mk([answer(500)]);const r=await h._atContinueUntilAnswer(round('OTHER',2070),body,res,'anti-truncation/m','r',Date.now()-60000);
 assert.equal(sent.length,1);assert.deepEqual(sent[0],body);
 assert.equal(r.answer.length,500);assert.equal(r.usageMetadata.promptTokenCount,200);
});
test('finish=OTHER after 16 minutes: fails as before, no retry (even with many chars)',async()=>{
 const {h,sent}=mk([]);
 await assert.rejects(h._atContinueUntilAnswer(round('OTHER',15522),body,res,'anti-truncation/m','r',Date.now()-961000),e=>e.message==='AT_upstream_finish_OTHER'&&e.atFinish.chars===15522);
 assert.equal(sent.length,0);
});
test('retries are capped at 3, then 502 as before',async()=>{
 const {h,sent}=mk([round('OTHER',12000),round('OTHER',10),round('OTHER',20000)]);
 await assert.rejects(h._atContinueUntilAnswer(round('OTHER',10),body,res,'anti-truncation/m','r',Date.now()-1000),e=>e.message==='AT_upstream_finish_OTHER');
 assert.equal(sent.length,3);for(const b of sent)assert.deepEqual(b,body);
});
test('16-minute limit during normal continuation still fails with AT_continue_deadline (no partial)',async()=>{
 const {h,sent}=mk([]);await assert.rejects(h._atContinueUntilAnswer(round('MAX_TOKENS',25432),body,res,'anti-truncation/m','r',Date.now()-968000),e=>e.message==='AT_continue_deadline'&&e.atFinish.timeLimit===true);
 assert.equal(sent.length,0);
});
test('content safety block is never retried or returned',async()=>{
 const {h,sent}=mk([]);await assert.rejects(h._atContinueUntilAnswer(round('SAFETY',20000),body,res,'anti-truncation/m','r',Date.now()-1000),e=>e.message==='AT_content_blocked');
 assert.equal(sent.length,0);
});
test('normal MAX_TOKENS within 6 minutes still continues (not retried from scratch)',async()=>{
 const {h,sent}=mk([answer(800)]);const r=await h._atContinueUntilAnswer(round('MAX_TOKENS',3000),body,res,'anti-truncation/m','r',Date.now()-1000);
 assert.equal(sent.length,1);assert.notDeepEqual(sent[0],body);assert.equal(r.answer.length,800);
});
