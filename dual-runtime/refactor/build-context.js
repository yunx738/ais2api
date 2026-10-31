'use strict';
// Build channel context packer. OpenAI messages -> composer text (inline) + one text attachment (file).
// Gateway-side replacement for the build-standalone SillyTavern extension; no client plugin needed.
const crypto=require('crypto');
const WIRE_PREFIX='BUILD_ST_CONTEXT_V1\n';
const LIMITS=Object.freeze({shortPreset:2000,inlineBudget:45000,maxBytes:200*1024});
const fail=(message,status=400,code='build_context_invalid')=>Object.assign(Error(message),{statusCode:status,code});
// Rough token estimate: CJK ~1 token/char, other text ~4 chars/token.
function tokens(text){
 let cjk=0;for(const ch of text)if(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch))cjk++;
 return cjk+Math.ceil((text.length-cjk)/4);
}
function textOf(content){
 if(typeof content==='string')return content;
 if(Array.isArray(content))return content.map(p=>{
  if(p&&p.type==='text'&&typeof p.text==='string')return p.text;
  throw fail('Build 通道目前只支持文本消息');
 }).join('\n');
 if(content==null)return '';
 throw fail('消息 content 必须为文本');
}
// Manual override: a segment starting with [[inline]] or [[file]] is placed accordingly; the tag is removed.
function override(text){
 const m=/^\s*\[\[(inline|file)\]\]\s*/i.exec(text);
 return m?{placement:m[1].toLowerCase(),text:text.slice(m[0].length)}:{placement:null,text};
}
// Rules (server-side guess; the original extension knew prompt identifiers, we only see messages):
// 1 last user message -> inline (current turn)
// 2 system/developer after the last user/assistant turn -> inline (post-history instructions)
// 3 leading system run before any conversation: short (<=2000 tok) -> inline, long -> file
// 4 everything else (history, examples, mid-history injections) -> file
// 5 inline over 45000 tok: earliest movable inline segments move to file, never truncated
function classify(messages){
 if(!Array.isArray(messages)||!messages.length||messages.length>10000)throw fail('messages 必须为非空数组');
 const rows=messages.map((m,i)=>{
  if(!m||!['system','developer','user','assistant'].includes(m.role))throw fail('第 '+(i+1)+' 条消息角色无效');
  if(m.tool_calls||m.function_call)throw fail('Build 通道不支持工具调用');
  const o=override(textOf(m.content));
  return {message:i,part:0,role:m.role,...(typeof m.name==='string'&&m.name?{name:m.name.slice(0,128)}:{}),text:o.text,forced:o.placement};
 });
 const conv=rows.filter(r=>r.role==='user'||r.role==='assistant');
 const first=conv.length?conv[0].message:rows.length;
 const lastConv=conv.length?conv[conv.length-1].message:-1;
 const lastUser=[...rows].reverse().find(r=>r.role==='user'&&!r.name);
 const generationType=lastConv>=0&&rows[lastConv].role==='assistant'?'continue':'normal';
 for(const r of rows){
  let placement,source;
  if(generationType==='normal'&&lastUser&&r.message===lastUser.message){placement='inline';source='currentUser';}
  else if((r.role==='system'||r.role==='developer')&&r.message>lastConv){placement='inline';source='postHistory';}
  else if((r.role==='system'||r.role==='developer')&&r.message<first&&r.name){placement='file';source='example';}
  else if((r.role==='system'||r.role==='developer')&&r.message<first){placement=tokens(r.text)<=LIMITS.shortPreset?'inline':'file';source='leadingSystem';}
  else {placement='file';source=r.role==='system'||r.role==='developer'?'injection':'history';}
  if(r.forced&&source!=='currentUser')placement=r.forced;
  r.placement=placement;r.source=source;delete r.forced;
 }
 let inline=rows.filter(r=>r.placement==='inline').reduce((n,r)=>n+tokens(r.text),0);
 for(const r of rows){
  if(inline<=LIMITS.inlineBudget)break;
  if(r.placement!=='inline'||r.source==='currentUser')continue;
  r.placement='file';r.source+='+overflow';inline-=tokens(r.text);
 }
 if(inline>LIMITS.inlineBudget)throw fail('当前这条用户消息超过 45000 token，请缩短',413,'inline_too_large');
 return {segments:rows,generationType,inlineTokens:inline};
}
// Original extension envelope (BUILD_ST_CONTEXT_V1): trust its placements instead of guessing.
function fromEnvelope(messages){
 if(!Array.isArray(messages)||messages.length!==1||messages[0]?.role!=='user'||typeof messages[0].content!=='string'||!messages[0].content.startsWith(WIRE_PREFIX))return null;
 let v;try{v=JSON.parse(messages[0].content.slice(WIRE_PREFIX.length));}catch{throw fail('酒馆上下文封装损坏');}
 if(!v||v.version!==1)throw fail('不支持的酒馆适配版本');
 if(v.error)throw fail('酒馆适配器已阻止请求：'+String(v.error).slice(0,60));
 if(!Array.isArray(v.segments)||!v.segments.length||v.segments.length>20000)throw fail('酒馆分段数量无效');
 const segments=v.segments.map(x=>{
  if(!x||!['system','developer','user','assistant'].includes(x.role)||!['inline','file'].includes(x.placement)||typeof x.text!=='string')throw fail('酒馆分段结构无效');
  return {message:x.message|0,part:x.part|0,role:x.role,source:String(x.source||'context').slice(0,128),placement:x.placement,text:x.text,...(typeof x.name==='string'&&x.name?{name:x.name.slice(0,128)}:{})};
 });
 const generationType=['normal','regenerate','swipe','continue','quiet','impersonate'].includes(v.generationType)?v.generationType:'normal';
 return {segments,generationType,inlineTokens:segments.filter(x=>x.placement==='inline').reduce((n,x)=>n+tokens(x.text),0)};
}
function prepare(messages){return fromEnvelope(messages)||classify(messages);}
// Pack prepared segments into Build request parts: [attachment?, composer text].
// Composer = instruction + outline; inline segments appear verbatim in order, file segments are referenced by number.
// Returns {parts, hashText, bytes, mode}. hashText is the composer text (what Build signs).
function pack(prepared,{requestedMaxOutputTokens,nonce=crypto.randomBytes(12).toString('hex')}={}){
 const {segments,generationType}=prepared;
 const name='__bridge_attachment_'+nonce+'.txt';
 const files=[],outline=[];let pending=[];
 const flush=()=>{if(pending.length){outline.push('[CONTEXT segments '+pending[0]+'..'+pending[pending.length-1]+': read their exact text and roles from '+name+']');pending=[];}};
 segments.forEach((x,i)=>{
  const segment=i+1,meta={segment,message:x.message,part:x.part,role:x.role,source:x.source,placement:x.placement,...(x.name?{name:x.name}:{})};
  if(x.placement==='file'){files.push({...meta,text:x.text});pending.push(segment);}
  else{files.push(meta);flush();outline.push('[INLINE '+nonce+' segment='+segment+' role='+x.role+(x.name?' name='+JSON.stringify(x.name):'')+']\n'+x.text+'\n[/INLINE '+nonce+' segment='+segment+']');}
 });
 flush();
 const hasFile=segments.some(x=>x.placement==='file');
 const action={continue:'Continue the final assistant message.',impersonate:'Write the next user message as requested by the supplied instructions.',quiet:'Answer the supplied quiet task.'}[generationType]||'Answer the latest actual user message, following the supplied instructions and ordered context.';
 const limit=requestedMaxOutputTokens?'\nRequested output limit: '+requestedMaxOutputTokens+' tokens.':'';
 let prompt,parts,bytes=0;
 if(hasFile){
  const text=JSON.stringify({kind:'conversation_context',request:nonce,encoding:'Segments preserve original message order. Preserve roles, names, and exact text. Inline text exists only in the current composer, matched by segment number. File text exists only in this attachment.',segments:files},null,1)+'\n';
  bytes=Buffer.byteLength(text);
  if(bytes>LIMITS.maxBytes)throw fail('Build 上下文 '+Math.round(bytes/1024)+'KB，超过当前 '+Math.round(LIMITS.maxBytes/1024)+'KB 上限，请缩短历史',413,'context_too_large');
  prompt='This is a text-only conversation, not an app development task. Read the attached text file '+name+'. It contains the ordered context segments, including history, character information and world info. Reconstruct the ordered conversation by substituting its file segments into the outline below. Preserve roles, names, order and exact text. Instructions supplied INLINE below are not stored in the attachment. Use only this attachment and the current composer as context, not previous project chats or project files. Do not edit project files. '+action+' Return the complete answer directly.'+limit+'\n\n'+outline.join('\n\n');
  parts=[[null,null,['text/plain',Buffer.from(text,'utf8').toString('base64')]],[null,prompt]];
 }else{
  prompt='This is a text-only conversation, not an app development task. Do not edit project files. '+action+' Return the complete answer directly.'+limit+'\n\n'+outline.join('\n\n');
  parts=[[null,prompt]];
 }
 if(Buffer.byteLength(prompt)>LIMITS.maxBytes)throw fail('Build 输入框内容过大',413,'inline_too_large');
 // Same hash input as the verified probe: each part's text, or its inline data, joined by spaces.
 const hashText=parts.map(x=>x[1]!=null?x[1]:(x[2]?x[2][1]:'')).join(' ');
 return {parts,hashText,bytes:bytes+Buffer.byteLength(prompt),mode:hasFile?'attachment':'inline',nonce,segments:segments.length};
}
module.exports={classify,fromEnvelope,prepare,pack,tokens,LIMITS,WIRE_PREFIX};
