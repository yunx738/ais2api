'use strict';
// Build channel: text tool protocol (build-tools.js), code/ split, v2 plugin envelopes.
const assert=require('assert');
const T=require('./build-tools');
const C=require('./build-context');
const W={type:'function',function:{name:'get_weather',description:'天气',parameters:{type:'object',properties:{city:{type:'string'},days:{type:'integer'}},required:['city']}}};
const R={type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}};
const n='00aa11bb',open='<'+T.tag(n)+'>',close='</'+T.tag(n)+'>';
const block=o=>open+JSON.stringify(o)+close;

// normalize: tools / legacy functions / tool_choice
assert.strictEqual(T.normalize({}),null);
assert.strictEqual(T.normalize({tools:[]}),null);
let s=T.normalize({tools:[W,R]});
assert.deepStrictEqual([s.mode,s.parallel,s.tools.length],['auto',true,2]);
assert.strictEqual(T.normalize({tools:[W],tool_choice:'none'}).mode,'none');
assert.strictEqual(T.normalize({tools:[W],tool_choice:'required'}).mode,'required');
assert.deepStrictEqual((({mode,name})=>[mode,name])(T.normalize({tools:[W],tool_choice:{type:'function',function:{name:'get_weather'}}})),['named','get_weather']);
assert.strictEqual(T.normalize({functions:[W.function]}).tools[0].name,'get_weather');
assert.strictEqual(T.normalize({tools:[W],parallel_tool_calls:false}).parallel,false);
assert.throws(()=>T.normalize({tools:[W],tool_choice:{type:'function',function:{name:'nope'}}}),e=>e.statusCode===400);
assert.throws(()=>T.normalize({tools:[W,W]}),e=>e.statusCode===400);
assert.throws(()=>T.normalize({tools:[{type:'function',function:{name:'bad name!'}}]}),e=>e.statusCode===400);

// instructions: carry the nonce tag; none mode -> no instructions
assert.ok(T.instructions(s,n).includes(open));
assert.strictEqual(T.instructions(T.normalize({tools:[W],tool_choice:'none'}),n),'');

// extract: valid call, text before it kept
let r=T.extract('我查一下。\n'+block({name:'get_weather',arguments:{city:'东京'}}),s,n);
assert.strictEqual(r.content,'我查一下。');
assert.strictEqual(r.calls.length,1);
assert.deepStrictEqual(JSON.parse(r.calls[0].function.arguments),{city:'东京'});
assert.ok(/^call_[0-9a-f]{18}$/.test(r.calls[0].id));
// arguments given as a JSON string; code fence inside the block
r=T.extract(open+'```json\n{"name":"read_file","arguments":"{\\"path\\":\\"a.js\\"}"}\n```'+close,s,n);
assert.strictEqual(r.calls.length,1);assert.strictEqual(JSON.parse(r.calls[0].function.arguments).path,'a.js');
// two calls in parallel mode
r=T.extract(block({name:'get_weather',arguments:{city:'A'}})+'\n'+block({name:'read_file',arguments:{path:'b'}}),s,n);
assert.strictEqual(r.calls.length,2);
// invalid blocks: reply kept untouched, nothing thrown
for(const bad of [open+'{oops'+close,block({name:'nope',arguments:{}}),block({name:'get_weather',arguments:{}}),block({name:'get_weather',arguments:{city:3}})]){
 r=T.extract('正文'+bad,s,n);
 assert.strictEqual(r.calls.length,0);assert.strictEqual(r.content,'正文'+bad);assert.strictEqual(r.rejected.length,1);
}
// a tag with another nonce (e.g. inside a preset or history) is not a call
r=T.extract('<tool_call_ffffffff>'+JSON.stringify({name:'get_weather',arguments:{city:'x'}})+'</tool_call_ffffffff>',s,n);
assert.strictEqual(r.calls.length,0);
// no tools / mode none: text untouched
assert.strictEqual(T.extract('x'+block({name:'get_weather',arguments:{city:'x'}}),null,n).calls.length,0);
// parallel off: only the first call is accepted
r=T.extract(block({name:'get_weather',arguments:{city:'A'}})+block({name:'get_weather',arguments:{city:'B'}}),T.normalize({tools:[W],parallel_tool_calls:false}),n);
assert.strictEqual(r.calls.length,1);assert.strictEqual(r.rejected.length,1);
// named mode refuses another tool
r=T.extract(block({name:'read_file',arguments:{path:'x'}}),T.normalize({tools:[W,R],tool_choice:{type:'function',function:{name:'get_weather'}}}),n);
assert.strictEqual(r.calls.length,0);
// enum / integer checks
assert.strictEqual(T.checkArgs({type:'object',properties:{d:{type:'integer'}}},{d:1.5}),'参数 d 类型应为 integer');
assert.strictEqual(T.checkArgs({type:'object',properties:{u:{type:'string',enum:['c','f']}}},{u:'k'}),'参数 u 不在可选值内');
assert.strictEqual(T.checkArgs({type:'object',properties:{u:{type:['string','null']}}},{u:null}),null);

