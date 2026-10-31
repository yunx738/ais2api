'use strict';
// Coordinator side of the Build channel.
// Model names: build/<base>[-low|-medium|-high], build-st/<base>[...] (same; the -st prefix is kept for
// clients configured for build-standalone). base: gemini-4-argon, gemini-3.8-flash. Default thinking = high.
// Quota: separate daily TOKEN budget per account (input+output, cached input included), reset 15:00 Beijing.
const fs=require('fs'),path=require('path');
const {periodStart,WINDOW}=require('./model-quota-ledger');
const BASES=['gemini-4-argon','gemini-3.8-flash'];
const LEVELS={low:1,medium:2,high:3};
const PREFIXES=['build/','build-st/'];
// null = no daily cap (usage is still recorded); 0 = not allowed.
const DEFAULT_LIMITS=Object.freeze({standard:0,pro:null,ultra:null,ultra20:null});
function parseBuildModel(name){
 if(typeof name!=='string')return null;
 const prefix=PREFIXES.find(p=>name.startsWith(p));
 if(!prefix)return null;
 const rest=name.slice(prefix.length);
 for(const base of BASES){
  if(rest===base)return {requested:name,prefix,model:base,thinking:3,level:'high'};
  for(const [level,n] of Object.entries(LEVELS))if(rest===base+'-'+level)return {requested:name,prefix,model:base,thinking:n,level};
 }
 throw Object.assign(Error('Build 通道没有此模型：'+name+'（可用：'+listModels().join(', ')+'）'),{statusCode:404});
}
function listModels(){
 const out=[];
 for(const p of PREFIXES)for(const b of BASES){out.push(p+b);for(const l of Object.keys(LEVELS))out.push(p+b+'-'+l);}
 return out;
}
class BuildTokenLedger{
 constructor(file,{clock=Date.now,tierOf=()=>'standard',limits={}}={}){
  this.file=file;this.clock=clock;this.tierOf=tierOf;this.limits={...DEFAULT_LIMITS,...limits};
  this.data={version:1,accounts:{}};
  try{const d=JSON.parse(fs.readFileSync(file,'utf8'));if(d&&d.version===1&&d.accounts&&typeof d.accounts==='object')this.data=d;}catch{}
  // tokens reserved by requests in flight, so concurrent requests cannot overshoot the budget much
  this.reserved=new Map();
 }
 limitFor(id){const l=this.limits[this.tierOf(id)];if(l===null)return null;return Number.isSafeInteger(l)&&l>=0?l:0;}
 entry(id,now=this.clock()){
  const a=this.data.accounts[String(id)];
  if(!a||a.windowStart<periodStart(now))return {used:0,windowStart:periodStart(now),cooldownUntil:a?.cooldownUntil||0,requests:0,input:0,output:0,cached:0,failed:0,models:{}};
  return a;
 }
 view(id,now=this.clock()){
  const e=this.entry(id,now),limit=this.limitFor(id),reserved=this.reserved.get(id)||0;
  const remaining=limit===null?null:Math.max(0,limit-e.used-reserved);
  return {account:id,tier:this.tierOf(id),limit,used:e.used,reserved,remaining,requests:e.requests||0,
   input:e.input||0,output:e.output||0,cached:e.cached||0,failed:e.failed||0,models:e.models||{},
   windowStart:periodStart(now),windowEnd:periodStart(now)+WINDOW,cooldownUntil:e.cooldownUntil||0,
   unlimited:limit===null,allowed:(limit===null||limit>0&&remaining>0)&&(e.cooldownUntil||0)<=now};
 }
 reserve(id,estimate){const n=Math.max(0,Math.floor(estimate||0));this.reserved.set(id,(this.reserved.get(id)||0)+n);return n;}
 release(id,n){const left=(this.reserved.get(id)||0)-n;if(left>0)this.reserved.set(id,left);else this.reserved.delete(id);}
 charge(id,tokens,now=this.clock(),detail={}){
  // detail {input,output,cached,model}: display only; the ledger counts `tokens`.
  if(now&&typeof now==='object'){detail=now;now=this.clock();}
  const n=Math.max(0,Math.floor(tokens||0)),k=v=>Number.isSafeInteger(v)&&v>0?v:0;
  const e=this.entry(id,now),models={...(e.models||{})};
  if(typeof detail.model==='string'&&detail.model){const m=models[detail.model]||{requests:0,tokens:0};models[detail.model]={requests:m.requests+1,tokens:m.tokens+n};}
  const next={used:e.used+n,windowStart:e.windowStart,cooldownUntil:e.cooldownUntil||0,requests:(e.requests||0)+1,
   input:(e.input||0)+k(detail.input),output:(e.output||0)+k(detail.output),cached:(e.cached||0)+k(detail.cached),failed:e.failed||0,models};
  this.data.accounts[String(id)]=next;this.save();
  return next;
 }
 fail(id,now=this.clock()){const e=this.entry(id,now);this.data.accounts[String(id)]={...e,failed:(e.failed||0)+1};this.save();}
 // Last 50 Build calls: metadata only, never request/response text.
 log(item){const r=Array.isArray(this.data.recent)?this.data.recent:[];r.push(item);this.data.recent=r.slice(-50);this.save();}
 recent(){return Array.isArray(this.data.recent)?this.data.recent.slice().reverse():[];}
 defer(id,until){
  const e=this.entry(id);
  this.data.accounts[String(id)]={...e,cooldownUntil:Math.max(e.cooldownUntil||0,until)};this.save();
 }
 save(){
  const tmp=this.file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(this.data),{mode:0o600});fs.renameSync(tmp,this.file);
 }
 summary(ids){return ids.map(id=>this.view(id));}
}
module.exports={parseBuildModel,listModels,BuildTokenLedger,DEFAULT_LIMITS,BASES,PREFIXES};
