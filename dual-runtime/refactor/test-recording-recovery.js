'use strict';
const test=require('node:test'),assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {createRecordedForward}=require('./recorded-forward');
const {RequestHistory}=require('./request-history');
const AT=require(path.join(__dirname,'..','code','anti-truncation.js'));
test('a slow history write pauses recording only until it settles',async()=>{
 let release,begins=0;
 const history={begin:async()=>{begins++;if(begins===1)return new Promise(r=>{release=r;});},finish:async()=>{},status:()=>({ready:true})};
 const forward=createRecordedForward({history,recordTimeoutMs:10,forward:async()=>({status:200})});
 const args=[{model:'m',id:'x'},'/v1/chat/completions',Buffer.from('{}'),{},{}];
 await forward(...args);assert.equal(forward.status().recordingPaused,true);
 await forward(...args);assert.equal(begins,1,'paused while the slow write is still running');
 release();await new Promise(r=>setImmediate(r));
 assert.equal(forward.status().recordingPaused,false,'resumes once the write settles');
 await forward(...args);assert.equal(begins,2);
});
test('stale pending rows are closed as uncertain, fresh ones untouched',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hist-'));let now=1_000_000_000_000;
 const h=new RequestHistory(dir,{clock:()=>now});await h.init();
 const {randomUUID}=require('crypto');const a=randomUUID(),b=randomUUID();
 await h.begin({id:a,model:'gemini-4-argon',account:31,slot:'B'});
 now+=16*60000;await h.begin({id:b,model:'gemini-4-argon',account:31,slot:'B'});
 assert.equal(await h.expireStale(),1);
 const rows=h.list({}).items,ra=rows.find(r=>r.id===a),rb=rows.find(r=>r.id===b);
 assert.equal(ra.outcome,'uncertain');assert.equal(ra.metrics.errorKind,'stale_pending');assert.equal(rb.outcome,'pending');
 const disk=JSON.parse(fs.readFileSync(path.join(dir,a+'.json'),'utf8'));assert.equal(disk.phase,'finished');
 fs.rmSync(dir,{recursive:true,force:true});
});
test('anti-truncation early finish payload records reason and tokens, no content',()=>{
 const p=AT.atFinishPayload({reason:'OTHER',chars:7756,promptTokens:70811,outputTokens:5621},502);
 assert.equal(p.error.status,'FINISH_OTHER');assert.equal(p.error.type,'upstream_incomplete');
 assert.deepEqual(p.usage,{prompt_tokens:70811,completion_tokens:5621});
 assert.ok(!('choices' in p));
});
test('worker inline AT module exposes the same block/finish helpers',()=>{
 const fs=require('fs');const src=fs.readFileSync(path.join(__dirname,'..','code','unified-server.runtime.js'),'utf8');
 const start=src.indexOf('const AT = (function () {');const end=src.indexOf('})();',start)+5;
 const IAT=new Function(src.slice(start,end)+'\nreturn AT;')();
 for(const f of ['atBlockInfo','atBlockMessage','atBlockPayload','atFinishPayload'])assert.equal(typeof IAT[f],'function',f);
 const p=IAT.atFinishPayload({reason:'OTHER',round:1,chars:5,promptTokens:1,outputTokens:2},502);
 assert.equal(p.error.status,'FINISH_OTHER');assert.equal(p.choices,undefined);
});
test('anti-truncation stops continuing after 6 minutes and fails with AT_TIME_LIMIT',async()=>{
 const fs=require('fs');const src=fs.readFileSync(path.join(__dirname,'..','code','unified-server.runtime.js'),'utf8');
 const a=src.indexOf('const AT = (function');const b=src.indexOf('})();',a)+5;
 const AT=new Function(src.slice(a,b)+'\nreturn AT;')();
 assert.equal(AT.AT_CONTINUE_DEADLINE_MS,360000);
 const ms=src.indexOf('  async _atContinueUntilAnswer(');const me=src.indexOf('  _getKeepAliveChunk(req)',ms);
 const obj=new Function('AT','return {'+src.slice(ms,me)+'};')(AT);
 const round={candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'partial'}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:30000}};
 let forwarded=0;
 const mk=()=>Object.assign(Object.create(obj),{logger:{info(){},warn(){}},_atWaitOperationDone:async()=>true,_generateRequestId:()=>'c',
  _forwardRequest(){forwarded++;},connectionRegistry:{createMessageQueue:()=>({dequeue:async()=>{throw Error('stop here');}}),removeMessageQueue(){}}});
 const res={destroyed:false,writableEnded:false,on(){},removeListener(){}};
 await assert.rejects(mk()._atContinueUntilAnswer(round,{contents:[]},res,'anti-truncation/x','r',Date.now()-361000),
  e=>e.message==='AT_continue_deadline'&&e.atFinish.timeLimit===true&&e.atFinish.reason==='MAX_TOKENS'&&e.atFinish.chars===7);
 assert.equal(forwarded,0);
 const p=AT.atFinishPayload({reason:'MAX_TOKENS',chars:7,elapsedMs:361000,timeLimit:true,promptTokens:10,outputTokens:30000},502);
 assert.equal(p.error.status,'AT_TIME_LIMIT');assert.equal(p.choices,undefined);
 assert.equal(await mk()._atContinueUntilAnswer(round,{contents:[]},res,'anti-truncation/x','r',Date.now()-60000),null);
 assert.equal(forwarded,1);
});
test('maxOutputTokens is pinned to the model upstream limit and client values are ignored',()=>{
 const fs=require('fs');const src=fs.readFileSync(path.join(__dirname,'..','code','unified-server.runtime.js'),'utf8');
 const s=src.indexOf('  _modelOutputLimit(model) {');const e=src.indexOf('  _forwardRequest(proxyRequest) {',s);
 const obj=new Function('return (class {'+src.slice(s,e)+'}).prototype;')();
 const logs=[];const h=Object.assign(Object.create(obj),{logger:{info:m=>logs.push(m)},serverSystem:{modelCatalog:{status:()=>({snapshot:{models:[{id:'gemini-4-argon',methods:['generateContent'],outputTokenLimit:65536}]}})}}});
 const req=(model,body,ep='generateContent')=>({path:'/v1beta/models/'+model+':'+ep,body:JSON.stringify(body)});
 let r=req('gemini-4-argon',{contents:[],generationConfig:{maxOutputTokens:30000,temperature:1}});h._pinMaxOutputTokens(r);
 assert.deepEqual(JSON.parse(r.body).generationConfig,{maxOutputTokens:65536,temperature:1});
 r=req('gemini-4-argon',{contents:[],generation_config:{max_output_tokens:100}},'streamGenerateContent');h._pinMaxOutputTokens(r);
 assert.equal(JSON.parse(r.body).generation_config.maxOutputTokens,65536);assert.equal(JSON.parse(r.body).generation_config.max_output_tokens,undefined);
 r=req('gemini-4-argon',{contents:[]});h._pinMaxOutputTokens(r);assert.equal(JSON.parse(r.body).generationConfig.maxOutputTokens,65536);
 r=req('unknown-model',{contents:[],generationConfig:{maxOutputTokens:30000}});h._pinMaxOutputTokens(r);
 assert.equal(JSON.parse(r.body).generationConfig.maxOutputTokens,undefined);
 r={path:'/v1beta/models',body:''};h._pinMaxOutputTokens(r);assert.equal(r.body,'');
 assert(logs.some(m=>m.includes('client=30000 -> 65536')));
});