// flatten: history tool calls and results become text, nothing dropped
const hist=[{role:'user',content:'东京天气？'},{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'get_weather',arguments:'{"city":"东京"}'}}]},{role:'tool',tool_call_id:'c1',content:'晴 21度'}];
const f=T.flatten(hist);
assert.ok(f.changed);
assert.strictEqual(f.messages[1].content,'[tool call id=c1 name=get_weather] {"city":"东京"}');
assert.ok(!('tool_calls' in f.messages[1]));
assert.deepStrictEqual([f.messages[2].role,f.messages[2].name],['user','tool']);
assert.ok(f.messages[2].content.startsWith('[tool result id=c1 name=get_weather]\n'));
const p=C.classify(f.messages);
assert.strictEqual(p.dropped.toolCalls,0);assert.strictEqual(p.segments.length,3);

// code/ split: system + current request + live tool chain inline; older turns in the attachment
const big='x'.repeat(4*4000);
const agent=T.flatten([
 {role:'system',content:'You are a coding agent. Use tools.'},
 {role:'user',content:'旧任务'},{role:'assistant',content:'旧任务完成'},
 {role:'user',content:'修一下 a.js 的 bug'},
 {role:'assistant',content:null,tool_calls:[{id:'k1',type:'function',function:{name:'read_file',arguments:'{"path":"a.js"}'}}]},
 {role:'tool',tool_call_id:'k1',content:'const a=1;'},
 {role:'assistant',content:null,tool_calls:[{id:'k2',type:'function',function:{name:'read_file',arguments:'{"path":"big.log"}'}}]},
 {role:'tool',tool_call_id:'k2',content:big},
]).messages;
const cp=C.prepare(agent,{mode:'code'});
const where=cp.segments.map(x=>x.placement+':'+x.source);
assert.deepStrictEqual(where,['inline:codeSystem','file:history','file:history','inline:currentUser','inline:toolChain','inline:toolResult','inline:toolChain','file:toolResult']);
assert.strictEqual(cp.generationType,'normal');
// default split for the same request keeps the old behaviour (chain in the attachment)
assert.strictEqual(C.prepare(agent).segments.filter(x=>x.placement==='inline').length,2);
// over budget: large tool results move first, the current request stays inline
const huge=T.flatten([{role:'system',content:'rules'},{role:'user',content:'go'},
 {role:'assistant',content:null,tool_calls:[{id:'h',type:'function',function:{name:'read_file',arguments:'{"path":"x"}'}}]},
 {role:'tool',tool_call_id:'h',content:'y'.repeat(4*2900)},{role:'assistant',content:'z'.repeat(4*44000)}]).messages;
const hp=C.prepare(huge,{mode:'code'});
assert.ok(hp.inlineTokens<=C.LIMITS.inlineBudget);
assert.strictEqual(hp.segments.find(x=>x.source==='currentUser').placement,'inline');
// pack: code/ head + tool instructions come before the outline
const pk=C.pack(cp,{extra:T.instructions(s,n),code:true});
const prompt=pk.parts[pk.parts.length-1][1];
assert.ok(prompt.includes('coding-agent conversation'));
assert.ok(prompt.indexOf('[FUNCTION TOOLS]')<prompt.indexOf('[INLINE '));
assert.ok(!C.pack(C.prepare(agent),{}).parts.at(-1)[1].includes('[FUNCTION TOOLS]'));

// v2 plugin envelope (build-standalone 0.6.0): tool roles + messageMetadata kept as text in the attachment
const env=v=>[{role:'user',content:C.WIRE_PREFIX+JSON.stringify(v)}];
const v2=C.prepare(env({version:2,generationType:'normal',segments:[
 {message:0,part:0,role:'system',source:'main',placement:'inline',text:'规则'},
 {message:1,part:0,role:'assistant',source:'tool-history',placement:'file',text:''},
 {message:2,part:0,role:'tool',source:'tool-history',placement:'file',text:'晴'},
 {message:3,part:0,role:'user',source:'currentUser',placement:'inline',text:'然后呢'}],
 messageMetadata:[{message:1,contentNull:true,tool_calls:[{id:'c9',type:'function',function:{name:'get_weather',arguments:'{"city":"京都"}'}}]},{message:2,tool_call_id:'c9'}]}));
assert.strictEqual(v2.segments[1].text,'[tool call id=c9 name=get_weather] {"city":"京都"}');
assert.strictEqual(v2.segments[2].text,'[tool result id=c9]\n晴');
// metadata must point at attachment segments
assert.throws(()=>C.prepare(env({version:2,generationType:'normal',segments:[{message:0,part:0,role:'user',source:'currentUser',placement:'inline',text:'x'}],messageMetadata:[{message:0,tool_call_id:'a'}]})),e=>e.statusCode===400);
assert.throws(()=>C.prepare(env({version:3,generationType:'normal',segments:[{message:0,part:0,role:'user',source:'u',placement:'inline',text:'x'}]})),e=>e.statusCode===400);
console.log('test-build-tools ok');
