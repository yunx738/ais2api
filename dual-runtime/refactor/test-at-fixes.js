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
 assert.ok(JSON.stringify(bodies[1].messages).includes('Previous partial answer: part_one_abc'));
});
