'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {AtPromptStore,DEFAULTS,KEYS}=require('./at-prompt-store');
const src=fs.readFileSync(path.join(__dirname,'..','code','unified-server.runtime.js'),'utf8');
const a=src.indexOf('const AT = (function');const b=src.indexOf('})();',a)+5;
const AT=new Function(src.slice(a,b)+'\nreturn AT;')();
const m=src.indexOf('  async _atContinueUntilAnswer(');const e=src.indexOf('\n  _getKeepAliveChunk(',m);
const body=src.slice(m,e).replace('async _atContinueUntilAnswer(','async function _at(');
const run=new Function('AT',body+'\nreturn _at;')(AT);
const log={info(){},warn(){}};
function ctx(next){let n=0;return {logger:log,_generateRequestId:()=>'c'+(++n),_atWaitOperationDone:async()=>true,
 _forwardRequest(){},_cancelBrowserRequest(){},connectionRegistry:{removeMessageQueue(){},createMessageQueue(){const q=[{event_type:'h'}];const r=next();q.push({event_type:'chunk',data:JSON.stringify(r)},{type:'STREAM_END'});return {dequeue:async()=>q.shift()};}},calls:0};}
const res=()=>{const r=new (require('events').EventEmitter)();r.destroyed=false;r.writableEnded=false;return r;};
const seal=(ans,finish,extra=[])=>({candidates:[{finishReason:finish,content:{parts:[{functionCall:{name:'seal_final_reply',args:{answer:ans}}},...extra]}}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1}});
test('complete seal call then text cut (finish OTHER / MAX_TOKENS) returns the tool content, no continuation',async()=>{
 for(const f of ['OTHER','MAX_TOKENS',undefined]){
  let asked=0;const c=ctx(()=>{asked++;return seal('x','STOP');});
  const r=await run.call(c,seal('THE FULL ANSWER',f,[{text:'half of a tail'}]),{contents:[]},res(),'anti-truncation/m','r1');
  assert.equal(r.answer,'THE FULL ANSWER');assert.equal(asked,0,String(f));
 }
});
test('only half plain text, no seal call, cut: nothing is returned as answer',async()=>{
 let asked=0;const c=ctx(()=>{asked++;return {candidates:[{finishReason:'OTHER',content:{parts:[{text:'half again'}]}}]};});
 let out;try{out=await run.call(c,{candidates:[{finishReason:'OTHER',content:{parts:[{text:'half'}]}}]},{contents:[]},res(),'anti-truncation/m','r1',Date.now());}catch(err){out=err;}
 assert.ok(out===null||out instanceof Error,'must not return partial text');
 if(out&&out.answer)assert.fail('partial returned');
});
test('empty seal answer is not accepted as complete',async()=>{
 const c=ctx(()=>seal('REAL','STOP'));
 const r=await run.call(c,seal('  ','OTHER'),{contents:[{role:'user',parts:[{text:'q'}]}]},res(),'anti-truncation/m','r1');
 assert.equal(r.answer,'REAL');
});
test('safety block after a seal call is still a block',async()=>{
 const c=ctx(()=>seal('x','STOP'));
 await assert.rejects(run.call(c,seal('A','SAFETY'),{contents:[]},res(),'anti-truncation/m','r1'),/AT_content_blocked/);
});
test('bridge: upstream cut after a complete seal call is not a 504',()=>{
 assert.ok(/upstream cut after a complete seal call/.test(src));
 const i=src.indexOf('upstream cut after a complete seal call'),j=src.indexOf("status: 'UPSTREAM_CUT'");
 assert.ok(i>0&&j>i,'seal check runs before the UPSTREAM_CUT reply');
});
test('defaults file matches worker built-in prompts exactly',()=>{
 for(const k of Object.keys(AT.AT_PROMPTS)){
  assert.equal(AT.atFill(DEFAULTS.presets[k].desc),AT.AT_PROMPTS[k].desc,k);
  assert.equal('\n\n'+AT.atFill(DEFAULTS.presets[k].hint),AT.AT_PROMPTS[k].hint,k);
 }
 assert.equal(DEFAULTS.cont,AT.AT_CONT_DEFAULT);
 const g={contents:[]};const c=AT.atBuildContinuationBody(g,{candidates:[]},'P');
 assert.equal(c.contents.at(-1).parts[0].text,'Your previous seal_final_reply call was incomplete or missing. Previous partial answer: P\n\nCall seal_final_reply again with the COMPLETE final answer (key "answer").');
});
test('custom prompt: injected with {tool} filled, continuation uses custom cont',()=>{
 const custom={desc:'D {tool}',hint:'H use {tool}',cont:'C {tool} {partial}END'};
 const raw=Buffer.from(JSON.stringify(custom)).toString('base64');
 const dec=AT.atDecodeCustom(raw);assert.deepEqual(dec,custom);
 const g={contents:[{role:'user',parts:[{text:'q'}]}]};AT.atInjectTools(g,'custom',dec);
 assert.equal(g.tools[0].functionDeclarations[0].description,'D seal_final_reply');
 assert.equal(g.systemInstruction.parts[0].text,'\n\nH use seal_final_reply');
 assert.equal(JSON.stringify(g).includes('__atCont'),false);
 const c=AT.atBuildContinuationBody(g,{candidates:[]},'X');
 assert.equal(c.contents.at(-1).parts[0].text,'C seal_final_reply Previous partial answer: X\n\nEND');
 assert.equal(AT.atDecodeCustom('bad'),null);
 assert.equal(AT.atDecodeCustom(Buffer.from(JSON.stringify({desc:'',hint:'h',cont:''})).toString('base64')),null);
});
test('store: custom save, header, export/import round trip, validation',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'atp-'));const f=path.join(d,'a.json');
 try{
  const s=new AtPromptStore(f);assert.ok(KEYS.includes('custom'));
  assert.throws(()=>s.set({preset:'custom'}),er=>er.statusCode===400);
  s.set({preset:'custom',custom:{desc:'d',hint:'h {tool}',cont:'c'}});
  assert.equal(s.get(),'custom');assert.deepEqual(JSON.parse(Buffer.from(s.header(),'base64')),{desc:'d',hint:'h {tool}',cont:'c'});
  const ex=s.export();assert.equal(ex.format,'ais2api-at-prompt');
  const s2=new AtPromptStore(path.join(d,'b.json'));s2.import(JSON.parse(JSON.stringify(ex)));
  assert.equal(s2.get(),'custom');assert.equal(s2.custom.hint,'h {tool}');
  s2.set({preset:'once'});assert.equal(s2.header(),null);assert.equal(s2.custom.hint,'h {tool}');
  assert.throws(()=>s2.import({foo:1}),er=>er.statusCode===400);
  assert.throws(()=>s2.set({preset:'custom',custom:{desc:'d',hint:'x'.repeat(7000),cont:''}}),er=>er.statusCode===400);
  assert.equal(new AtPromptStore(f).get(),'custom');
  const st=s.status();assert.ok(st.presets.find(p=>p.key==='once').hint.includes('{tool}'));
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
