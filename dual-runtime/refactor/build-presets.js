'use strict';
// Uploaded SillyTavern chat-completion presets -> server-side context splitting for the Build channel.
// Same rule as the build-standalone adapter: preset prompts (main/jailbreak/custom entries) go to the
// composer (inline); everything else (card, world info, examples, history) goes to the attachment (file).
// The adapter tagged prompts inside ST; here each prompt's expanded text is located in the final messages.
// Macros ({{char}}, {{user}}, <USER> ...) are expanded by ST, so they act as wildcards between literal chunks.
const fs=require('fs'),crypto=require('crypto');
const {tokens,LIMITS,WIRE_PREFIX}=require('./build-context');
const BACKGROUND=new Set(['worldInfoBefore','worldInfoAfter','charDescription','charPersonality','scenario','personaDescription','dialogueExamples','chatHistory','summary','authorsNote','vectorsMemory','vectorsDataBank','smartContext']);
const MACRO=/\{\{[\s\S]*?\}\}|<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/gi;
const MIN_LITERAL=12,MAX_GAP=20000,MAX_PRESETS=20,MAX_PROMPTS=1000;
const fail=(m,s=400)=>Object.assign(Error(m),{statusCode:s});
const norm=t=>String(t).replace(/\r\n?/g,'\n');
function chunksOf(text){return norm(text).split(MACRO).map(s=>s.trim()).filter(Boolean);}
function parsePreset(preset){
 if(!preset||typeof preset!=='object'||Array.isArray(preset))throw fail('预设文件不是 JSON 对象');
 if(!Array.isArray(preset.prompts))throw fail('这不是酒馆的对话补全预设（缺少 prompts 列表）');
 const out=[],seen=new Set();
 for(const p of preset.prompts.slice(0,MAX_PROMPTS)){
  if(!p||typeof p!=='object'||p.marker===true||typeof p.content!=='string')continue;
  const id=String(p.identifier||'').slice(0,128);
  if(BACKGROUND.has(id))continue;
  const chunks=chunksOf(p.content);
  if(chunks.join('').length<MIN_LITERAL)continue;
  const key=chunks.join('\u0000');if(seen.has(key))continue;seen.add(key);
  out.push({id:id||crypto.randomBytes(4).toString('hex'),name:String(p.name||id||'条目').slice(0,128),chunks});
 }
 if(!out.length)throw fail('预设里没有可识别的条目（条目需有正文，且不能只有宏）');
 return out;
}
// One prompt inside text from `from`: anchor on its longest literal chunk, then extend to the nearest
// neighbours on both sides (macro gaps between them). Returns [start,end] or null.
function findOne(text,chunks,from){
 let k=0;for(let i=1;i<chunks.length;i++)if(chunks[i].length>chunks[k].length)k=i;
 let pos=text.indexOf(chunks[k],from);
 while(pos>=0){
  let start=pos,end=pos+chunks[k].length,ok=true;
  for(let i=k-1;i>=0&&ok;i--){
   const at=start-chunks[i].length<from?-1:text.lastIndexOf(chunks[i],start-chunks[i].length);
   if(at<from||start-(at+chunks[i].length)>MAX_GAP)ok=false;else start=at;
  }
  for(let i=k+1;i<chunks.length&&ok;i++){
   const at=text.indexOf(chunks[i],end);
   if(at<0||at-end>MAX_GAP)ok=false;else end=at+chunks[i].length;
  }
  if(ok)return [start,end];
  pos=text.indexOf(chunks[k],pos+1);
 }
 return null;
}
function spans(text,prompts){
 const found=[];
 const free=(a,b)=>!found.some(s=>a<s.end&&b>s.start);
 for(const p of prompts){
  let from=0,hit;
  while(from<text.length&&(hit=findOne(text,p.chunks,from))){
   if(free(hit[0],hit[1]))found.push({start:hit[0],end:hit[1],source:p.id});
   from=hit[1];
  }
 }
 return found.sort((a,b)=>a.start-b.start);
}
function textOf(content){
 if(typeof content==='string')return content;
 if(Array.isArray(content)&&content.every(p=>p&&p.type==='text'&&typeof p.text==='string'))return content.map(p=>p.text).join('\n');
 return null;
}
// messages -> prepared {segments,generationType,inlineTokens,hits,matched} or null (no preset text found / not applicable).
function segment(messages,prompts){
 if(!Array.isArray(messages)||!messages.length||!prompts.length)return null;
 const rows=[];
 for(const m of messages){
  if(!m||!['system','developer','user','assistant'].includes(m.role)||m.tool_calls||m.function_call)return null;
  const t=textOf(m.content);if(t===null)return null;
  rows.push({role:m.role,name:typeof m.name==='string'&&m.name?m.name.slice(0,128):undefined,text:norm(t)});
 }
 if(rows.length===1&&rows[0].text.startsWith(WIRE_PREFIX))return null;
 const ordered=prompts.slice().sort((a,b)=>b.chunks.join('').length-a.chunks.join('').length);
 const conv=rows.map((r,i)=>r.role==='user'||r.role==='assistant'?i:-1).filter(i=>i>=0);
 const last=conv.length?conv[conv.length-1]:-1;
 const generationType=last>=0&&rows[last].role==='assistant'?'continue':'normal';
 let current=-1;
 if(generationType==='normal')for(let i=rows.length-1;i>=0;i--)if(rows[i].role==='user'&&!rows[i].name){current=i;break;}
 const segments=[],matched=new Set();let hits=0;
 rows.forEach((r,i)=>{
  const base={message:i,role:r.role,...(r.name?{name:r.name}:{})};
  const list=spans(r.text,ordered);
  const rest=i===current?['inline','currentUser']:['file','context'];
  let part=0,at=0;
  const push=(text,placement,source)=>{if(text.trim())segments.push({...base,part:part++,source,placement,text});};
  for(const s of list){push(r.text.slice(at,s.start),...rest);push(r.text.slice(s.start,s.end),'inline',s.source);hits++;matched.add(s.source);at=s.end;}
  push(r.text.slice(at),...rest);
  if(!segments.some(x=>x.message===i))segments.push({...base,part:0,source:rest[1],placement:rest[0],text:r.text});
 });
 if(!hits)return null;
 let inline=segments.filter(x=>x.placement==='inline').reduce((n,x)=>n+tokens(x.text),0);
 for(const x of segments){
  if(inline<=LIMITS.inlineBudget)break;
  if(x.placement!=='inline'||x.source==='currentUser')continue;
  x.placement='file';x.source+='+overflow';inline-=tokens(x.text);
 }
 return {segments,generationType,inlineTokens:inline,hits,matched:[...matched]};
}
const envelope=p=>WIRE_PREFIX+JSON.stringify({version:1,generationType:p.generationType,segments:p.segments,inlineTokens:p.inlineTokens});
class PresetStore{
 constructor(file){this.file=file;this.cache=null;}
 read(){
  if(this.cache)return this.cache;
  try{const d=JSON.parse(fs.readFileSync(this.file,'utf8'));this.cache=Array.isArray(d.presets)?d:{presets:[]};}
  catch{this.cache={presets:[]};}
  return this.cache;
 }
 save(){const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.cache));fs.renameSync(tmp,this.file);}
 list(){
  return this.read().presets.map(p=>({id:p.id,name:p.name,uploadedAt:p.uploadedAt,enabled:p.enabled!==false,
   prompts:p.prompts.map(x=>x.name),requests:p.requests||0,lastHitAt:p.lastHitAt||null,lastHits:p.lastHits||0}));
 }
 add(name,preset){
  const prompts=parsePreset(preset);
  const d=this.read();if(d.presets.length>=MAX_PRESETS)throw fail('最多保存 '+MAX_PRESETS+' 个预设，请先删除不用的');
  const item={id:crypto.randomBytes(6).toString('hex'),name:String(name||'预设').replace(/\.json$/i,'').slice(0,80)||'预设',uploadedAt:Date.now(),enabled:true,prompts};
  d.presets.push(item);this.save();return {id:item.id,name:item.name,prompts:prompts.length};
 }
 remove(id){const d=this.read(),n=d.presets.length;d.presets=d.presets.filter(p=>p.id!==id);if(d.presets.length===n)throw fail('预设不存在',404);this.save();return {ok:true};}
 setEnabled(id,on){const p=this.read().presets.find(x=>x.id===id);if(!p)throw fail('预设不存在',404);p.enabled=!!on;this.save();return {ok:true};}
 // messages -> {content,hits,inlineTokens} (envelope for the worker) or null.
 apply(messages){
  const active=this.read().presets.filter(p=>p.enabled!==false);
  if(!active.length)return null;
  const prepared=segment(messages,active.flatMap(p=>p.prompts));
  if(!prepared)return null;
  const now=Date.now();
  for(const p of active){const n=p.prompts.filter(x=>prepared.matched.includes(x.id)).length;if(n){p.requests=(p.requests||0)+1;p.lastHitAt=now;p.lastHits=n;}}
  try{this.save();}catch{}
  return {content:envelope(prepared),hits:prepared.hits,inlineTokens:prepared.inlineTokens};
 }
}
module.exports={parsePreset,segment,spans,envelope,PresetStore,chunksOf};
