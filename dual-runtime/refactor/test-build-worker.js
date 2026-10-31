'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const {EventEmitter}=require('events');
const W=require('./build-worker');
const fixture=fs.readFileSync(path.join(__dirname,'fixtures','build','fx-flash-text.txt'),'utf8');
function fakeRes(){
 const r=new EventEmitter();r.statusCode=200;r.headers={};r.headersSent=false;r.destroyed=false;r.writableEnded=false;
 r.status=c=>{r.statusCode=c;return r;};r.setHeader=(k,v)=>{r.headers[k.toLowerCase()]=v;};
 r.json=b=>{r.body=b;r.headersSent=true;r.writableEnded=true;r.emit('finish');};
 r.end=s=>{r.text=s;r.headersSent=true;r.writableEnded=true;r.emit('finish');};
 return r;
}
function system(reply){
 const calls=[];
 const page={isClosed:()=>false,evaluate:async(fn,code)=>{calls.push(code);return typeof reply==='function'?reply(code):reply;}};
 let fallthrough=0;
 const s={browserManager:{page,context:null},requestHandler:{processOpenAIRequest:async()=>{fallthrough++;}}};
 W.install(s,{log:{info(){}}});
 return {s,calls,fall:()=>fallthrough};
}
const APP='d5df4c44-02ed-4b2f-b71a-34fbc28e8861';
(async()=>{
 // non-Build requests pass through untouched
 let t=system('{}');await t.s.requestHandler.processOpenAIRequest({body:{model:'gemini-3.8-flash',messages:[]}},fakeRes());assert.strictEqual(t.fall(),1);
 // success, non-stream
 t=system(JSON.stringify({s:200,stage:'stream',tries:1,t:fixture}));
 let res=fakeRes();
 await t.s.requestHandler.processOpenAIRequest({body:{model:'build/gemini-3.8-flash-low',messages:[{role:'system',content:'S'},{role:'user',content:'hi'}],max_tokens:50,__build:{app:APP,model:'gemini-3.8-flash',thinking:1}}},res);
 assert.strictEqual(res.statusCode,200);assert.strictEqual(res.body.choices[0].message.content,'PONG 42');
 assert.strictEqual(res.body.model,'build/gemini-3.8-flash-low');
 assert.deepStrictEqual(res.body.usage,{prompt_tokens:145021,completion_tokens:46,total_tokens:145067,prompt_tokens_details:{cached_tokens:17183}});
 assert.ok(t.calls[0].includes('"gemini-3.8-flash"')&&t.calls[0].includes(APP)&&t.calls[0].includes('Requested output limit: 50'));
 // success, stream
 t=system(JSON.stringify({s:200,stage:'stream',tries:1,t:fixture}));res=fakeRes();
 await t.s.requestHandler.processOpenAIRequest({body:{model:'build/gemini-3.8-flash',stream:true,messages:[{role:'user',content:'hi'}],__build:{app:APP,model:'gemini-3.8-flash',thinking:3}}},res);
 assert.strictEqual(res.headers['content-type'],'text/event-stream; charset=utf-8');assert.ok(res.text.includes('PONG 42')&&res.text.endsWith('data: [DONE]\n\n'));
 const last=JSON.parse(res.text.trim().split('\n\n').slice(-2)[0].slice(6));assert.strictEqual(last.choices[0].finish_reason,'stop');assert.ok(last.usage.total_tokens>0);
 // upstream 429 keeps status (scheduler can cool down / retry elsewhere)
 t=system(JSON.stringify({s:429,stage:'create',tries:1,t:'[8,"Resource exhausted"]'}));res=fakeRes();
 await t.s.requestHandler.processOpenAIRequest({body:{model:'build/gemini-4-argon',messages:[{role:'user',content:'x'}],__build:{app:APP,model:'gemini-4-argon',thinking:3}}},res);
 assert.strictEqual(res.statusCode,429);assert.strictEqual(res.headers['retry-after'],'60');
 // incomplete reply -> 502, never an empty 200
 const cut=JSON.stringify([[[null,null,[[[[[[null,'Hel']],'model']],null,null,null,null,null,null,null,null,null,null,1,1,'models/gemini-4-argon',null,null,'t']],'app']]]);
 t=system(JSON.stringify({s:200,stage:'stream',tries:1,t:cut}));res=fakeRes();
 await t.s.requestHandler.processOpenAIRequest({body:{model:'build/gemini-4-argon',messages:[{role:'user',content:'x'}],__build:{app:APP,model:'gemini-4-argon',thinking:3}}},res);
 assert.strictEqual(res.statusCode,502);assert.strictEqual(res.body.error.code,'build_incomplete');
 // oversize context rejected before the page is touched
 t=system('{}');res=fakeRes();
 await t.s.requestHandler.processOpenAIRequest({body:{model:'build/gemini-4-argon',messages:[{role:'system',content:'x'.repeat(260000)},{role:'user',content:'x'}],__build:{app:APP,model:'gemini-4-argon',thinking:3}}},res);
 assert.strictEqual(res.statusCode,413);assert.strictEqual(t.calls.length,0);
 // bad spec
 t=system('{}');res=fakeRes();
 await t.s.requestHandler.processOpenAIRequest({body:{model:'build/x',messages:[{role:'user',content:'x'}],__build:{app:'nope',model:'gemini-4-argon',thinking:3}}},res);
 assert.strictEqual(res.statusCode,400);assert.strictEqual(t.calls.length,0);
 console.log('build-worker: all tests passed');
})().catch(e=>{console.error(e);process.exit(1);});
