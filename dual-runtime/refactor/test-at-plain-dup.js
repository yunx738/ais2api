'use strict';
const test=require('node:test'),assert=require('assert'),fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','code','unified-server.runtime.js'),'utf8');
const a=src.indexOf('const AT = (function');const b=src.indexOf('})();',a)+5;
const AT=new Function(src.slice(a,b)+'\nreturn AT;')();
const body=Array.from({length:60},(_,i)=>'「台词'+i+'」\n☆‹「セリフ'+i+'」›\n「译文'+i+'，"引号"」').join('\n');
const esc=JSON.stringify(body).slice(1,-1);
test('answer then pseudo call emit_answer({"answer":...}) as text -> one readable copy',()=>{
 const r=AT.atCleanPlainAnswer(body+'\n\nemit_answer({"answer": "'+esc+'"})');
 assert.equal(r.answer,body);assert.equal(r.info.how,'decoded-call');
});
test('answer then bare JSON object in a code fence -> one readable copy',()=>{
 const r=AT.atCleanPlainAnswer(body+'\n```json\n{"answer": "'+esc+'"}\n```');
 assert.equal(r.answer,body);
});
test('answer then unterminated escaped call (cut off) -> decoded text kept',()=>{
 const r=AT.atCleanPlainAnswer(body+'\nemit_answer({"answer":"'+esc.slice(0,esc.length-40));
 assert.ok(r.answer.length>body.length*0.8);assert.ok(!/\\n/.test(r.answer));
});
test('answer then escaped copy with no marker -> escaped tail cut',()=>{
 const r=AT.atCleanPlainAnswer(body+'\n'+esc);
 assert.equal(r.answer,body);assert.equal(r.info.how,'cut-escaped-tail');
});
test('normal plain answer stays untouched',()=>{
 const r=AT.atCleanPlainAnswer(body);assert.equal(r.answer,body);assert.equal(r.info.how,'as-is');
});
test('answer that merely mentions \\n a few times stays untouched',()=>{
 const t=body+'\n用 \\n 表示换行，例如 a\\nb。';const r=AT.atCleanPlainAnswer(t);assert.equal(r.answer,t);
});
test('small JSON example inside a long answer does not replace the answer',()=>{
 const t=body+'\n示例：{"answer": "ok"}\n'+body;const r=AT.atCleanPlainAnswer(t);
 assert.ok(r.answer.length>=body.length);assert.notEqual(r.answer,'ok');
});
test('answer then text pseudo call with marker and name/arguments wrapper -> one readable copy, marker removed',()=>{
 const r=AT.atCleanPlainAnswer(body+'\n</aftertalk>\n\u25c1\u0927\u094d\u092f\u093e\u0928\u25b7[{"name": "emit_answer", "arguments": {"answer": "'+esc+'"}}]');
 assert.equal(r.info.how,'decoded-call');assert.equal(r.answer,body);assert.ok(!/\u25c1/.test(r.answer));
});
test('truncated second copy shorter than the first -> keep the complete first copy',()=>{
 const r=AT.atCleanPlainAnswer(body+'\n\u25c1x\u25b7[{"name": "emit_answer", "arguments": {"answer": "'+esc.slice(0,esc.length/2));
 assert.equal(r.answer,body);assert.equal(r.info.how,'cut-before-call');
});