test('Google cut-off (no finishReason) fails fast as 504 and is never retried or cooled down', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../code/unified-server.runtime.js'), 'utf8');
  assert.ok(src.includes("window.__gcCall.v!==8") && src.includes("window.__gcCall.v=8;"));
  assert.ok(src.includes("gcbHx.visit = h['x-aistudio-visit-id']") && src.includes("if(hx.visit)hd['x-aistudio-visit-id']=hx.visit;"));
  assert.ok(src.includes('signal:ac.signal') && src.includes("hx.hardMs||660000"));
  assert.ok(src.includes("status: 'UPSTREAM_CUT'") && src.includes('upstream cut: no finishReason'));
  assert.ok(src.includes('GCB_HARD_MS + 30000'));
  const bb = fs.readFileSync(path.join(__dirname, 'black-browser.js'), 'utf8');
  assert.ok(bb.includes('[500, 502, 503].includes(error.status)') && !bb.includes('[500, 502, 503, 504].includes(error.status)'));
  const st = fs.readFileSync(path.join(__dirname, '../code/stability.js'), 'utf8');
  assert.ok(/UPSTREAM_CUT\|UPSTREAM_NO_RESPONSE\|UPSTREAM_CONNECTION_LOST/.test(st));
  // the in-page script really aborts and reports 504 when fetch never settles
  const a = src.indexOf("var ac=new AbortController()"); const fin = "finally{clearTimeout(wd);if(hx.op)delete ab_[hx.op];}"; const b = src.indexOf(fin, a) + fin.length; assert.ok(b > fin.length);
  const fn = new Function('fetch', 'base', 'hd', 'body', 'hx', 'tier', 'var window={}; return (async()=>{' + src.slice(a, b) + "return JSON.stringify({s:r.status,t:tx});})();");
  const hang = (u, o) => new Promise((_, rj) => o.signal.addEventListener('abort', () => rj(Object.assign(Error('aborted'), {name: 'AbortError'}))));
  return fn(hang, 'x', {}, [], {hardMs: 30}, null).then(out => { const o = JSON.parse(out); assert.equal(o.s, 504); assert.equal(JSON.parse(o.t).error.status, 'UPSTREAM_NO_RESPONSE'); })
    .then(() => fn(() => Promise.reject(Error('NetworkError when attempting to fetch resource.')), 'x', {}, [], {hardMs: 1000}, null)).then(out => { const o = JSON.parse(out); assert.equal(o.s, 504); assert.equal(JSON.parse(o.t).error.status, 'UPSTREAM_CONNECTION_LOST'); })
    .then(() => fn(async () => ({status: 200, text: async () => 'ok'}), 'x', {}, [], {hardMs: 1000}, null)).then(out => assert.deepEqual(JSON.parse(out), {s: 200, t: 'ok'}));
});

