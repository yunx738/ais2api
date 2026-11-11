'use strict';
// Worker side of the Build channel. Hooks processOpenAIRequest BEFORE worker-operations/worker-executions wrap it,
// so a Build call is admitted, counted busy and settled by the same execution ledger as any generation.
// The coordinator rewrites the body: {model, messages, stream, max_tokens, __build:{app, model, thinking}}.
const crypto=require('crypto');
const {prepare,pack}=require('./build-context');
const {parse,openaiUsage}=require('./build-response');
const {expression}=require('./build-page-call');
const Tools=require('./build-tools');
// Optional: an older container without the build-document.js mount just runs without anti-truncation.
let Doc=null;try{Doc=require('./build-document');}catch(e){console.warn('[BuildDoc] build-document.js unavailable, anti-truncation off: '+e.message);}
const APP=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODELS=new Set(['gemini-4-argon','gemini-4-carbon','gemini-3.8-flash']);
function install(system,{log=console}={}){
 const h=system.requestHandler;
 const hx={};let watched=null,seq=0;
 // Same headers the page sends on its own MakerSuite calls (tier / ext / visit), captured from page traffic.
 const watch=()=>{
  const ctx=system.browserManager?.context;
  if(!ctx||ctx===watched)return;
  watched=ctx;
  ctx.on('request',r=>{try{
   if(!/alkalimakersuite-pa\.clients6\.google\.com\/\$rpc\/.*MakerSuiteService\//.test(r.url()))return;
   const x=r.headers();
   if(x['x-aistudio-g1-tier'])hx.tier=x['x-aistudio-g1-tier'];
   if(x['x-goog-ext-519733851-bin'])hx.ext=x['x-goog-ext-519733851-bin'];
   if(x['x-aistudio-visit-id'])hx.visit=x['x-aistudio-visit-id'];
  }catch{}});
 };
 setInterval(watch,2000).unref();
 const original=h.processOpenAIRequest.bind(h);
 const send=(res,status,message,code='build_error')=>{
  if(res.headersSent||res.destroyed)return;
  res.status(status).json({error:{message,type:status>=500?'upstream_error':'invalid_request_error',code}});
  if(status<500){
   // Diagnostics: why a Build request was refused, plus its shape (roles, part types, keys; never the text).
   let shape=null;try{const b=res.req&&res.req.body||{};shape={keys:Object.keys(b).filter(k=>k!=='messages'&&k!=='__build').slice(0,30),spec:b.__build?{model:b.__build.model,thinking:b.__build.thinking,app:!!b.__build.app}:null,
    msgs:(Array.isArray(b.messages)?b.messages:[]).slice(-12).map(m=>m&&({r:m.role,c:typeof m.content==='string'?'s'+m.content.length:Array.isArray(m.content)?m.content.map(x=>x&&x.type||typeof x):m.content===null?'null':typeof m.content,k:Object.keys(m).filter(k=>k!=='role'&&k!=='content')})),n:Array.isArray(b.messages)?b.messages.length:-1};}catch{}
   log.warn?.('[Build] refused '+status+' '+code+': '+String(message).slice(0,160)+' shape='+JSON.stringify(shape).slice(0,1500));
  }
 };
 h.processOpenAIRequest=async(req,res)=>{
  const spec=req.body&&req.body.__build;
  if(!spec)return original(req,res);
  watch();
  const id='chatcmpl-'+crypto.randomUUID();
  if(!APP.test(spec.app||'')||!MODELS.has(spec.model)||![1,2,3].includes(spec.thinking))return send(res,400,'Build 通道参数无效');
  let packed,toolSpec=null;const toolNonce=Tools.nonce();
  try{
   const max=req.body.max_completion_tokens??req.body.max_tokens;
   // Tools: client definitions arrive as __tools (moved there by the gateway). History tool calls/results are
   // turned into text so they are kept. build-st/ envelopes already carry history as text.
   toolSpec=Tools.normalize(req.body.__tools);
   const msgs=Tools.flatten(req.body.messages).messages;
   const prepared=prepare(msgs,{keepMedia:spec.keepMedia===true,mode:spec.mode});
   const d=prepared.dropped;
   if(d&&(d.parts||d.messages||d.toolCalls||d.segments))log.info?.('[Build] dropped unsupported content '+JSON.stringify(d));
   packed=pack(prepared,{requestedMaxOutputTokens:Number.isSafeInteger(max)&&max>0?max:undefined,extra:Tools.instructions(toolSpec,toolNonce),code:spec.mode==='code',document:Doc&&Doc.NAME.test(spec.document||'')?spec.document:null});
  }catch(e){return send(res,e.statusCode||400,e.message,e.code||'build_context_invalid');}
  const page=system.browserManager?.page;
  if(!page||page.isClosed())return send(res,503,'工作页面不可用','page_unavailable');
  const op='b'+(++seq);let closed=false;
  const onClose=()=>{if(res.writableEnded)return;closed=true;page.evaluate(o=>{const w=window.wrappedJSObject;const c=w.__gcAb&&w.__gcAb[o];if(c){c.__cancel=true;c.abort();}},op).catch(()=>{});};
  res.on('close',onClose);
  const t0=Date.now();
  let raw;
  try{
   const code=expression({parts:packed.parts,model:spec.model,thinking:spec.thinking,hx,app:spec.app,opts:{hardMs:1200000,op}});
   let timer;
   raw=await Promise.race([page.evaluate(c=>window.wrappedJSObject.eval(c),code),new Promise(r=>{timer=setTimeout(()=>r(JSON.stringify({s:504,stage:'page',t:'page timeout'})),630000);})]).finally(()=>clearTimeout(timer));
  }catch(e){res.removeListener('close',onClose);return send(res,502,'页面执行失败：'+String(e&&e.message||e).slice(0,160),'page_eval_failed');}
  res.removeListener('close',onClose);
  let r;try{r=JSON.parse(raw);}catch{return send(res,502,'页面返回无法解析','page_unparseable');}
  // Diagnostics only: one line per signing attempt (length/prefix of the signature, never the signature itself).
  try{for(const [i,x] of (Array.isArray(r.sd)?r.sd:[]).entries())log.info?.('[SigDiag] '+JSON.stringify({ch:'build',acct:process.env.WORKER_ACCOUNT||null,model:spec.model,attempt:i,...x}));}catch{}
  log.info?.('[Build] '+spec.model+' t'+spec.thinking+' '+packed.mode+' bytes='+packed.bytes+' stage='+r.stage+' status='+r.s+' tries='+(r.tries||0)+' resent='+(r.resent||0)+' polls='+(r.polls||0)+' firstModel='+(r.firstModel||0)+' pollMs='+(r.pollMs||0)+' ms='+(Date.now()-t0));
  if(closed||r.s===499)return;
  if(r.stage!=='stream'||r.s!==200){
   // 401 would make the scheduler cool the whole account for a day; a Build-only failure must not do that.
   const status=[400,403,404,413,429].includes(r.s)?r.s:r.s===503?503:502;
   if(r.s===429)res.setHeader('Retry-After','60');
   return send(res,status,'Build 上游错误 ('+r.stage+' '+r.s+')：'+String(r.t||'').slice(0,300),'build_upstream_'+r.s);
  }
  const out=parse(r.t);
  if(!out.ok){
   // Diagnostics: keep the last unparseable/no-model-turn upstream body (model output only; no signature/auth).
   try{require('fs').writeFileSync('/tmp/build-last-parsefail.txt',String(r.t||''));}catch{}
   log.warn?.('[Build] parse failed error='+out.error+' polls='+(r.polls||0)+' bytes='+String(r.t||'').length+' head='+JSON.stringify(String(r.t||'').slice(0,160))+' tail='+JSON.stringify(String(r.t||'').replace(/"[A-Za-z0-9+\/=]{200,}"/g,'"<b64>"').slice(-700)));
   // Google rejected the generation right after submit; the same input fails every time, so tell the user to edit it.
   // X-AIS-Build-Retry: the coordinator may replay this request once on another account (other slot).
   if(out.upstreamFailed){if(!res.headersSent)res.setHeader('X-AIS-Build-Retry','upstream_failed');return send(res,400,'谷歌拒绝生成这条请求（'+out.error+'）。通常是输入内容触发了谷歌的内容审查，同样的内容重试也会失败，请修改输入内容（例如改写最新消息、删减近期聊天记录或世界书条目）后重试。','build_input_rejected');}
   return send(res,502,'Build 回复解析失败：'+out.error,'build_parse_failed');
  }
  if(!out.complete||!out.text.trim()){
   // Diagnostics: keep the last incomplete upstream body (model output only; no signature/auth) for inspection.
   try{require('fs').writeFileSync('/tmp/build-last-incomplete.txt',String(r.t||''));}catch{}
   log.warn?.('[Build] incomplete reply turns='+(out.turns||'?')+' textLen='+out.text.length+' thoughtLen='+out.thought.length+' usage='+JSON.stringify(out.usage)+' bytes='+String(r.t||'').length);
  }
  if(!out.complete||!out.text.trim())return send(res,502,'Build 回复不完整（未收到结束标记或正文为空），请重试','build_incomplete');
  // Anti-truncation: use the reply file when it can be found and verified; otherwise fall back to the chat text.
  if(packed.document){
   let why='no_file';
   try{
    const hash=Doc.findHash(r.t,packed.document);
    if(hash){
     const got=JSON.parse(await page.evaluate(c=>window.wrappedJSObject.eval(c),Doc.readExpression(spec.app,hash)));
     if(got&&got.ok&&typeof got.text==='string'&&got.text.trim()){log.info?.('[BuildDoc] file used bytes='+got.len+' chat='+out.text.length);out.text=got.text;why=null;}
     else why='read_'+(got&&(got.err||got.s)||'failed');
    }
   }catch(e){why='error '+String(e&&e.message||e).slice(0,120);}
   if(why){
    log.warn?.('[BuildDoc] fallback to chat reason='+why+' chat='+out.text.length);
    if(Doc.isAck(out.text))return send(res,502,'抗截断回复文件读取失败（'+why+'），聊天正文里也没有内容，请重试','build_document_missing');
   }
  }
  const usage=openaiUsage(out.usage),model=req.body.model,created=Math.floor(Date.now()/1000);
  const tc=Tools.extract(out.text,toolSpec,toolNonce);
  if(toolSpec)log.info?.('[BuildTools] tools='+toolSpec.tools.length+' mode='+toolSpec.mode+' calls='+tc.calls.length+(tc.rejected.length?' rejected='+JSON.stringify(tc.rejected.slice(0,4)):''));
  const calls=tc.calls.length?tc.calls:null,finish=calls?'tool_calls':'stop';
  const message={role:'assistant',content:calls&&!tc.content.trim()?null:tc.content,...(calls?{tool_calls:calls}:{}),...(out.thought?{reasoning_content:out.thought}:{})};
  if(req.body.stream===true){
   res.status(200);res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache');
   const base={id,object:'chat.completion.chunk',created,model};
   const frames=[];
   if(out.thought)frames.push({...base,choices:[{index:0,delta:{role:'assistant',reasoning_content:out.thought},finish_reason:null}]});
   if(message.content)frames.push({...base,choices:[{index:0,delta:{role:'assistant',content:message.content},finish_reason:null}]});
   if(calls)frames.push({...base,choices:[{index:0,delta:{role:'assistant',tool_calls:calls.map((c,index)=>({index,...c}))},finish_reason:null}]});
   frames.push({...base,choices:[{index:0,delta:{},finish_reason:finish}],usage});
   return res.end(frames.map(f=>'data: '+JSON.stringify(f)+'\n\n').join('')+'data: [DONE]\n\n');
  }
  res.status(200).json({id,object:'chat.completion',created,model,choices:[{index:0,message,finish_reason:finish}],usage});
 };
 return {hx};
}
module.exports={install};
