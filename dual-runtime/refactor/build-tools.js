'use strict';
// Function tools over the Build channel (text protocol; CodeAssistantOffline has no native tool fields).
// - Tool definitions + calling rules go to the composer.
// - Past assistant tool_calls / tool results are rendered as text so history is kept, not dropped.
// - The model calls a tool by ending its reply with tagged JSON blocks; the tag carries a per-request nonce,
//   so tool-like text inside presets or history is never mistaken for a call. Bad blocks fall back to text.
const crypto=require('crypto');
const MAX_TOOLS=128,MAX_SPEC_BYTES=256*1024;
const fail=(m,s=400)=>Object.assign(Error(m),{statusCode:s,code:'build_tools_invalid'});
// OpenAI tools / legacy functions -> {tools:[{name,description,parameters}], mode, name, parallel} or null.
function normalize(spec){
 if(!spec||typeof spec!=='object')return null;
 const list=[];
 const add=f=>{
  if(!f||typeof f.name!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(f.name))throw fail('工具名称无效：'+String(f&&f.name).slice(0,60));
  if(list.some(x=>x.name===f.name))throw fail('工具名称重复：'+f.name);
  list.push({name:f.name,description:typeof f.description==='string'?f.description:'',parameters:f.parameters&&typeof f.parameters==='object'?f.parameters:{type:'object',properties:{}}});
 };
 if(Array.isArray(spec.tools))for(const t of spec.tools){if(t&&t.type==='function'&&t.function)add(t.function);}
 if(Array.isArray(spec.functions))for(const f of spec.functions)add(f);
 if(!list.length)return null;
 if(list.length>MAX_TOOLS)throw fail('工具最多 '+MAX_TOOLS+' 个');
 let mode='auto',name=null;
 const c=spec.tool_choice!==undefined?spec.tool_choice:spec.function_call;
 if(c==='none')mode='none';
 else if(c==='required'||c==='any')mode='required';
 else if(c&&typeof c==='object'){
  name=c.function&&c.function.name||c.name||null;
  if(typeof name!=='string'||!list.some(t=>t.name===name))throw fail('指定的工具不存在：'+String(name).slice(0,60));
  mode='named';
 }
 return {tools:list,mode,name,parallel:spec.parallel_tool_calls!==false};
}
const nonce=()=>crypto.randomBytes(4).toString('hex');
const tag=n=>'tool_call_'+n;
// Composer text: tool list + calling rules. Returns '' when tools are disabled for this turn.
function instructions(spec,n){
 if(!spec||spec.mode==='none')return '';
 const t=tag(n);
 const defs=spec.tools.map(x=>({name:x.name,description:x.description||undefined,parameters:x.parameters}));
 const body=JSON.stringify(defs);
 if(Buffer.byteLength(body)>MAX_SPEC_BYTES)throw fail('工具定义超过 256 KiB',413);
 const rule={auto:'Call a tool only when it is needed; otherwise answer normally without any tool block.',
  required:'You must call at least one tool in this reply.',named:'You must call the tool "'+spec.name+'" in this reply.'}[spec.mode];
 return ['[FUNCTION TOOLS]',
  'The client application runs these functions on its own machine and sends back the results. They are not limited to this project workspace: when the user asks for something a function can do (files, commands, web, etc.), call it instead of refusing. Your built-in workspace (index.html, metadata.json, ...) is an unrelated sandbox: the user\'s real project and files are on the client and reachable only through these functions, so never answer from the sandbox or say a file does not exist without calling a function first. Definitions (JSON Schema parameters):',
  body,
  'To call a function, end your reply with one block per call, exactly in this form:',
  '<'+t+'>{"name":"FUNCTION_NAME","arguments":{...}}</'+t+'>',
  'Rules: '+rule+(spec.parallel?' Several blocks may follow each other.':' Use at most one block.')+
  ' Put any normal text before the blocks. The JSON must be valid; arguments must match the schema. Do not invent results: stop after the blocks and wait for the client.',
  'Earlier calls appear in the history as [tool call ...] and [tool result ...] lines; only the <'+t+'> form above triggers a new call.',
  '[/FUNCTION TOOLS]'].join('\n');
}
// OpenAI messages with tool history -> plain text messages the Build packer accepts.
// assistant.tool_calls -> appended text lines; role tool/function -> user message named "tool".
function flatten(messages){
 if(!Array.isArray(messages))return {messages,changed:false};
 let changed=false;const names=new Map();
 const out=messages.map(m=>{
  if(!m||typeof m!=='object')return m;
  const calls=Array.isArray(m.tool_calls)?m.tool_calls:m.function_call?[{id:null,function:m.function_call}]:[];
  if(m.role==='assistant'&&calls.length){
   changed=true;
   const lines=calls.map(c=>{const f=c&&c.function||{};if(c&&c.id)names.set(c.id,f.name);
    return '[tool call id='+(c&&c.id||'-')+' name='+(f.name||'?')+'] '+(typeof f.arguments==='string'?f.arguments:JSON.stringify(f.arguments||{}));});
   const text=typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter(p=>p&&typeof p.text==='string').map(p=>p.text).join('\n'):'';
   const {tool_calls,function_call,...rest}=m;
   return {...rest,content:(text.trim()?text+'\n':'')+lines.join('\n')};
  }
  if(m.role==='tool'||m.role==='function'){
   changed=true;
   const id=m.tool_call_id||null,name=m.name||names.get(id)||'?';
   const text=typeof m.content==='string'?m.content:JSON.stringify(m.content);
   return {role:'user',name:'tool',content:'[tool result id='+(id||'-')+' name='+name+']\n'+text};
  }
  return m;
 });
 return {messages:out,changed};
}
// Light argument check (no Ajv): object, required keys present, primitive types of known properties.
function checkArgs(schema,args){
 if(!args||typeof args!=='object'||Array.isArray(args))return 'arguments 不是对象';
 if(!schema||typeof schema!=='object')return null;
 for(const k of Array.isArray(schema.required)?schema.required:[])if(!(k in args))return '缺少参数 '+k;
 const props=schema.properties&&typeof schema.properties==='object'?schema.properties:{};
 const is={string:v=>typeof v==='string',number:v=>typeof v==='number',integer:v=>Number.isInteger(v),boolean:v=>typeof v==='boolean',array:Array.isArray,object:v=>v!==null&&typeof v==='object'&&!Array.isArray(v),null:v=>v===null};
 for(const [k,v] of Object.entries(args)){
  const p=props[k];if(!p||typeof p!=='object')continue;
  const types=[].concat(p.type||[]).map(String);
  if(types.length&&!types.some(t=>is[t]&&is[t](v))&&!(v===null&&p.nullable))return '参数 '+k+' 类型应为 '+types.join('|');
  if(Array.isArray(p.enum)&&!p.enum.some(e=>JSON.stringify(e)===JSON.stringify(v)))return '参数 '+k+' 不在可选值内';
 }
 return null;
}
// Model reply -> {content, calls:[{id,type,function:{name,arguments}}], rejected:[reason]}.
// Only blocks carrying this request's nonce count. Invalid blocks stay in the text; nothing is thrown.
function extract(text,spec,n){
 const out={content:String(text||''),calls:[],rejected:[]};
 if(!spec||spec.mode==='none')return out;
 const t=tag(n),re=new RegExp('<'+t+'>\\s*([\\s\\S]*?)\\s*</'+t+'>','g');
 const known=new Map(spec.tools.map(x=>[x.name,x]));
 let kept='',at=0,m;
 while((m=re.exec(out.content))){
  let v,why=null,raw=m[1].replace(/^```(?:json)?\s*|\s*```$/g,'');
  try{v=JSON.parse(raw);}catch{why='JSON 无效';}
  if(!why&&(!v||typeof v.name!=='string'))why='缺少 name';
  if(!why&&!known.has(v.name))why='未知工具 '+v.name;
  let args=!why?(typeof v.arguments==='string'?(()=>{try{return JSON.parse(v.arguments);}catch{return undefined;}})():v.arguments??v.parameters??{}):null;
  if(!why&&args===undefined)why='arguments 不是合法 JSON';
  if(!why)why=checkArgs(known.get(v.name).parameters,args);
  if(!why&&spec.mode==='named'&&v.name!==spec.name)why='本轮只允许调用 '+spec.name;
  if(!why&&!spec.parallel&&out.calls.length)why='本轮只允许一个调用';
  kept+=out.content.slice(at,m.index);at=m.index+m[0].length;
  if(why){out.rejected.push(why);kept+=m[0];continue;}
  out.calls.push({id:'call_'+crypto.randomBytes(9).toString('hex'),type:'function',function:{name:v.name,arguments:JSON.stringify(args)}});
 }
 kept+=out.content.slice(at);
 // If no valid call came out, keep the original reply untouched.
 out.content=out.calls.length?kept.replace(/\s+$/,''):out.content;
 return out;
}
const FIELDS=['tools','tool_choice','functions','function_call','parallel_tool_calls'];
module.exports={normalize,instructions,flatten,extract,checkArgs,nonce,tag,FIELDS};
