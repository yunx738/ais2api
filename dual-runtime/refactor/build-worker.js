'use strict';
// Worker side of the Build channel. Hooks processOpenAIRequest BEFORE worker-operations/worker-executions wrap it,
// so a Build call is admitted, counted busy and settled by the same execution ledger as any generation.
// The coordinator rewrites the body: {model, messages, stream, max_tokens, __build:{app, model, thinking}}.
const crypto=require('crypto');
const {prepare,pack}=require('./build-context');
const {parse,openaiUsage}=require('./build-response');
const {expression}=require('./build-page-call');
const APP=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODELS=new Set(['gemini-4-argon','gemini-3.8-flash']);
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
 };
 h.processOpenAIRequest=async(req,res)=>{
  const spec=req.body&&req.body.__build;
  if(!spec)return original(req,res);
  watch();
  const id='chatcmpl-'+crypto.randomUUID();
  if(!APP.test(spec.app||'')||!MODELS.has(spec.model)||![1,2,3].includes(spec.thinking))return send(res,400,'Build 通道参数无效');
  let packed;
  try{
   const max=req.body.max_completion_tokens??req.body.max_tokens;
   packed=pack(prepare(req.body.messages),{requestedMaxOutputTokens:Number.isSafeInteger(max)&&max>0?max:undefined});
  }catch(e){return send(res,e.statusCode||400,e.message,e.code||'build_context_invalid');}
  const page=system.browserManager?.page;
  if(!page||page.isClosed())return send(res,503,'工作页面不可用','page_unavailable');
  const op='b'+(++seq);let closed=false;
  const onClose=()=>{if(res.writableEnded)return;closed=true;page.evaluate(o=>{const w=window.wrappedJSObject;const c=w.__gcAb&&w.__gcAb[o];if(c){c.__cancel=true;c.abort();}},op).catch(()=>{});};
  res.on('close',onClose);
  const t0=Date.now();
  let raw;
  try{
   const code=expression({parts:packed.parts,model:spec.model,thinking:spec.thinking,hx,app:spec.app,opts:{hardMs:600000,op}});
   let timer;
   raw=await Promise.race([page.evaluate(c=>window.wrappedJSObject.eval(c),code),new Promise(r=>{timer=setTimeout(()=>r(JSON.stringify({s:504,stage:'page',t:'page timeout'})),630000);})]).finally(()=>clearTimeout(timer));
  }catch(e){res.removeListener('close',onClose);return send(res,502,'页面执行失败：'+String(e&&e.message||e).slice(0,160),'page_eval_failed');}
  res.removeListener('close',onClose);
  let r;try{r=JSON.parse(raw);}catch{return send(res,502,'页面返回无法解析','page_unparseable');}
  log.info?.('[Build] '+spec.model+' t'+spec.thinking+' '+packed.mode+' bytes='+packed.bytes+' stage='+r.stage+' status='+r.s+' tries='+(r.tries||0)+' ms='+(Date.now()-t0));
  if(closed||r.s===499)return;
  if(r.stage!=='stream'||r.s!==200){
   // 401 would make the scheduler cool the whole account for a day; a Build-only failure must not do that.
   const status=[400,403,404,413,429].includes(r.s)?r.s:r.s===503?503:502;
   if(r.s===429)res.setHeader('Retry-After','60');
   return send(res,status,'Build 上游错误 ('+r.stage+' '+r.s+')：'+String(r.t||'').slice(0,300),'build_upstream_'+r.s);
  }
  const out=parse(r.t);
  if(!out.ok)return send(res,502,'Build 回复解析失败：'+out.error,'build_parse_failed');
  if(!out.complete||!out.text.trim()){
   // Diagnostics: keep the last incomplete upstream body (model output only; no signature/auth) for inspection.
   try{require('fs').writeFileSync('/tmp/build-last-incomplete.txt',String(r.t||''));}catch{}
   log.warn?.('[Build] incomplete reply turns='+(out.turns||'?')+' textLen='+out.text.length+' thoughtLen='+out.thought.length+' usage='+JSON.stringify(out.usage)+' bytes='+String(r.t||'').length);
  }
  if(!out.complete||!out.text.trim())return send(res,502,'Build 回复不完整（未收到结束标记或正文为空），请重试','build_incomplete');
  const usage=openaiUsage(out.usage),model=req.body.model,created=Math.floor(Date.now()/1000);
  const message={role:'assistant',content:out.text,...(out.thought?{reasoning_content:out.thought}:{})};
  if(req.body.stream===true){
   res.status(200);res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache');
   const base={id,object:'chat.completion.chunk',created,model};
   const frames=[];
   if(out.thought)frames.push({...base,choices:[{index:0,delta:{role:'assistant',reasoning_content:out.thought},finish_reason:null}]});
   frames.push({...base,choices:[{index:0,delta:{role:'assistant',content:out.text},finish_reason:null}]});
   frames.push({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage});
   return res.end(frames.map(f=>'data: '+JSON.stringify(f)+'\n\n').join('')+'data: [DONE]\n\n');
  }
  res.status(200).json({id,object:'chat.completion',created,model,choices:[{index:0,message,finish_reason:'stop'}],usage});
 };
 return {hx};
}
module.exports={install};
