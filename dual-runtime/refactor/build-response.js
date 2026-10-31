'use strict';
// Parse StreamCodeAssistantOfflineGeneration (application/json+protobuf, one JSON array).
// Each item: [null,null,[turn],appId]; turn=[[[parts,role]],...,status@11,phase@12,model@13,...,usage@16,taskId@17].
// Model turns repeat cumulatively; the last model turn holds the final text. part[12]===1 marks a thought.
// usage = [uncachedPrompt, output(, cachedPrompt)] as decimal strings (cached omitted without a cache hit).
function turns(raw){
 const out=[];let J;
 try{J=JSON.parse(raw);}catch{return {turns:out,error:'unparseable'};}
 const walk=(v,d)=>{
  if(d>6||!Array.isArray(v))return;
  // a turn looks like [[[parts,'role']], ... 'models/...' ...]
  if(Array.isArray(v[0])&&Array.isArray(v[0][0])&&Array.isArray(v[0][0][0])&&typeof v[0][0][1]==='string'&&['user','model'].includes(v[0][0][1])&&v.some(x=>typeof x==='string'&&x.startsWith('models/'))){out.push(v);return;}
  for(const x of v)walk(x,d+1);
 };
 walk(J,0);
 return {turns:out,json:J};
}
const num=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>=0?n:0;};
function parse(raw){
 const {turns:list,error}=turns(raw);
 if(error)return {ok:false,error};
 const models=list.filter(t=>t[0][0][1]==='model');
 const last=models[models.length-1];
 if(!last){
  const m=/\[\s*\d+\s*,\s*"([^"]{1,300})"\s*\]/.exec(String(raw));
  return {ok:false,error:m?m[1]:'no model turn'};
 }
 let text='',thought='';
 for(const p of last[0][0][0]||[]){
  if(!Array.isArray(p)||typeof p[1]!=='string')continue;
  if(p[12]===1)thought+=p[1];else text+=p[1];
 }
 let usage=null;
 for(let i=last.length-1;i>=0;i--){
  const u=last[i];
  // [uncachedPrompt, output] or [uncachedPrompt, output, cachedPrompt]; Google omits cached when there is no cache hit.
  if(Array.isArray(u)&&(u.length===2||u.length===3)&&u.every(x=>typeof x==='string'&&/^\d+$/.test(x))){usage={uncached:num(u[0]),output:num(u[1]),cached:u.length===3?num(u[2]):0};break;}
 }
 const model=last.find(x=>typeof x==='string'&&x.startsWith('models/'));
 return {ok:true,text,thought,usage,model:model?model.slice(7):null,complete:!!usage};
}
function openaiUsage(u){
 if(!u)return null;
 const prompt=u.uncached+u.cached;
 return {prompt_tokens:prompt,completion_tokens:u.output,total_tokens:prompt+u.output,prompt_tokens_details:{cached_tokens:u.cached}};
}
module.exports={parse,turns,openaiUsage};
