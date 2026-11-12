'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const AT=require('./headless-at');

test('anti-truncation caps per-round max_tokens to 32768 and passes external tool_calls through',async()=>{
 const seen=[];
 const r=await AT.run({
  body:{model:'gemini-4-argon',max_tokens:65535,tools:[{type:'function',function:{name:'read_file',parameters:{type:'object'}}}],messages:[{role:'user',content:'hi'}]},
  call:async b=>{seen.push(b.max_tokens);return {status:200,json:{choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'read_file',arguments:'{"p":"x"}'}}]}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}};}
 });
 assert.equal(r.ok,true);
 assert.equal(r.rounds,1);
 assert.deepEqual(seen,[32768]);
 assert.equal(r.toolCalls?.length,1);
 assert.equal(r.toolCalls[0].function.name,'read_file');
});

test('anti-truncation extracts partial answer from truncated seal_final_reply JSON',async()=>{
 const bodies=[];let k=0;
 const r=await AT.run({
  body:{model:'gemini-4-carbon',messages:[{role:'user',content:'long'}]},
  call:async b=>{
   bodies.push(b);k++;
   if(k===1)return {status:200,json:{choices:[{finish_reason:'length',message:{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'seal_final_reply',arguments:'{"answer":"part_one_abc'}}]}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}};
   return {status:200,json:{choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'c2',type:'function',function:{name:'seal_final_reply',arguments:'{"answer":"part_one_abc_done"}'}}]}}],usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50}}};
  }
 });
 assert.equal(r.ok,true);
 assert.equal(r.rounds,2);
 assert.equal(r.answer,'part_one_abc_done');
 assert.equal(bodies[1].max_tokens,32768);
});

const cut=s=>({status:200,json:{choices:[{finish_reason:'length',message:{role:'assistant',content:null,tool_calls:[{id:'c',type:'function',function:{name:'seal_final_reply',arguments:'{"answer":"'+s}}]}}],usage:{prompt_tokens:10,completion_tokens:32768,total_tokens:32778}}});
const sealOk=s=>({status:200,json:{choices:[{finish_reason:'stop',message:{role:'assistant',content:null,tool_calls:[{id:'d',type:'function',function:{name:'seal_final_reply',arguments:JSON.stringify({answer:s})}}]}}],usage:{prompt_tokens:10,completion_tokens:100,total_tokens:110}}});
const quiet={info(){},warn(){}};
test('mergeSegments drops repeated overlap',()=>{
 assert.equal(AT.mergeSegments('abc 第一段结尾的句子在这里。','第一段结尾的句子在这里。第二段'),'abc 第一段结尾的句子在这里。第二段');
 assert.equal(AT.mergeSegments('前文','后文'),'前文后文');
 assert.equal(AT.mergeSegments('x',''),'x');
 const a='甲'.repeat(300);assert.equal(AT.mergeSegments(a,a+'乙乙'),a+'乙乙');
});
test('a cut answer is kept, only the rest is asked for, then joined',async()=>{
 const p1='段落一。'.repeat(100)+'\\n第一部分最后一句话写到这里';const bodies=[];
 const r=await AT.run({log:quiet,body:{messages:[{role:'user',content:'w'}]},call:async b=>{bodies.push(JSON.stringify(b));return bodies.length===1?cut(p1):sealOk('最后一句话写到这里，然后是第二部分。');}});
 assert.equal(r.ok,true);assert.equal(r.rounds,2);assert.equal(r.finish,undefined);
 assert.ok(r.answer.startsWith('段落一。')&&r.answer.endsWith('第一部分最后一句话写到这里，然后是第二部分。'),r.answer.slice(-40));
 assert.ok(bodies[1].includes('Do NOT repeat')&&!bodies[1].includes('Previous partial answer')&&!bodies[1].includes('"tool_calls"'));
});
test('continuation failure or repeated cuts return the kept text with finish length',async()=>{
 const p1='已经写好的正文。'.repeat(60);let k=0;
 let r=await AT.run({log:quiet,body:{messages:[{role:'user',content:'w'}]},call:async()=>(k++===0?cut(p1):{status:502,json:{error:{message:'boom'}}})});
 assert.equal(r.ok,true);assert.equal(r.finish,'length');assert.equal(r.answer,p1);
 k=0;r=await AT.run({log:quiet,body:{messages:[{role:'user',content:'w'}]},call:async()=>cut(('第'+(k++)+'段').repeat(80))});
 assert.equal(r.ok,true);assert.equal(r.finish,'length');assert.equal(r.rounds,5);
 assert.ok(r.answer.includes('第0段')&&r.answer.includes('第4段'));
});
