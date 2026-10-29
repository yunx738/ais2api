'use strict';
const test=require('node:test'),assert=require('assert'),fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','code','unified-server.runtime.js'),'utf8');
const a=src.indexOf('const AT = (function');const b=src.indexOf('})();',a)+5;
const AT=new Function(src.slice(a,b)+'\nreturn AT;')();
AT.AT_EMPTY_RETRY_DELAY_MS=5;
const ms=src.indexOf('  async _atContinueUntilAnswer(');const me=src.indexOf('  _getKeepAliveChunk(req)',ms);
const obj=new Function('AT','return {'+src.slice(ms,me)+'};')(AT);
const text=n=>'x'.repeat(n);
const round=(finish,chars,extra={})=>({candidates:[{finishReason:finish,content:{parts:chars?[{text:text(chars)}]:[]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:chars},...extra});
const empty=()=>({usageMetadata:{promptTokenCount:100}});
const answer=n=>({candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:'emit_answer',args:{answer:text(n)}}}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:n}});
function mk(replies){const sent=[];const logs=[];
 const h=Object.assign(Object.create(obj),{logger:{info:m=>logs.push(m),warn:m=>logs.push(m)},_atWaitOperationDone:async()=>true,_generateRequestId:()=>'c'+sent.length,
  _forwardRequest(r){sent.push(JSON.parse(r.body));},
  connectionRegistry:{createMessageQueue:()=>{let i=0;const reply=replies.shift();return {dequeue:async()=>{i++;if(i===1)return {event_type:'header'};if(i===2)return {event_type:'chunk',data:JSON.stringify(reply)};return {type:'STREAM_END'};}};},removeMessageQueue(){}}});
 return {h,sent,logs};}
const res={destroyed:false,writableEnded:false,on(){},removeListener(){}};
const body={contents:[{role:'user',parts:[{text:'q'}]}],generationConfig:{maxOutputTokens:65536}};

test('STOP with 23663 chars of plain text and no emit_answer is accepted as the answer, no further upstream call',async()=>{
 const {h,sent,logs}=mk([]);const r=await h._atContinueUntilAnswer(round('STOP',23663),body,res,'anti-truncation/m','r',Date.now()-200000);
 assert.equal(r.answer.length,23663);assert.equal(r.finishReason,'STOP');assert.equal(sent.length,0);
 assert.equal(r.usageMetadata.promptTokenCount,100);assert.ok(logs.some(l=>/accepting plain text/.test(l)));
});
test('STOP with short plain text (<2000) still continues as before',async()=>{
 const {h,sent}=mk([answer(300)]);const r=await h._atContinueUntilAnswer(round('STOP',150),body,res,'anti-truncation/m','r',Date.now()-1000);
 assert.equal(r.answer.length,300);assert.equal(sent.length,1);assert.notDeepEqual(sent[0],body);
});
test('thought-only text does not count toward the STOP threshold',async()=>{
 const t={candidates:[{finishReason:'STOP',content:{parts:[{text:text(5000),thought:true}]}}],usageMetadata:{promptTokenCount:100}};
 const {h,sent}=mk([answer(10)]);const r=await h._atContinueUntilAnswer(t,body,res,'anti-truncation/m','r',Date.now()-1000);
 assert.equal(r.answer.length,10);assert.equal(sent.length,1);
});
test('empty upstream response: waits then resends the ORIGINAL request, then succeeds',async()=>{
 const {h,sent,logs}=mk([answer(400)]);const t0=Date.now();const r=await h._atContinueUntilAnswer(empty(),body,res,'anti-truncation/m','r',Date.now()-1000);
 assert.equal(r.answer.length,400);assert.equal(sent.length,1);assert.deepEqual(sent[0],body);assert.ok(Date.now()-t0>=5);
 assert.ok(logs.some(l=>/empty upstream response/.test(l)));
});
test('repeated empty responses: original request resent 3 times, then falls back to normal continuation (bounded)',async()=>{
 const {h,sent}=mk([empty(),empty(),empty(),answer(5)]);const r=await h._atContinueUntilAnswer(empty(),body,res,'anti-truncation/m','r',Date.now()-1000);
 assert.equal(r.answer.length,5);
 assert.deepEqual(sent.map(x=>JSON.stringify(x)===JSON.stringify(body)?'orig':'cont'),['orig','orig','orig','cont']);
});
test('empty response after 6 minutes is not resent',async()=>{
 const {h,sent}=mk([]);await h._atContinueUntilAnswer(empty(),body,res,'anti-truncation/m','r',Date.now()-361000).catch(()=>null);
 assert.ok(sent.every(x=>JSON.stringify(x)!==JSON.stringify(body)));
});
test('blocked prompt with no candidates is not treated as empty-retry',async()=>{
 const {h,sent}=mk([]);await h._atContinueUntilAnswer({promptFeedback:{blockReason:'SAFETY'},usageMetadata:{promptTokenCount:1}},body,res,'anti-truncation/m','r',Date.now()-1000).catch(()=>null);
 assert.ok(sent.every(x=>JSON.stringify(x)!==JSON.stringify(body)));
});
