'use strict';
// Coordinator forward() for the no-browser backend. Same contract as forward-worker.js:
// resolves {status, retryAfter, metrics, rejection?, uncertain?, cancelled?}; never throws after the response started.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {ResponseMetrics}=require('./response-metrics');
const H=require('./build-headless');
const AT=require('./headless-at');
const {prepare,pack}=require('./build-context');
const {parse:parseBuild,openaiUsage}=require('./build-response');
const Tools=require('./build-tools');
const Doc=require('./build-document');
const APP=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUILD_MODELS=new Set(['gemini-4-argon','gemini-3.8-flash']);
const AT_PREFIX='anti-truncation/';
// Coordinator account number -> headless account ID (directory name = login e-mail).
function accountEmail(id,authDir='/opt/ais2api/auth'){
 try{const d=JSON.parse(fs.readFileSync(path.join(authDir,'auth-'+id+'.json'),'utf8'));
  for(const v of [d.accountName,d.displayName])if(typeof v==='string'&&/^[^\s@]+@[^\s@]+$/.test(v.trim()))return v.trim().toLowerCase();}catch{}
 return null;
}
function observe(res,stream){
 const obs=new ResponseMetrics({stream});
 const w=res.write.bind(res),e=res.end.bind(res);
 res.write=(c,...a)=>{if(c&&typeof c!=='function')obs.write(Buffer.isBuffer(c)?c:Buffer.from(String(c)));return w(c,...a);};
 res.end=(c,...a)=>{if(c&&typeof c!=='function')obs.write(Buffer.isBuffer(c)?c:Buffer.from(String(c)));return e(c,...a);};
 return obs;
}
function createHeadlessForward({service,emailOf=accountEmail,log=console}){
 const json=(res,status,obj,headers={})=>{
  if(res.headersSent||res.destroyed||res.writableEnded)return;
  res.statusCode=status;res.setHeader('Content-Type','application/json');
  for(const [k,v] of Object.entries(headers))res.setHeader(k,v);
  res.end(JSON.stringify(obj));
 };
 // OpenAI completion (or one SSE frame set) from a final message.
 const completion=(res,{model,stream,message,finish,usage})=>{
  const id='chatcmpl-'+crypto.randomUUID(),created=Math.floor(Date.now()/1000);
  if(stream){
   res.statusCode=200;res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache');
   const base={id,object:'chat.completion.chunk',created,model},frames=[];
   if(message.reasoning_content)frames.push({...base,choices:[{index:0,delta:{role:'assistant',reasoning_content:message.reasoning_content},finish_reason:null}]});
   if(message.content)frames.push({...base,choices:[{index:0,delta:{role:'assistant',content:message.content},finish_reason:null}]});
   if(message.tool_calls)frames.push({...base,choices:[{index:0,delta:{role:'assistant',tool_calls:message.tool_calls.map((c,index)=>({index,...c}))},finish_reason:null}]});
   frames.push({...base,choices:[{index:0,delta:{},finish_reason:finish}],...(usage?{usage}:{})});
   return res.end(frames.map(f=>'data: '+JSON.stringify(f)+'\n\n').join('')+'data: [DONE]\n\n');
  }
  json(res,200,{id,object:'chat.completion',created,model,choices:[{index:0,message,finish_reason:finish}],...(usage?{usage}:{})});
 };
 const RETRY_STATUS=new Set([401,403,429]);
 const rejectionOf=(status,headers,bodyBuf)=>({status,headers:{'content-type':headers?.['content-type']||'application/json',...(headers?.['retry-after']!==undefined?{'retry-after':headers['retry-after']}:{})},body:bodyBuf});
 // Plain passthrough: chat completions or native generateContent, pinned to the account. Streams as-is.
 async function passthrough(ticket,route,body,res,email,options){
  const upstream=await service.request(email,'POST',route,body,{signal:options.signal}).catch(e=>({error:e}));
  if(upstream.error){
   if(options.signal?.aborted)return {uncertain:true};
   json(res,502,{error:{message:'无浏览器服务连接失败',code:'headless_unavailable'}});return {status:502};
  }
  const status=upstream.statusCode,retryAfter=upstream.headers['retry-after'];
  const stream=String(upstream.headers['content-type']||'').includes('text/event-stream');
  const obs=new ResponseMetrics({stream});
  const deferred=options.deferRejections===true&&RETRY_STATUS.has(status);
  return await new Promise(resolve=>{
   let ended=false;const chunks=[];let size=0,held=deferred;
   const finish=r=>{if(ended)return;ended=true;res.removeListener('close',onClose);resolve({status,retryAfter,...r,metrics:obs.finish({complete:!r.uncertain&&!r.cancelled})});};
   const onClose=()=>{if(!res.writableEnded){upstream.destroy();finish(obs.stream&&obs.done?{uncertain:true}:{cancelled:true});}};
   res.on('close',onClose);
   const publish=()=>{res.statusCode=status;for(const k of ['content-type','retry-after','cache-control'])if(upstream.headers[k]!==undefined)res.setHeader(k,upstream.headers[k]);};
   if(!held)publish();
   upstream.on('data',c=>{obs.write(c);
    if(held){size+=c.length;chunks.push(c);if(size>65536){held=false;publish();for(const x of chunks)res.write(x);chunks.length=0;}return;}
    res.write(c);});
   upstream.on('end',()=>{
    if(held)return finish({rejection:rejectionOf(status,upstream.headers,Buffer.concat(chunks))});
    res.end();finish({});
   });
   upstream.on('aborted',()=>{finish({uncertain:true});if(!res.destroyed)res.destroy();});
   upstream.on('error',()=>{finish({uncertain:true});if(!res.destroyed)res.destroy();});
  });
 }
 // anti-truncation/<model>: our seal loop over the pinned OpenAI endpoint; answer delivered as one completion.
 async function antiTruncation(ticket,parsed,res,email,options){
  const model=parsed.model,real=model.slice(AT_PREFIX.length);
  const stream=parsed.stream===true;
  const body={...parsed,model:real};
  let custom=null;
  if(options.atPrompt==='custom'&&options.atPromptCustom){try{custom=JSON.parse(Buffer.from(options.atPromptCustom,'base64').toString('utf8'));}catch{}}
  const obs=observe(res,stream);
  const t0=Date.now();
  const r=await AT.run({call:b=>service.call(email,'POST','/v1/chat/completions',b,{signal:options.signal}).catch(e=>({status:options.signal?.aborted?499:502,json:{error:{message:String(e.message||e).slice(0,200)}}})),
   body,promptKey:options.atPrompt||'classic',custom,log,signal:options.signal}).catch(e=>({ok:false,status:502,payload:{error:{message:'抗截断执行失败：'+String(e.message||e).slice(0,160)}}}));
  log.info?.('[HL] AT #'+ticket.account+' '+real+' ok='+r.ok+' status='+(r.status||200)+' rounds='+(r.rounds||'-')+' ms='+(Date.now()-t0));
  if(r.cancelled||res.destroyed)return {cancelled:true,metrics:obs.finish({complete:false})};
  if(!r.ok){
   const st=r.status||502;
   if(r.upstream&&options.deferRejections===true&&RETRY_STATUS.has(st))
    return {status:st,retryAfter:r.headers?.['retry-after'],rejection:rejectionOf(st,r.headers,Buffer.from(JSON.stringify(r.payload))),metrics:obs.finish({complete:true})};
   json(res,st,r.payload,r.headers?.['retry-after']?{'Retry-After':r.headers['retry-after']}:{});
   return {status:st,retryAfter:r.headers?.['retry-after'],metrics:obs.finish({complete:true})};
  }
  completion(res,{model,stream,message:{role:'assistant',content:r.answer,...(r.reasoning?{reasoning_content:r.reasoning}:{})},finish:'stop',usage:r.usage});
  return {status:200,metrics:obs.finish({complete:true})};
 }
 // Build prefixes: same composition as build-worker.js, but signed/sent by the headless service. Body carries __build.
 async function build(ticket,parsed,res,email,options){
  const spec=parsed.__build,obs=observe(res,parsed.stream===true);
  const done=r=>({...r,metrics:obs.finish({complete:!r.cancelled})});
  const fail=(status,message,code,headers={})=>{json(res,status,{error:{message,type:status>=500?'upstream_error':'invalid_request_error',code}},headers);return done({status});};
  if(!APP.test(spec.app||'')||!BUILD_MODELS.has(spec.model)||![1,2,3].includes(spec.thinking))return fail(400,'Build 通道参数无效','build_error');
  let packed,toolSpec=null;const toolNonce=Tools.nonce();
  try{
   const max=parsed.max_completion_tokens??parsed.max_tokens;
   toolSpec=Tools.normalize(parsed.__tools);
   const msgs=Tools.flatten(parsed.messages).messages;
   const prepared=prepare(msgs,{keepMedia:spec.keepMedia===true,mode:spec.mode});
   packed=pack(prepared,{requestedMaxOutputTokens:Number.isSafeInteger(max)&&max>0?max:undefined,extra:Tools.instructions(toolSpec,toolNonce),code:spec.mode==='code',document:Doc.NAME.test(spec.document||'')?spec.document:null});
  }catch(e){return fail(e.statusCode||400,e.message,e.code||'build_context_invalid');}
  const ac=new AbortController();
  const onClose=()=>{if(!res.writableEnded)ac.abort();};
  res.on('close',onClose);options.signal?.addEventListener('abort',()=>ac.abort(),{once:true});
  const t0=Date.now();
  let r;
  try{r=await H.callBuild(service.raw,{account:email,parts:packed.parts,model:spec.model,thinking:spec.thinking,app:spec.app,hardMs:600000,signal:ac.signal});}
  finally{res.removeListener('close',onClose);}
  log.info?.('[HL-Build] #'+ticket.account+' '+spec.model+' t'+spec.thinking+' '+packed.mode+' bytes='+packed.bytes+' stage='+r.stage+' status='+r.s+' tries='+(r.tries||0)+' resent='+(r.resent||0)+' polls='+(r.polls||0)+' ms='+(Date.now()-t0));
  if(ac.signal.aborted||r.s===499){if(!res.destroyed)res.destroy();return done({cancelled:true});}
  if(r.stage!=='stream'||r.s!==200){
   const status=[400,403,404,413,429].includes(r.s)?r.s:r.s===503?503:502;
   return fail(status,'Build 上游错误 ('+r.stage+' '+r.s+')：'+String(r.t||'').slice(0,300),'build_upstream_'+r.s,r.s===429?{'Retry-After':'60'}:{});
  }
  const out=parseBuild(r.t);
  if(!out.ok){
   try{fs.writeFileSync('/tmp/build-last-parsefail.txt',String(r.t||''));}catch{}
   if(out.upstreamFailed){
    const payload={error:{message:'谷歌拒绝生成这条请求（'+out.error+'）。通常是输入内容触发了谷歌的内容审查，同样的内容重试也会失败，请修改输入内容（例如改写最新消息、删减近期聊天记录或世界书条目）后重试。',type:'invalid_request_error',code:'build_input_rejected'}};
    if(options.deferRejections===true)return done({status:400,rejection:{status:400,headers:{'content-type':'application/json','x-ais-build-retry':'upstream_failed'},body:Buffer.from(JSON.stringify(payload))}});
    json(res,400,payload,{'X-AIS-Build-Retry':'upstream_failed'});return done({status:400});
   }
   return fail(502,'Build 回复解析失败：'+out.error,'build_parse_failed');
  }
  if(!out.complete||!out.text.trim()){
   try{fs.writeFileSync('/tmp/build-last-incomplete.txt',String(r.t||''));}catch{}
   return fail(502,'Build 回复不完整（未收到结束标记或正文为空），请重试','build_incomplete');
  }
  if(packed.document){
   let why='no_file';
   try{const hash=Doc.findHash(r.t,packed.document);
    if(hash){const got=await H.readFile(service.raw,{account:email,app:spec.app,hash});
     if(got.ok&&got.text.trim()){log.info?.('[HL-BuildDoc] file used bytes='+got.len+' chat='+out.text.length);out.text=got.text;why=null;}
     else why='read_'+(got.err||got.s);}
   }catch(e){why='error '+String(e.message||e).slice(0,120);}
   if(why){log.warn?.('[HL-BuildDoc] fallback to chat reason='+why+' chat='+out.text.length);
    if(Doc.isAck(out.text))return fail(502,'抗截断回复文件读取失败（'+why+'），聊天正文里也没有内容，请重试','build_document_missing');}
  }
  const usage=openaiUsage(out.usage);
  const tc=Tools.extract(out.text,toolSpec,toolNonce);
  if(toolSpec)log.info?.('[HL-BuildTools] tools='+toolSpec.tools.length+' calls='+tc.calls.length+(tc.rejected.length?' rejected='+tc.rejected.length:''));
  const calls=tc.calls.length?tc.calls:null;
  const message={role:'assistant',content:calls&&!tc.content.trim()?null:tc.content,...(calls?{tool_calls:calls}:{}),...(out.thought?{reasoning_content:out.thought}:{})};
  completion(res,{model:parsed.model,stream:parsed.stream===true,message,finish:calls?'tool_calls':'stop',usage});
  return done({status:200});
 }
 async function forward(ticket,route,body,res,credentials,options={}){
  if(!Buffer.isBuffer(body))throw Error('Body must be buffered before dispatch');
  if(options.signal?.aborted)return {uncertain:true};
  const email=emailOf(ticket.account);
  if(!email){json(res,503,{error:{message:'账号 #'+ticket.account+' 没有登录邮箱，无浏览器服务无法使用',code:'headless_account_unknown'}});return {status:503,workerRejection:'headless_account'};}
  let parsed=null;if(route==='/v1/chat/completions'){try{parsed=JSON.parse(body.toString('utf8'));}catch{}}
  try{
   if(parsed&&parsed.__build)return await build(ticket,parsed,res,email,options);
   if(parsed&&typeof parsed.model==='string'&&parsed.model.startsWith(AT_PREFIX))return await antiTruncation(ticket,parsed,res,email,options);
   return await passthrough(ticket,route,body,res,email,options);
  }catch(e){
   log.error?.('[HL] forward failed: '+String(e&&e.message||e).slice(0,200));
   if(!res.headersSent){json(res,502,{error:{message:'无浏览器执行失败',code:'headless_failed'}});return {status:502};}
   if(!res.destroyed)res.destroy();return {uncertain:true};
  }
 }
 return forward;
}
module.exports={createHeadlessForward,accountEmail};
