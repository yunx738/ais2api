'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ResponseMetrics:R}=require('./response-metrics');
test('JSON split at arbitrary bytes preserves usage and clears text',()=>{
 const r=new R();
 const b=Buffer.from(JSON.stringify({choices:[{message:{content:'私密中文'}}],usage:{prompt_tokens:10,completion_tokens:3}}));
 for(const byte of b)r.write(Buffer.from([byte]));
 const m=r.finish();
 assert.equal(m.usage.input,10);assert.equal(m.usage.output,3);
 assert.equal(r.buffer,'');assert.equal(JSON.stringify(m).includes('私密'),false);
});
test('SSE cumulative usage is not double counted',()=>{
 const r=new R({stream:true});
 for(const n of [1,2,3])r.write(`data: ${JSON.stringify({usage:{prompt_tokens:10,completion_tokens:n}})}\r\n\r\n`);
 r.write('data: [DONE]\n\n');
 const m=r.finish();assert.equal(m.usage.output,3);assert.equal(m.streamDoneSeen,true);
});
test('oversized SSE event is discarded but later usage survives',()=>{
 const r=new R({stream:true,maxBytes:120});
 r.write('data: '+ 'x'.repeat(1000));r.write('\n\n');
 r.write('data: {"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n');
 const m=r.finish();assert.equal(m.captureLimited,true);
 assert.equal(m.usage.input,9);assert.equal(m.usageComplete,false);
});
test('oversized JSON and missing usage remain unknown',()=>{
 const r=new R({maxBytes:16});r.write('x'.repeat(100));
 assert.equal(r.finish().usage,null);assert.equal(r.buffer,'');
});
test('disconnect does not claim final usage completeness',()=>{
 const r=new R({stream:true});
 r.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
 const m=r.finish({complete:false});
 assert.equal(m.usage.output,2);assert.equal(m.usageComplete,false);
 assert.equal(m.transportComplete,false);
});
test('HTTP 200 error payload is visible to observer',()=>{
 const r=new R({stream:true});r.write('data: {"error":{"message":"not persisted"}}\n\n');
 const m=r.finish();assert.equal(m.applicationError,true);
 assert.equal(JSON.stringify(m).includes('not persisted'),false);
});
test('first byte and first visible content have distinct timing',()=>{
 let now=100;const r=new R({stream:true,clock:()=>now});
 now=110;r.write(': heartbeat\n\n');
 now=125;r.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
 now=160;const m=r.finish();
 assert.equal(m.firstByteMs,10);assert.equal(m.firstContentMs,25);assert.equal(m.durationMs,60);
});
test('malformed stream and multiline SSE are handled without throwing',()=>{
 const r=new R({stream:true});r.write('data: not-json\n\n');
 r.write('data: {"usage":\ndata: {"prompt_tokens":4,"completion_tokens":2}}\n\n');
 const m=r.finish();assert.equal(m.malformed,true);assert.equal(m.usage.input,4);
});

test('clean response without usage does not claim complete usage',()=>{
 const r=new R();r.write('{}');
 assert.equal(r.finish().usageComplete,false);
});
test('finish is idempotent and never retains response text',()=>{
 const r=new R();r.write('{"usage":{"prompt_tokens":1,"completion_tokens":2}}');
 const a=r.finish();r.write('ignored');
 assert.deepEqual(r.finish(),a);assert.equal(r.buffer,'');assert.deepEqual(r.event,[]);
});
