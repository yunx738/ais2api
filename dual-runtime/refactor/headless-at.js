'use strict';
// anti-truncation/<model> on the no-browser backend. Same rules as the browser runtime's _atContinueUntilAnswer:
// inject seal_final_reply, accept a complete call, accept >=2000 chars of plain STOP text, continue up to 3 rounds,
// resend the original on empty replies (max 3, within 6 minutes), stop at content blocks.
const {atCleanPlainAnswer,atDecodeJsonString}=require('./at-plain');
const {DEFAULTS}=require('./at-prompt-store');
const TOOL='seal_final_reply',NAMES=['seal_final_reply','final_answer','emit_answer'];
const MAX_ATTEMPTS=3,MAX_RETRIES=3,DEADLINE_MS=960000,STOP_MIN=2000,EMPTY_DELAY=3000,ROUND_MAX_TOKENS=32768;
const fill=t=>String(t||'').split('{tool}').join(TOOL);
function preset(key,custom){
 if(key==='custom'&&custom)return {desc:fill(custom.desc),hint:fill(custom.hint),cont:custom.cont||DEFAULTS.cont};
 const p=DEFAULTS.presets[key]||DEFAULTS.presets.classic;
 return {desc:fill(p.desc),hint:fill(p.hint),cont:DEFAULTS.cont};
}
function inject(body,p){
 const b={...body,stream:false};delete b.stream_options;
 const tools=Array.isArray(b.tools)?b.tools.filter(t=>!NAMES.includes(t?.function?.name)):[];
 tools.push({type:'function',function:{name:TOOL,description:p.desc,parameters:{type:'object',properties:{answer:{type:'string'}},required:['answer']}}});
 b.tools=tools;
 const msgs=Array.isArray(b.messages)?[...b.messages]:[];
 const i=msgs.findIndex(m=>m&&m.role==='system');
 if(i>=0&&typeof msgs[i].content==='string')msgs[i]={...msgs[i],content:msgs[i].content+'\n\n'+p.hint};
 else msgs.unshift({role:'system',content:p.hint});
 b.messages=msgs;
 let capped=false;
 for(const k of ['max_tokens','max_completion_tokens'])if(Number.isSafeInteger(b[k])){if(b[k]>ROUND_MAX_TOKENS)b[k]=ROUND_MAX_TOKENS;capped=true;}
 if(!capped)b.max_tokens=ROUND_MAX_TOKENS;
 return b;
}
function extract(r){
 const c=r?.choices?.[0],m=c?.message||{};
 const finish=c?.finish_reason||null;
 let answer=null,partial='';const calls=Array.isArray(m.tool_calls)?m.tool_calls:[],extCalls=[];
 for(const tc of calls){
  const nm=tc?.function?.name;
  if(!NAMES.includes(nm)){if(nm)extCalls.push(tc);continue;}
  const raw=tc.function.arguments||'{}';
  try{const a=JSON.parse(raw);if(typeof a.answer==='string')answer=a.answer;}
  catch{const mm=/\{\s*"answer"\s*:\s*"/.exec(raw);if(mm){const dec=atDecodeJsonString(raw,mm.index+mm[0].length-1);if(dec.text)partial=dec.text;}}
 }
 const plain=typeof m.content==='string'?m.content:'';
 return {found:answer!==null,answer,partial,finish,plain,calls,extCalls,reasoning:m.reasoning_content||''};
}
function addUsage(sum,u){
 if(!u||typeof u!=='object'){sum.complete=false;return;}
 for(const k of ['prompt_tokens','completion_tokens','total_tokens'])if(Number.isSafeInteger(u[k]))sum[k]=(sum[k]||0)+u[k];
 const c=u.prompt_tokens_details?.cached_tokens;if(Number.isSafeInteger(c))sum.cached=(sum.cached||0)+c;
 const rt=u.completion_tokens_details?.reasoning_tokens;if(Number.isSafeInteger(rt))sum.reasoning=(sum.reasoning||0)+rt;
}
function usageOut(sum){
 if(!sum.complete||!Number.isSafeInteger(sum.prompt_tokens))return undefined;
 const u={prompt_tokens:sum.prompt_tokens,completion_tokens:sum.completion_tokens||0,total_tokens:sum.total_tokens||(sum.prompt_tokens+(sum.completion_tokens||0))};
 if(sum.cached!==undefined)u.prompt_tokens_details={cached_tokens:sum.cached};
 if(sum.reasoning!==undefined)u.completion_tokens_details={reasoning_tokens:sum.reasoning};
 return u;
}
// call(body) -> {status,json,text,headers}. Returns {ok:true,answer,reasoning,usage} or {ok:false,status,payload,upstream?,headers?}.
async function run({call,body,promptKey='classic',custom=null,log=console,signal}){
 const p=preset(promptKey,custom),base=inject(body,p),t0=Date.now();
 const sum={complete:true};let attempt=0,retries=0,cur=base,lastPartial=null,first=true;
 for(;;){
  if(signal?.aborted)return {ok:false,status:499,cancelled:true};
  const r=await call(cur);
  if(r.status!==200){
   if(first)return {ok:false,status:r.status,upstream:true,headers:r.headers,payload:r.json||{error:{message:String(r.text||'').slice(0,500)}}};
   return {ok:false,status:502,payload:{error:{code:502,type:'upstream_incomplete',status:'CONTINUATION_'+r.status,message:'续写请求失败（'+r.status+'）：'+String(r.json?.error?.message||r.text||'').slice(0,200)}}};
  }
  first=false;
  addUsage(sum,r.json?.usage);
  attempt++;
  const x=extract(r.json),elapsed=Date.now()-t0;
  log.info?.('[HL-AT] round '+attempt+' finish='+(x.finish||'-')+' seal='+(x.found?'yes('+x.answer.length+')':'no')+' plain='+x.plain.length+' calls='+x.calls.length+' ms='+elapsed);
  if(x.found&&x.finish!=='content_filter'&&(x.finish==='stop'||x.finish==='tool_calls'||x.answer.trim().length>0))
   return {ok:true,answer:x.answer,reasoning:x.reasoning,usage:usageOut(sum),rounds:attempt};
  if(!x.found&&x.extCalls.length&&x.calls.length===x.extCalls.length&&x.finish!=='content_filter'&&x.finish!=='length')
   return {ok:true,answer:x.plain,toolCalls:x.extCalls,reasoning:x.reasoning,usage:usageOut(sum),rounds:attempt};
  if(!x.found&&x.finish==='stop'&&!x.calls.length&&x.plain.trim().length>=STOP_MIN){
   const cl=atCleanPlainAnswer(x.plain);
   return {ok:true,answer:cl.answer,reasoning:x.reasoning,usage:usageOut(sum),rounds:attempt,plain:cl.info.how};
  }
  const u=usageOut(sum);
  if(x.finish==='content_filter')
   return {ok:false,status:502,payload:{error:{code:502,type:'content_blocked',status:'SAFETY',message:'上游内容安全拦截：模型拒绝生成，本次没有输出。这类拦截有时是误判，可以直接重试；多次被拦请调整内容。'},...(u?{usage:{prompt_tokens:u.prompt_tokens}}:{})}};
  let resend=false;
  if(!x.found&&!x.plain&&!x.calls.length&&elapsed<DEADLINE_MS&&retries<MAX_RETRIES){
   retries++;resend=true;log.warn?.('[HL-AT] empty reply; resending original '+retries+'/'+MAX_RETRIES);
   await new Promise(res=>setTimeout(res,EMPTY_DELAY));
  }
  if(!resend&&(attempt>=MAX_ATTEMPTS||elapsed>=DEADLINE_MS)){
   const chars=Math.max((x.answer||'').length,(x.partial||'').length,x.plain.length),late=elapsed>=DEADLINE_MS;
   const msg=late?'已用时约 '+Math.round(elapsed/60000)+' 分钟仍未得到完整答案，超过 16 分钟不再续写，直接返回失败。已生成约 '+chars+' 字被丢弃，可重试。'
    :'上游中途结束（finish='+(x.finish||'NO_ANSWER')+'），未返回内容。已生成约 '+chars+' 字被丢弃，可重试。';
   return {ok:false,status:502,payload:{error:{code:502,type:'upstream_incomplete',status:late?'AT_TIME_LIMIT':'FINISH_'+String(x.finish||'NO_ANSWER').toUpperCase(),message:msg},...(u?{usage:{prompt_tokens:u.prompt_tokens,completion_tokens:u.completion_tokens}}:{})}};
  }
  if(resend){attempt=0;cur=base;lastPartial=null;continue;}
  const bestAns=x.answer||x.partial||'';
  const prev=(bestAns&&bestAns.length>=x.plain.length)?bestAns:(x.plain||null);
  if(prev)lastPartial=prev;
  const msgs=[...cur.messages],m=r.json?.choices?.[0]?.message||{};
  const tcs=Array.isArray(m.tool_calls)?m.tool_calls:[];
  if(m.content||tcs.length){
   msgs.push({role:'assistant',content:m.content||null,...(tcs.length?{tool_calls:tcs}:{})});
   for(const tc of tcs)msgs.push({role:'tool',tool_call_id:tc.id,content:'{"status":"incomplete"}'});
  }
  const partial=lastPartial?'Previous partial answer: '+lastPartial+'\n\n':'';
  msgs.push({role:'user',content:fill(p.cont).split('{partial}').join(partial)});
  cur={...cur,messages:msgs,max_tokens:ROUND_MAX_TOKENS};delete cur.max_completion_tokens;
  log.info?.('[HL-AT] continuing (attempt '+(attempt+1)+'/'+MAX_ATTEMPTS+')');
 }
}
module.exports={run,inject,extract,preset,TOOL};
