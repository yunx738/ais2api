'use strict';
// Build anti-truncation: reply-file discovery, page download, fallback to chat, coordinator switch.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {EventEmitter}=require('events');
const Doc=require('./build-document');
const {pack,prepare}=require('./build-context');
const W=require('./build-worker');
// Real generation response (flash, file written) captured on 2026-11-04.
const fixture=fs.readFileSync(path.join(__dirname,'fixtures','build','fx-flash-document.txt'),'utf8');
const NAME='__bridge_reply_1bcdd33bc66a7c7be8b89bb1.txt';
const HASH='000d228af29990ff8312f86dbd546d453dab0903b24ac1e5a7f319dabce3bfc5';
const APP='d5df4c44-02ed-4b2f-b71a-34fbc28e8861';
function fakeRes(){
 const r=new EventEmitter();r.statusCode=200;r.headers={};r.headersSent=false;r.destroyed=false;r.writableEnded=false;
 r.status=c=>{r.statusCode=c;return r;};r.setHeader=(k,v)=>{r.headers[k.toLowerCase()]=v;};
 r.json=b=>{r.body=b;r.headersSent=true;r.writableEnded=true;r.emit('finish');};
 r.end=s=>{r.text=s;r.headersSent=true;r.writableEnded=true;r.emit('finish');};
 return r;
}
// page.evaluate: 1st call = generation, later calls = document download.
function system(gen,download){
 const calls=[];let n=0;
 const page={isClosed:()=>false,evaluate:async(fn,code)=>{calls.push(code);return n++===0?gen:(typeof download==='function'?download(code):download);}};
 const s={browserManager:{page,context:null},requestHandler:{processOpenAIRequest:async()=>{}}};
 const warn=[];W.install(s,{log:{info(){},warn:m=>warn.push(m)}});
 return {s,calls,warn};
}
const body=document=>({model:'build/gemini-3.8-flash-low',messages:[{role:'user',content:'hi'}],__build:{app:APP,model:'gemini-3.8-flash',thinking:1,...(document?{document}:{})}});
(async()=>{
 // names and hash discovery
 assert.ok(Doc.NAME.test(Doc.documentName()));
 assert.throws(()=>Doc.instruction('../x.txt'));
 assert.strictEqual(Doc.findHash(fixture,NAME),HASH);
 assert.strictEqual(Doc.findHash(fixture,'__bridge_reply_'+'0'.repeat(24)+'.txt'),null);
 assert.strictEqual(Doc.findHash('not json',NAME),null);
 assert.throws(()=>Doc.readExpression('bad',HASH));
 assert.ok(Doc.readExpression(APP,HASH).includes('/_/upload/'));
 assert.ok(Doc.isAck('DONE')&&Doc.isAck(' done. ')&&Doc.isAck('')&&!Doc.isAck('## 标题\n正文'));
 // prompt: off = unchanged wording, on = file instruction and no conflicting rule
 const p=prepare([{role:'user',content:'hi'}]);
 const off=pack(p,{nonce:'1'.repeat(24)}).parts.at(-1)[1],on=pack(p,{nonce:'1'.repeat(24),document:NAME});
 assert.ok(off.includes('Do not edit project files. ')&&off.includes('Return the complete answer directly'));
 assert.ok(on.document===NAME&&on.parts.at(-1)[1].includes('write the complete answer into the UTF-8 project file '+NAME));
 assert.ok(!on.parts.at(-1)[1].includes('Do not edit project files. ')&&!on.parts.at(-1)[1].includes('Return the complete answer directly'));
 // worker: file found and verified -> file text is the reply
 const gen=JSON.stringify({s:200,stage:'stream',tries:1,t:fixture});
 let t=system(gen,JSON.stringify({s:200,len:12,ok:true,text:'完整的文件正文'})),res=fakeRes();
 await t.s.requestHandler.processOpenAIRequest({body:body(NAME)},res);
 assert.strictEqual(res.statusCode,200);assert.strictEqual(res.body.choices[0].message.content,'完整的文件正文');
 assert.ok(t.calls[0].includes(NAME)&&t.calls[1].includes(HASH)&&t.calls[1].includes(APP));
 // worker: download fails and chat is only DONE -> 502, no silent "DONE" reply
 t=system(gen,JSON.stringify({s:404,ok:false}));res=fakeRes();
 await t.s.requestHandler.processOpenAIRequest({body:body(NAME)},res);
 assert.strictEqual(res.statusCode,502);assert.strictEqual(res.body.error.code,'build_document_missing');
 assert.ok(t.warn.some(m=>m.includes('reason=read_404')));
 // worker: no file written but chat has the answer -> chat text is used
 const chatOnly=fs.readFileSync(path.join(__dirname,'fixtures','build','fx-flash-text.txt'),'utf8');
 t=system(JSON.stringify({s:200,stage:'stream',tries:1,t:chatOnly}),()=>{throw Error('must not download');});res=fakeRes();
 await t.s.requestHandler.processOpenAIRequest({body:body(NAME)},res);
 assert.strictEqual(res.statusCode,200);assert.strictEqual(res.body.choices[0].message.content,'PONG 42');
 assert.strictEqual(t.calls.length,1);assert.ok(t.warn.some(m=>m.includes('reason=no_file')));
 // worker: switch off (no document) -> one page call, old prompt
 t=system(gen,()=>{throw Error('must not download');});res=fakeRes();
 await t.s.requestHandler.processOpenAIRequest({body:body(null)},res);
 assert.strictEqual(t.calls.length,1);assert.ok(!t.calls[0].includes('__bridge_reply_'));
 // invalid names from the coordinator are ignored
 t=system(gen,()=>{throw Error('must not download');});res=fakeRes();
 await t.s.requestHandler.processOpenAIRequest({body:body('../etc/passwd')},res);
 assert.strictEqual(t.calls.length,1);assert.ok(!t.calls[0].includes('passwd'));
 // switch: default off, code/ excluded, persisted, rejects bad input
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bdoc-')),file=path.join(dir,'build-document.json');
 let sw=new Doc.DocumentSwitch(file);
 assert.strictEqual(sw.status().enabled,false);assert.ok(!sw.uses('build/'));
 sw.set({enabled:true});
 assert.ok(sw.uses('build/')&&sw.uses('build-st/')&&sw.uses('bridge/')&&!sw.uses('code/'));
 sw.set({prefixes:{'bridge/':false}});assert.ok(!sw.uses('bridge/'));
 assert.throws(()=>sw.set({enabled:'yes'}),e=>e.statusCode===400);
 assert.throws(()=>sw.set({prefixes:{'evil/':true}}),e=>e.statusCode===400);
 sw=new Doc.DocumentSwitch(file);assert.ok(sw.uses('build/')&&!sw.uses('bridge/')&&!sw.uses('code/'));
 fs.rmSync(dir,{recursive:true,force:true});
 console.log('build-document: all tests passed');
})().catch(e=>{console.error(e);process.exit(1);});