test('client cancel aborts the in-page Google call (also continuation rounds); legacy bodies untouched', async () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../code/unified-server.runtime.js'), 'utf8');
  // in-page: a running call registered under hx.op is aborted by __gcAbort and reports 499, not 504
  const a = src.indexOf("var ac=new AbortController()"); const fin = "finally{clearTimeout(wd);if(hx.op)delete ab_[hx.op];}"; const b = src.indexOf(fin, a) + fin.length;
  const g = src.indexOf('window.__gcAbort=function'); const ge = src.indexOf('return true;};', g) + 'return true;};'.length;
  const win = {};
  const fn = new Function('window', 'fetch', 'base', 'hd', 'body', 'hx', 'tier', src.slice(g, ge) + ' return {abort: window.__gcAbort, run: (async()=>{' + src.slice(a, b) + "return JSON.stringify({s:r.status,t:tx});})()};");
  let started; const hang = (u, o) => new Promise((_, rj) => { started = true; o.signal.addEventListener('abort', () => rj(Object.assign(Error('aborted'), {name: 'AbortError'}))); });
  const h = fn(win, hang, 'x', {}, [], {hardMs: 60000, op: 'g9'}, null);
  await new Promise(r => setImmediate(r)); assert.ok(started);
  assert.equal(h.abort('g9'), true);
  const o = JSON.parse(await h.run); assert.equal(o.s, 499); assert.equal(o.t, 'cancelled');
  assert.equal(h.abort('g9'), false, 'handle is removed once the call settles');
  // node side: request id is threaded through, legacy models are not tagged, cancel maps rid -> op
  assert.ok(src.includes("if (!gcbLegacy && typeof proxyRequest.request_id === 'string') body.__aisRid = proxyRequest.request_id;"));
  assert.ok(src.includes("delete g.__aisRid;") && src.includes('gcbOps.set(gcbRid, gcbOp)') && src.includes('if (gcbRid) gcbOps.delete(gcbRid);'));
  assert.ok(src.includes("window.wrappedJSObject.__gcAbort(o)") && src.includes('r.s === 499'));
  assert.ok(/_cancelBrowserRequest\(requestId\) \{\n\s+try \{ const bm = this\.browserManager/.test(src));
  // continuation rounds cancel their own id when the client leaves, and drop the listener afterwards
  assert.ok(src.includes('res.on("close", contOnClose);') && src.includes('res.removeListener("close", contOnClose);') && src.includes('this._cancelBrowserRequest(contId)'));
});
