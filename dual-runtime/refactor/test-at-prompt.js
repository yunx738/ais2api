'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const {PassThrough,Writable}=require('stream'),{EventEmitter}=require('events'),{randomUUID}=require('crypto');
const {AtPromptStore,KEYS,DEFAULT}=require('./at-prompt-store');
const {ResponseMetrics}=require('./response-metrics');
const src=fs.readFileSync(path.join(__dirname,'..','code','unified-server.runtime.js'),'utf8');
const a=src.indexOf('const AT = (function');const b=src.indexOf('})();',a)+5;
const AT=new Function(src.slice(a,b)+'\nreturn AT;')();
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'atp-'));

test('store keys match the worker presets exactly',()=>{
 assert.deepEqual([...KEYS].sort(),Object.keys(AT.AT_PROMPTS).sort());
 assert.equal(DEFAULT,'classic');
});
test('store defaults to classic, persists a choice, rejects unknown keys',()=>{
 const d=tmp(),f=path.join(d,'at-prompt.json');
 try{
  const s=new AtPromptStore(f);assert.equal(s.get(),'classic');
  assert.equal(s.set({preset:'once'}).preset,'once');
  assert.equal(new AtPromptStore(f).get(),'once');
  assert.throws(()=>s.set({preset:'evil'}),e=>e.statusCode===400);
  assert.throws(()=>s.set({preset:'__proto__'}),e=>e.statusCode===400);
  assert.equal(new AtPromptStore(f).get(),'once');
  fs.writeFileSync(f,'{"preset":"gone"}');assert.equal(new AtPromptStore(f).get(),'classic');
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('classic preset injects exactly the original prompt and tool description',()=>{
 const g={contents:[{role:'user',parts:[{text:'q'}]}],systemInstruction:{parts:[{text:'SYS'}]}};
 AT.atInjectTools(g);
 assert.equal(g.tools[0].functionDeclarations[0].description,'Emit your final complete answer.');
 assert.ok(g.systemInstruction.parts[0].text.startsWith('SYS\n\n[SYSTEM CONSTRAINT] You have a tool named seal_final_reply.'));
 const g2={contents:[{role:'user',parts:[{text:'q'}]}]};AT.atInjectTools(g2,'nope');
 assert.equal(g2.systemInstruction.parts[0].text,g.systemInstruction.parts[0].text.slice(3));
});
test('each preset injects its own hint and description, tool name and schema unchanged',()=>{
 for(const k of Object.keys(AT.AT_PROMPTS)){
  const g={contents:[{role:'user',parts:[{text:'q'}]}]};AT.atInjectTools(g,k);
  const d=g.tools[0].functionDeclarations[0];
  assert.equal(d.name,'seal_final_reply');assert.deepEqual(d.parameters.required,['answer']);
  assert.equal(d.description,AT.AT_PROMPTS[k].desc);
  assert.equal(g.systemInstruction.parts[0].text,AT.AT_PROMPTS[k].hint);
  assert.ok(/seal_final_reply/.test(AT.AT_PROMPTS[k].hint)&&!/emit_answer/.test(AT.AT_PROMPTS[k].hint));
 }
});
async function forward(options){
 let sent;
 const res=new Writable({write(c,e,d){d();}});res.setHeader=()=>{};res.on('error',()=>{});
 const http={request(opts,cb){sent=opts;const o=new EventEmitter();o.destroy=()=>{};o.end=()=>setImmediate(()=>{const r=new PassThrough();r.statusCode=200;r.headers={'content-type':'application/json'};cb(r);r.end('{}');});return o;}};
 const sb={module:{exports:{}},Buffer,setTimeout,clearTimeout,require:n=>{if(n==='http')return http;if(n==='./response-metrics')return {ResponseMetrics};throw Error(n);}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'forward-worker.js'),'utf8'),sb);
 await sb.module.exports.forwardWorker({slot:'B',id:randomUUID(),workerEpoch:randomUUID(),admissionDeadline:Date.now()+30000},'/v1/chat/completions',Buffer.from('{}'),res,{api:'x',control:'y'},options);
 return sent.headers;
}
test('forwarder sends X-AT-Prompt only for a well-formed preset key',async()=>{
 assert.equal((await forward({atPrompt:'once'}))['X-AT-Prompt'],'once');
 assert.equal((await forward({}))['X-AT-Prompt'],undefined);
 assert.equal((await forward({atPrompt:'bad\r\nX-Evil: 1'}))['X-AT-Prompt'],undefined);
});

test('tool renamed to seal_final_reply; old final_answer and emit_answer calls still accepted', () => {
 const ok=n=>AT.atExtractAnswer({candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:n,args:{answer:'hi'}}}]}}]});
 assert.deepEqual(ok('seal_final_reply'),{found:true,answer:'hi',finishReason:'STOP'});
 assert.deepEqual(ok('final_answer'),{found:true,answer:'hi',finishReason:'STOP'});
 assert.deepEqual(ok('emit_answer'),{found:true,answer:'hi',finishReason:'STOP'});
 assert.equal(ok('other').found,false);
 assert.equal(AT.AT_TOOL_NAME,'seal_final_reply');
 const g=AT.atInjectTools({contents:[{role:'user',parts:[{text:'x'}]}],tools:[{functionDeclarations:[{name:'emit_answer'}]}]},'once');
 assert.equal(g.tools.length,1);
});

test('text pseudo call with the new name is cleaned too', () => {
 const body=Array.from({length:40},(_,i)=>'line '+i+' of the answer').join('\n');
 const r=AT.atCleanPlainAnswer(body+'\n\n[{"name": "seal_final_reply", "arguments": {"answer": "'+body.replace(/\n/g,'\\n')+'"}}]');
 assert.equal(r.answer.trim(),body);
});
