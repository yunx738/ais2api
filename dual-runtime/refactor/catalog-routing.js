"use strict";
const {parseRequestModel}=require("./request-model");
class CatalogRouting {
 constructor(dispatch,catalogs,policies={}){
  this.dispatch=dispatch;this.catalogs=catalogs;this.policies=new Map();
  if(!policies||typeof policies!=="object"||Array.isArray(policies))throw Error("Invalid model policies");
  for(const [id,p] of Object.entries(policies)){
   if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)||!p||
      !["flash","pro"].includes(p.quotaFamily)||
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
  if(request.antiTruncation && !policy.antiTruncation)
   throw Object.assign(Error("Anti-truncation unsupported for this model"),{statusCode:422});
  const eligible=(slot,account)=>this.eligible(slot,account,request.upstreamId);
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
   return !this.dispatch.quotas.view(account,plan.model,policy.quotaFamily).allowed;
  }
  const snapshot=this.snapshot(slot,account);
  if(!snapshot)return false;
  const models=snapshot.models.filter(m=>this.policies.has(m.id)&&m.methods?.includes("generateContent"));
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
  for(const plan of plans){
   if(!this.exhausted(slot,plan))continue;
   const excluded=new Set(plan.excludedAccounts||[]);
   for(let i=0;i<pool.ids.length;i++){
    const target=pool.ids[(pool.cursor+i)%pool.ids.length];
    if(this.dispatch.accountFlags[target]||pool.owners.has(target)||excluded.has(target)||(pool.cooldowns.get(target)||0)>now)continue;
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
