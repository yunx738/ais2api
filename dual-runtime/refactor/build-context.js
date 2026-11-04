'use strict';
// Build channel context packer. OpenAI messages -> composer text (inline) + one text attachment (file).
// Gateway-side replacement for the build-standalone SillyTavern extension; no client plugin needed.
const crypto=require('crypto');
const WIRE_PREFIX='BUILD_ST_CONTEXT_V1\n';
// Aligned with build-standalone 0.5.0: context attachment up to 8 MiB, composer up to 1 MiB.
// Attachments above inlineFileBytes are uploaded through /_/upload (as the official composer does) instead of inline data.
const LIMITS=Object.freeze({shortPreset:2000,inlineBudget:45000,maxBytes:8*1024*1024,maxComposerBytes:1024*1024,inlineFileBytes:200*1024,maxMediaBytes:20*1024*1024,maxSegments:20000});
const fail=(message,status=400,code='build_context_invalid')=>Object.assign(Error(message),{statusCode:status,code});
// Rough token estimate: CJK ~1 token/char, other text ~4 chars/token.
function tokens(text){
 let cjk=0;for(const ch of text)if(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch))cjk++;
 return cjk+Math.ceil((text.length-cjk)/4);
}
// Build only accepts text. Non-text parts (images, audio, files, ...) are dropped instead of failing the request;
// `st` counts what was dropped. The Playground channel does not use this file and is unaffected.
const ROLES=['system','developer','user','assistant'];
// media: optional array; when given (build-st/ models), non-text parts are kept as inline files instead of dropped.
function mediaOf(p){
 const url=p&&(p.image_url&&(p.image_url.url||p.image_url)||p.file&&(p.file.file_data||p.file.url)||p.url);
 if(typeof url==='string'){const m=/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);if(m)return {mime:m[1],data:m[2].replace(/\s+/g,''),name:p.file&&p.file.filename};return {link:url};}
 if(p&&p.input_audio&&typeof p.input_audio.data==='string')return {mime:'audio/'+(p.input_audio.format||'wav'),data:p.input_audio.data};
 return null;
}
function textOf(content,st,media){
 if(typeof content==='string')return content;
 if(content==null)return '';
 const list=Array.isArray(content)?content:[content];
 const out=[];
 for(const p of list){
  if(typeof p==='string'){out.push(p);continue;}
  if(p&&typeof p.text==='string'&&(p.type==null||p.type==='text'||p.type==='input_text')){out.push(p.text);continue;}
  const f=media&&mediaOf(p);
  if(f&&f.data){media.push(f);out.push('[attached file #'+media.length+(f.name?' '+String(f.name).slice(0,80):'')+' ('+f.mime+')]');continue;}
  if(f&&f.link){out.push('[file link: '+f.link.slice(0,500)+']');continue;}
  if(st)st.parts++;
 }
 return out.join('\n');
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
function classify(messages,{keepMedia=false}={}){
 if(!Array.isArray(messages)||!messages.length||messages.length>10000)throw fail('messages 必须为非空数组');
 const st={parts:0,messages:0,toolCalls:0};
 const rows=[],media=keepMedia?[]:null;
 messages.forEach((m,i)=>{
  // tool / function results and unknown roles are dropped; tool calls are stripped from assistant turns
  if(!m||!ROLES.includes(m.role)){st.messages++;return;}
  const hadTool=!!(m.tool_calls||m.function_call);if(hadTool)st.toolCalls++;
  const before=st.parts;
  const o=override(textOf(m.content,st,media));
  if(!o.text.trim()&&(hadTool||st.parts>before)){st.messages++;return;}
  rows.push({message:i,part:0,role:m.role,...(typeof m.name==='string'&&m.name?{name:m.name.slice(0,128)}:{}),text:o.text,forced:o.placement});
 });
 if(!rows.length)throw fail('过滤掉图片、附件和工具调用后，没有可以发送的文字内容');
 const conv=rows.filter(r=>r.role==='user'||r.role==='assistant');
 const first=conv.length?conv[0].message:messages.length;
 const lastConv=conv.length?conv[conv.length-1].message:-1;
 const lastUser=[...rows].reverse().find(r=>r.role==='user'&&!r.name);
 const generationType=conv.length&&conv[conv.length-1].role==='assistant'?'continue':'normal';
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
 return {segments:rows,generationType,inlineTokens:inline,dropped:st,...(media&&media.length?{media}:{})};
}
// Original extension envelope (BUILD_ST_CONTEXT_V1): trust its placements instead of guessing.
// Version 2 (plugin 0.6.0) adds tool / function roles and messageMetadata (tool_calls, tool_call_id).
const ENV_ROLES=[...ROLES,'tool','function'];
function fromEnvelope(messages){
 if(!Array.isArray(messages)||messages.length!==1||messages[0]?.role!=='user'||typeof messages[0].content!=='string'||!messages[0].content.startsWith(WIRE_PREFIX))return null;
 let v;try{v=JSON.parse(messages[0].content.slice(WIRE_PREFIX.length));}catch{throw fail('酒馆上下文封装损坏');}
 if(!v||![1,2].includes(v.version))throw fail('不支持的酒馆适配版本');
 // The plugin refused locally and sent no context at all (only an error marker), so there is nothing to forward.
 if(v.error){
  const why=String(v.error).slice(0,60);
  const hint=why==='text_only'?'对话里有图片等非文字内容':'原因：'+why;
  throw fail('酒馆 Build 插件（build-standalone）在本地拦下了这次请求（'+hint+'），没有发送任何对话内容，网关无法转发。请删除对话里的图片后重试，或关闭该插件直接使用 build-st/ 模型，由网关自动去掉图片后转发。',400,'build_plugin_refused');
 }
 if(!['normal','regenerate','swipe','continue','quiet','impersonate'].includes(v.generationType))throw fail('不支持的酒馆生成类型');
 if(!Array.isArray(v.segments)||!v.segments.length||v.segments.length>LIMITS.maxSegments)throw fail('酒馆分段数量无效');
 // Same checks as build-standalone: contiguous message/part order, one role and name per message.
 let lastMessage=-1,lastPart=-1,lastRole,lastName,inlineBytes=0;
 const segments=v.segments.map(x=>{
  if(!x||!Number.isSafeInteger(x.message)||!Number.isSafeInteger(x.part)||x.message<0||x.part<0||!ENV_ROLES.includes(x.role)||!['inline','file'].includes(x.placement)||typeof x.text!=='string'||typeof x.source!=='string'||x.source.length>128)throw fail('酒馆分段结构无效');
  if(x.message===lastMessage){
   if(x.part!==lastPart+1)throw fail('酒馆分段顺序不连续');
   if(x.role!==lastRole||(x.name||'')!==lastName)throw fail('同一条酒馆消息的角色不一致');
  }else if(x.message!==lastMessage+1||x.part!==0)throw fail('酒馆消息顺序不连续');
  if(x.name!==undefined&&(typeof x.name!=='string'||x.name.length>128))throw fail('酒馆角色名称无效');
  lastMessage=x.message;lastPart=x.part;lastRole=x.role;lastName=x.name||'';
  if(x.placement==='inline')inlineBytes+=Buffer.byteLength(x.text);
  return {message:x.message,part:x.part,role:x.role,source:x.source,placement:x.placement,text:x.text,...(x.name?{name:x.name}:{})};
 });
 if(inlineBytes>LIMITS.maxComposerBytes)throw fail('输入框原文超过 1 MiB 安全大小限制；未移入文件或截断',413,'inline_too_large');
 if(v.inlineTokens!=null&&(!Number.isSafeInteger(v.inlineTokens)||v.inlineTokens<0||v.inlineTokens>LIMITS.inlineBudget))throw fail('酒馆估算的输入框内容超过 45000 token；未截断预设',413,'inline_too_large');
 // v2 messageMetadata: tool calls / ids go into the text of that message's last segment (all in the attachment).
 const meta=v.messageMetadata;
 if(meta!==undefined){
  if(!Array.isArray(meta)||meta.length>lastMessage+1)throw fail('工具历史元数据无效');
  const seen=new Set();
  for(const m of meta){
   if(!m||typeof m!=='object'||!Number.isSafeInteger(m.message)||m.message<0||m.message>lastMessage||seen.has(m.message))throw fail('工具历史元数据无效');
   seen.add(m.message);
   const own=segments.filter(x=>x.message===m.message);
   if(own.some(x=>x.placement!=='file'))throw fail('工具调用历史必须放在附件中');
   const last=own[own.length-1];
   const calls=Array.isArray(m.tool_calls)?m.tool_calls:m.function_call?[{function:m.function_call}]:[];
   const lines=calls.map(c=>{const f=c&&c.function||{};return '[tool call id='+(c&&c.id||'-')+' name='+(f.name||'?')+'] '+(typeof f.arguments==='string'?f.arguments:JSON.stringify(f.arguments||{}));});
   if(lines.length)last.text+=(last.text.trim()?'\n':'')+lines.join('\n');
   if(m.tool_call_id)own[0].text='[tool result id='+String(m.tool_call_id).slice(0,128)+']\n'+own[0].text;
  }
 }
 const inlineTokens=v.inlineTokens??segments.filter(x=>x.placement==='inline').reduce((n,x)=>n+tokens(x.text),0);
 return {segments,generationType:v.generationType,inlineTokens,dropped:{parts:0,messages:0,toolCalls:0,segments:0},plugin:true};
}
// code/: split for coding agents (OpenCode, Cline, Roo, Claude-Code style clients).
// - all system/developer text (agent rules, tool usage rules, env info) -> inline, unless huge
// - the latest user request and everything after it (the live tool-call chain) -> inline
// - tool results in that chain: small -> inline, large (file dumps, logs) -> file
// - earlier turns -> file
// - over budget: move large tool results first, then oldest chain items, then large system blocks
const CODE=Object.freeze({systemMax:30000,toolInline:3000});
function classifyCode(messages,opts={}){
 const base=classify(messages,opts);
 const rows=base.segments;
 const isTool=r=>r.role==='user'&&r.name==='tool';
 let anchor=-1;for(let i=rows.length-1;i>=0;i--)if(rows[i].role==='user'&&!isTool(rows[i])){anchor=i;break;}
 rows.forEach((r,i)=>{
  const sys=r.role==='system'||r.role==='developer';
  if(sys){r.placement=tokens(r.text)<=CODE.systemMax?'inline':'file';r.source='codeSystem';return;}
  if(anchor<0||i<anchor){r.placement='file';r.source='history';return;}
  if(i===anchor){r.placement='inline';r.source='currentUser';return;}
  if(isTool(r)){r.placement=tokens(r.text)<=CODE.toolInline?'inline':'file';r.source='toolResult';return;}
  r.placement='inline';r.source='toolChain';
 });
 let inline=rows.filter(r=>r.placement==='inline').reduce((n,r)=>n+tokens(r.text),0);
 const order=[...rows.filter(r=>r.placement==='inline'&&r.source==='toolResult').sort((a,b)=>tokens(b.text)-tokens(a.text)),
  ...rows.filter(r=>r.placement==='inline'&&r.source==='toolChain'),
  ...rows.filter(r=>r.placement==='inline'&&r.source==='codeSystem').sort((a,b)=>tokens(b.text)-tokens(a.text))];
 for(const r of order){if(inline<=LIMITS.inlineBudget)break;r.placement='file';r.source+='+overflow';inline-=tokens(r.text);}
 if(inline>LIMITS.inlineBudget)throw fail('当前这条用户消息超过 45000 token，请缩短',413,'inline_too_large');
 return {...base,segments:rows,inlineTokens:inline,generationType:'normal'};
}
function prepare(messages,opts={}){return fromEnvelope(messages)||(opts.mode==='code'?classifyCode(messages,opts):classify(messages,opts));}
// Pack prepared segments into Build request parts: [attachment?, composer text].
// Composer = instruction + outline; inline segments appear verbatim in order, file segments are referenced by number.
// Returns {parts, hashText, bytes, mode}. hashText is the composer text (what Build signs).
// extra: optional composer block (e.g. function tool definitions) placed before the outline.
function pack(prepared,{requestedMaxOutputTokens,nonce=crypto.randomBytes(12).toString('hex'),extra='',code=false,document=null}={}){
 // document: reserved reply file name (anti-truncation). The answer goes into that project file instead of chat.
 const fileRule=document?'Do not edit project files other than '+document+'. ':'Do not edit project files. ';
 const deliver=document?' '+require('./build-document').instruction(document):' Return the complete answer directly, without a receipt or verification code.';
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
 const head=(code?'This is a coding-agent conversation driven by an external client. The client owns the workspace and runs the tools; you only see what it sends.\n\n':'')+(extra?extra+'\n\n':'');
 let prompt,parts,bytes=0;
 if(hasFile){
  const text=JSON.stringify({kind:prepared.plugin?'sillytavern_context':'conversation_context',request:nonce,encoding:'Segments preserve original message and part order. Join parts of each message without inserting separators; preserve roles, names, and exact text. Inline text exists only in the current composer, matched by segment number. File text exists only in this attachment.',segments:files},null,2)+'\n';
  bytes=Buffer.byteLength(text);
  if(bytes>LIMITS.maxBytes)throw fail('Build 聊天附件超过 8 MiB，请缩短历史',413,'context_too_large');
  const which=prepared.plugin?'Preset instructions are supplied directly INLINE below; their text is not stored in the attachment.':'Instructions supplied INLINE below are not stored in the attachment.';
  prompt='This is a text-only conversation, not an app development task. Read the attached text file '+name+'. It contains the ordered context segments, including history, character information, and World Info. Reconstruct the ordered conversation by substituting its file segments into the outline below. Preserve roles, names, order, and exact text. '+which+' Use only this attachment and the current composer as context, not previous project chats or project files. '+fileRule+action+deliver+'\n\n'+head+outline.join('\n\n')+limit;
  const b64=Buffer.from(text,'utf8').toString('base64');
  // Small attachments stay inline (verified path); larger ones are uploaded first, like the official composer.
  parts=[bytes>LIMITS.inlineFileBytes?{__upload:['text/plain',b64,name]}:[null,null,['text/plain',b64]],[null,prompt]];
 }else{
  prompt='This is a text-only conversation, not an app development task. Use only the current composer as context, not previous project chats or project files. '+fileRule+action+deliver+'\n\n'+head+outline.join('\n\n')+limit;
  parts=[[null,prompt]];
 }
 if(Buffer.byteLength(prompt)>LIMITS.maxComposerBytes)throw fail('Build 输入框内容超过 1 MiB 安全大小限制；未截断预设',413,'inline_too_large');
 // build-st/: user files (images, audio, documents) go through untouched as extra inline-data parts before the composer.
 const media=Array.isArray(prepared.media)?prepared.media:[];
 if(media.length){
  const total=media.reduce((n,f)=>n+Math.floor(f.data.length*3/4),0);
  if(total>LIMITS.maxMediaBytes)throw fail('附件共 '+Math.round(total/1048576)+'MB，超过 '+Math.round(LIMITS.maxMediaBytes/1048576)+'MB 上限',413,'media_too_large');
  prompt='Attached files #1..#'+media.length+' are user-provided files referenced in the conversation as [attached file #N]; look at them directly.\n'+prompt.replace('This is a text-only conversation','This is a conversation');
  // Build rejects inline image data (Invalid argument); the page uploads each file to /_/upload and sends an upload reference.
  parts=[...media.map((f,i)=>({__upload:[f.mime,f.data,f.name?String(f.name).slice(0,120):'attachment-'+(i+1)]})),...parts.slice(0,-1),[null,prompt]];
  bytes+=total;
 }
 // Same hash input as the verified probe: each part's text, or its inline data, joined by spaces.
 const hashText=parts.map(x=>x[1]!=null?x[1]:(x[2]?x[2][1]:'')).join(' ');
 return {parts,hashText,document,bytes:bytes+Buffer.byteLength(prompt),mode:(hasFile?(parts.some(x=>x&&x.__upload&&x.__upload[0]==='text/plain')?'attachment-upload':'attachment'):'inline')+(media.length?'+media'+media.length:''),nonce,segments:segments.length};
}
module.exports={classify,classifyCode,fromEnvelope,prepare,pack,tokens,LIMITS,WIRE_PREFIX,CODE};
