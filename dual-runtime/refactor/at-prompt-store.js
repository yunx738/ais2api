'use strict';
// Which anti-truncation prompt preset the workers use. Persisted so restarts and account
// switches keep it. The coordinator passes it to the worker per request (X-AT-Prompt), so a
// change applies to the next request without restarting any worker.
// Keep the keys in sync with AT_PROMPTS in code/unified-server.runtime.js.
const fs=require('fs');
const PRESETS=Object.freeze([
 {key:'classic',label:'原版',note:'原来的提示词，只要求用工具交答案'},
 {key:'once',label:'只交一次（推荐）',note:'明确要求只用工具交一次，不许再用正文写一遍，也不许把调用写成文字'},
 {key:'tool_only',label:'只许工具调用',note:'回复里除了这一次工具调用不许有任何文字，最严格'},
 {key:'lite',label:'精简',note:'一句话版本，占用最少的提示词'},
]);
const KEYS=PRESETS.map(p=>p.key),DEFAULT='classic';
class AtPromptStore{
 constructor(file){
  this.file=file;this.value=DEFAULT;
  try{const d=JSON.parse(fs.readFileSync(file,'utf8'));if(KEYS.includes(d?.preset))this.value=d.preset;}catch{}
 }
 get(){return KEYS.includes(this.value)?this.value:DEFAULT;}
 set(body){
  const v=body?.preset;
  if(!KEYS.includes(v))throw Object.assign(Error('提示词只能是 '+KEYS.join('、')+' 之一'),{statusCode:400});
  const tmp=this.file+'.tmp';
  const fd=fs.openSync(tmp,'w',0o600);
  try{fs.writeSync(fd,JSON.stringify({preset:v}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,this.file);
  this.value=v;return this.status();
 }
 status(){return {preset:this.get(),default:DEFAULT,presets:PRESETS};}
}
module.exports={AtPromptStore,PRESETS,KEYS,DEFAULT};
