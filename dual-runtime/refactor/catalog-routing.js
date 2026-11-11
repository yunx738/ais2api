"use strict";
const {parseRequestModel}=require("./request-model");
const {ultraOnly}=require("./model-access");
class CatalogRouting {
 constructor(dispatch,catalogs,policies={}){
  this.dispatch=dispatch;this.catalogs=catalogs;this.policies=new Map();this.isUltra=()=>false;this.isPremium=id=>this.isUltra(id);
  // premium model on this account? Ultra-only models (model-access.json) skip Pro accounts.
  this.premiumFor=(model,id)=>ultraOnly(model)?this.isUltra(id):this.isPremium(id);
  if(!policies||typeof policies!=="object"||Array.isArray(policies))throw Error("Invalid model policies");
  for(const [id,p] of Object.entries(policies)){
   if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)||!p||
      !["flash","pro","ultra"].includes(p.quotaFamily)||
      typeof p.antiTruncation!=="boolean")throw Error("Invalid model policy");
   this.policies.set(id,Object.freeze({...p}));
  }
 }
 snapshot(slot,account){
  const owner=this.dispatch.pool.slots.get(slot),state=this.dispatch.slots.get(slot);
  const data=this.catalogs.cache.get(slot),s=data?.snapshot,now=Date.now();
  if(owner?.current!==account||owner.pending||data?.account!==account||
     data.workerEpoch!==state?.workerEpoch||data.syncing||data.error||
     !Number.isFinite(data.observedAt)||now-data.observedAt>30000||
     !s||s.account!==account||s.stale!==false||!Array.isArray(s.models)||
     !Number.isSafeInteger(s.updatedAt)||s.updatedAt>now||now-s.updatedAt>=3600000)return;
  return s;
 }
 eligible(slot,account,id){
  const s=this.snapshot(slot,account);
  return Boolean(s?.models.some(m=>m.id===id && Array.isArray(m.methods) && m.methods.includes("generateContent")));
 }
 resolve(route,body,{allowUnavailable=false}={}){
  let request;
  try{request=parseRequestModel(route,body);}
  catch{throw Object.assign(Error("Invalid request model"),{statusCode:400});}
  const policy=this.policies.get(request.upstreamId);
  if(!policy)throw Object.assign(Error("Explicit quota policy required for this model"),{statusCode:422});
  if(policy.quotaFamily==="ultra"&&!this.dispatch.pool.ids.some(id=>this.premiumFor(request.upstreamId,id)&&!this.dispatch.accountFlags[id]))throw Object.assign(Error("This model needs a Pro or Ultra account; none is available in the account pool"),{statusCode:503});
  if(policy.quotaFamily==="ultra"){
   // Every Ultra account is cooling down for this model (Google said when it resets): answer now with 429
   // and the reset time instead of holding the request in the queue until it times out.
   const now=Date.now();let soonest=Infinity;
   for(const id of this.dispatch.pool.ids){
    if(!this.premiumFor(request.upstreamId,id)||this.dispatch.accountFlags[id])continue;
    const q=this.dispatch.quotas.view(id,request.upstreamId,'ultra');
    soonest=Math.min(soonest,Math.max(q.cooldownUntil||0,this.dispatch.pool.cooldowns.get(id)||0));
   }
   if(soonest>now+120000&&soonest!==Infinity){
    const at=new Date(soonest+8*3600000).toISOString().slice(0,16).replace('T',' ');
    throw Object.assign(Error("All Pro/Ultra accounts are rate limited for "+request.upstreamId+" by Google; quota resets around "+at+" (Beijing time)"),{statusCode:429,retryAfter:Math.ceil((soonest-now)/1000)});
   }
  }
  if(request.antiTruncation && !policy.antiTruncation)
   throw Object.assign(Error("Anti-truncation unsupported for this model"),{statusCode:422});
  const eligible=(slot,account)=>(policy.quotaFamily!=="ultra"||this.premiumFor(request.upstreamId,account))&&this.eligible(slot,account,request.upstreamId);
  if(!allowUnavailable&&![...this.dispatch.pool.slots].some(([slot,owner])=>eligible(slot,owner.current)))
   throw Error("Model unavailable in a fresh synchronized account catalog");
  return {model:request.upstreamId,quotaFamily:policy.quotaFamily,eligible};
 }
 exhausted(slot,plan){
  const account=this.dispatch.pool.slots.get(slot)?.current;
  if(account===undefined)return false;
  if((this.dispatch.pool.cooldowns.get(account)||0)>Date.now())return true;
  if(plan){
   const policy=this.policies.get(plan.model);
   if(!policy||policy.quotaFamily!==plan.quotaFamily)return false;
   // A premium request cannot run on a standard account: treat it as exhausted so rotation moves to a Pro/Ultra account.
   if(plan.quotaFamily==='ultra'&&!this.premiumFor(plan.model,account))return true;
   return !this.dispatch.quotas.view(account,plan.model,policy.quotaFamily).allowed;
  }
  const snapshot=this.snapshot(slot,account);
  if(!snapshot)return false;
  let models=snapshot.models.filter(m=>this.policies.has(m.id)&&m.methods?.includes("generateContent"));
  if(this.isPremium(account))models=models.filter(m=>this.policies.get(m.id).quotaFamily==="ultra");
  if(!models.length)return false;
  return models.every(m=>{
   const p=this.policies.get(m.id),q=this.dispatch.quotas.view(account,m.id,p.quotaFamily);
   return !q.allowed;
  });
 }
 rotationPlan(slot,pendingPlans=[]){
  const owner=this.dispatch.pool.slots.get(slot),state=this.dispatch.slots.get(slot);
  if(!owner||owner.pending||!state||state.active||!state.ready||this.dispatch.operations.has(slot))return;
  const now=Date.now(),pool=this.dispatch.pool;
  const known=this.snapshot(slot,owner.current)?.models||[];
  const demanded=pendingPlans.filter(p=>p&&this.policies.get(p.model)?.quotaFamily===p.quotaFamily);
  // Prefer the actual queue: exhausting one requested model is sufficient to
  // switch, even if other models still have unused quota on this account.
  const plans=demanded.length?demanded:this.exhausted(slot)?known
   .filter(m=>this.policies.has(m.id)&&m.methods?.includes('generateContent'))
   .map(m=>({model:m.id,quotaFamily:this.policies.get(m.id).quotaFamily})):[];
  const premium=this.isPremium(owner.current);
  for(const plan of plans){
   // Pro/Ultra accounts keep their slot through flash/pro cooling; only gemini-4-argon (ultra family) exhaustion rotates them.
   if(premium&&plan.quotaFamily!=="ultra"&&!((pool.cooldowns.get(owner.current)||0)>now))continue;
   if(!this.exhausted(slot,plan))continue;
   const excluded=new Set(plan.excludedAccounts||[]);
   for(let i=0;i<pool.ids.length;i++){
    const target=pool.ids[(pool.cursor+i)%pool.ids.length];
    if(this.dispatch.accountFlags[target]||pool.owners.has(target)||excluded.has(target)||(pool.cooldowns.get(target)||0)>now||!this.dispatch.slotAllows(slot,target))continue;
     if(plan.quotaFamily==='ultra'&&!this.premiumFor(plan.model,target))continue;
    if(!this.dispatch.quotas.view(target,plan.model,plan.quotaFamily,now).allowed)continue;
    return {model:plan.model,quotaFamily:plan.quotaFamily,target,excludedAccounts:[...excluded]};
   }
  }
 }
 list(){
  const ids=new Set();
  for(const [slot,owner] of this.dispatch.pool.slots){
   const s=this.snapshot(slot,owner.current);
   for(const m of s?.models||[]){
    const p=this.policies.get(m.id);
    if(!p||!Array.isArray(m.methods)||!m.methods.includes("generateContent"))continue;
    ids.add(m.id);if(p.antiTruncation)ids.add("anti-truncation/"+m.id);
   }
  }
  return [...ids].sort();
 }
}
module.exports={CatalogRouting};
