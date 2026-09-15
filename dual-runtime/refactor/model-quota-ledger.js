 'use strict';
const WINDOW=86400000;
const LIMITS=Object.freeze({flash:100,pro:10});
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=o=>Boolean(o)&&typeof o==='object'&&!Array.isArray(o);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function accountKey(id){if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid quota account');return String(id);}
function modelKey(id){
 if(typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id))throw Error('Canonical model ID required');
 return id;
}
function familyKey(f){if(!own(LIMITS,f))throw Error('Explicit flash/pro family required');return f;}
function validate(raw){
 if(!object(raw)||raw.version!==1||!object(raw.accounts)||Object.keys(raw).some(k=>!['version','accounts'].includes(k)))throw Error('Invalid model quota ledger');
 if(Object.keys(raw.accounts).length>10000)throw Error('Too many quota accounts');
 for(const [id,a] of Object.entries(raw.accounts)){
  if(accountKey(Number(id))!==id||!object(a)||!integer(a.windowStart)||!object(a.models)||Object.keys(a).some(k=>!['windowStart','models','legacy'].includes(k)))throw Error('Invalid account quota');
  if(Object.keys(a.models).length>10000)throw Error('Too many model quotas');
  for(const [model,q] of Object.entries(a.models)){
   modelKey(model);
   if(!object(q)||Object.keys(q).some(k=>!['family','used','cooldownUntil'].includes(k)))throw Error('Invalid model quota');
   familyKey(q.family);
   if(!integer(q.used)||!integer(q.cooldownUntil)||q.used>Number.MAX_SAFE_INTEGER-1)throw Error('Invalid model counters');
   if(q.used>0&&a.windowStart===0)throw Error('Missing quota window');
  }
  if(a.legacy!==null){
   const x=a.legacy;
   if(!object(x)||!integer(x.until)||x.until===0||!object(x.evidence)||!Array.isArray(x.blockedFamilies)||!x.blockedFamilies.length||
      new Set(x.blockedFamilies).size!==x.blockedFamilies.length||Object.keys(x).some(k=>!['until','evidence','blockedFamilies'].includes(k)))throw Error('Invalid legacy uncertainty');
   x.blockedFamilies.forEach(familyKey);
   if(Object.values(x.evidence).some(n=>!integer(n)))throw Error('Invalid legacy evidence');
  }
 }
 return structuredClone(raw);
}
class ModelQuotaLedger{
 constructor(raw={version:1,accounts:{}},clock=Date.now){this.data=validate(raw);this.clock=clock;}
 account(id,create=false){
  const key=accountKey(id);
  if(!own(this.data.accounts,key)&&create)this.data.accounts[key]={windowStart:0,models:{},legacy:null};
  return own(this.data.accounts,key)?this.data.accounts[key]:undefined;
 }
 windowActive(a,now){return !!a&&a.windowStart>0&&now-a.windowStart<WINDOW;}
 view(id,model,family,now=this.clock()){
  modelKey(model);familyKey(family);
  const a=this.account(id),q=a&&own(a.models,model)?a.models[model]:undefined;
  const active=this.windowActive(a,now),used=active?(q?.used||0):0;
  const legacyBlocked=!!a?.legacy&&now<a.legacy.until&&a.legacy.blockedFamilies.includes(family);
  const cooldownUntil=q?.cooldownUntil||0;
  return {model,family,limit:LIMITS[family],used,remaining:Math.max(0,LIMITS[family]-used),
   windowStart:active?a.windowStart:0,windowEnd:active?a.windowStart+WINDOW:0,
   cooldownUntil,legacyBlocked,legacyUntil:legacyBlocked?a.legacy.until:0,
   allowed:!legacyBlocked&&cooldownUntil<=now&&used<LIMITS[family]};
 }
 charge(id,model,family){
  const now=this.clock(),v=this.view(id,model,family,now);
  if(!v.allowed)return false;
  const a=this.account(id,true);
  if(!this.windowActive(a,now)){
   for(const q of Object.values(a.models))q.used=0;
   a.windowStart=now;
  }
  let q=own(a.models,model)?a.models[model]:undefined;
  if(!q){q={family,used:0,cooldownUntil:0};Object.defineProperty(a.models,model,{value:q,enumerable:true,writable:true,configurable:true});}
  // Policy edits change limits, never identity or consumed count.
  q.family=family;q.used++;
  return true;
 }
 defer(id,model,family,until){
  modelKey(model);familyKey(family);if(!integer(until))throw Error('Invalid model cooldown');
  const a=this.account(id,true);
  if(!own(a.models,model))Object.defineProperty(a.models,model,{value:{family,used:0,cooldownUntil:0},enumerable:true,writable:true,configurable:true});
  a.models[model].cooldownUntil=Math.max(a.models[model].cooldownUntil,until);
 }
 retainLegacy(id,{until,evidence,blockedFamilies,windowStart=0}){
  // No guessed attribution. Preserve evidence and block only explicitly supplied families until the documented window closes.
  const a=this.account(id,true);
  if(a.legacy)throw Error('Legacy evidence already recorded');
  if(a.windowStart!==0&&a.windowStart!==windowStart)throw Error('Quota window conflict');
  const next=this.snapshot(),key=accountKey(id);
  next.accounts[key].windowStart=windowStart;
  next.accounts[key].legacy={until,evidence,blockedFamilies};
  this.data=validate(next);
 }
 summary(id,policies={}){
  const a=this.account(id),models={};
  for(const [model,p] of Object.entries(policies))Object.defineProperty(models,model,{value:this.view(id,model,p.quotaFamily),enumerable:true});
  return {account:id,models,legacy:a?.legacy?structuredClone(a.legacy):null};
 }
 snapshot(){return structuredClone(this.data);}
}
module.exports={ModelQuotaLedger,LIMITS,WINDOW,validate};
