'use strict';
// Which anti-truncation prompt the workers use. Persisted so restarts and account switches keep it.
// The coordinator passes it to the worker per request (X-AT-Prompt, plus X-AT-Prompt-Custom for
// the user-editable prompt), so a change applies to the next request without restarting a worker.
// Built-in texts live in at-prompt-defaults.json and must match AT_PROMPTS in the worker runtime.
const fs=require('fs'),path=require('path');
const DEFAULTS=JSON.parse(fs.readFileSync(path.join(__dirname,'at-prompt-defaults.json'),'utf8'));
const PRESETS=Object.freeze([
 {key:'classic',label:'原版',note:'原来的提示词，只要求用工具交答案'},
 {key:'once',label:'只交一次（推荐）',note:'明确要求只用工具交一次，不许再用正文写一遍，也不许把调用写成文字'},
 {key:'tool_only',label:'只许工具调用',note:'回复里除了这一次工具调用不许有任何文字，最严格'},
 {key:'lite',label:'精简',note:'一句话版本，占用最少的提示词'},
 {key:'custom',label:'自定义',note:'用下面编辑框里的内容；{tool} 会换成工具名，{partial} 是续写时上一轮没交完的内容'},
].map(p=>Object.freeze({...p,...(DEFAULTS.presets[p.key]?{desc:DEFAULTS.presets[p.key].desc,hint:DEFAULTS.presets[p.key].hint,cont:DEFAULTS.cont}:{})})));
const KEYS=PRESETS.map(p=>p.key),BUILTIN=KEYS.filter(k=>k!=='custom'),DEFAULT='classic';
const LIMITS=Object.freeze({desc:1000,hint:6000,cont:2000,bytes:8000});
const bad=m=>Object.assign(Error(m),{statusCode:400});
function validCustom(c){
 if(!c||typeof c!=='object'||Array.isArray(c))throw bad('自定义提示词格式不对');
 const out={};
 for(const k of ['desc','hint','cont']){
  const v=c[k]===undefined&&k==='cont'?DEFAULTS.cont:c[k];
  if(typeof v!=='string')throw bad(k+' 必须是文字');
  if(v.length>LIMITS[k])throw bad(k+' 太长（最多 '+LIMITS[k]+' 字）');
  out[k]=v.replace(/\r\n/g,'\n');
 }
 if(!out.desc.trim())throw bad('工具说明（desc）不能为空');
 if(!out.hint.trim())throw bad('系统提示词（hint）不能为空');
 if(Buffer.byteLength(JSON.stringify(out))>LIMITS.bytes)throw bad('自定义提示词总共太长（最多约 '+LIMITS.bytes+' 字节）');
 return out;
}
class AtPromptStore{
 constructor(file){
  this.file=file;this.value=DEFAULT;this.custom=null;
  try{const d=JSON.parse(fs.readFileSync(file,'utf8'));
   try{if(d?.custom)this.custom=validCustom(d.custom);}catch{}
   if(KEYS.includes(d?.preset)&&(d.preset!=='custom'||this.custom))this.value=d.preset;}catch{}
 }
 get(){return KEYS.includes(this.value)&&(this.value!=='custom'||this.custom)?this.value:DEFAULT;}
 // Header payload for the worker; only for the custom preset.
 header(){return this.get()==='custom'?Buffer.from(JSON.stringify(this.custom),'utf8').toString('base64'):null;}
 set(body){
  const v=body?.preset;
  if(!KEYS.includes(v))throw bad('提示词只能是 '+KEYS.join('、')+' 之一');
  const custom=body.custom!==undefined&&body.custom!==null?validCustom(body.custom):this.custom;
  if(v==='custom'&&!custom)throw bad('选“自定义”前先填写自定义提示词');
  const tmp=this.file+'.tmp';
  const fd=fs.openSync(tmp,'w',0o600);
  try{fs.writeSync(fd,JSON.stringify({preset:v,custom}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,this.file);
  this.value=v;this.custom=custom;return this.status();
 }
 // Import file: {format:'ais2api-at-prompt',version:1,preset,custom}. A bare {desc,hint,cont} is also accepted.
 import(body){
  const d=body?.format==='ais2api-at-prompt'?body:(body&&typeof body.hint==='string'?{preset:'custom',custom:body}:null);
  if(!d)throw bad('不是防截断提示词导出文件');
  return this.set({preset:KEYS.includes(d.preset)?d.preset:'custom',custom:d.custom});
 }
 export(){return {format:'ais2api-at-prompt',version:1,exportedAt:new Date().toISOString(),preset:this.get(),custom:this.custom||{desc:DEFAULTS.presets.once.desc,hint:DEFAULTS.presets.once.hint,cont:DEFAULTS.cont}};}
 status(){return {preset:this.get(),default:DEFAULT,presets:PRESETS,custom:this.custom,limits:LIMITS,placeholders:{tool:'工具名 seal_final_reply',partial:'续写时：上一轮没交完的内容（没有就为空）'}};}
}
module.exports={AtPromptStore,PRESETS,KEYS,BUILTIN,DEFAULT,DEFAULTS,LIMITS,validCustom};
