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
 resolve(route,body){
  let request;
  try{request=parseRequestModel(route,body);}
  catch{throw Object.assign(Error("Invalid request model"),{statusCode:400});}
  const policy=this.policies.get(request.upstreamId);
  if(!policy)throw Object.assign(Error("Explicit quota policy required for this model"),{statusCode:422});
  if(request.antiTruncation && !policy.antiTruncation)
   throw Object.assign(Error("Anti-truncation unsupported for this model"),{statusCode:422});
  const eligible=(slot,account)=>this.eligible(slot,account,request.upstreamId);
  if(![...this.dispatch.pool.slots].some(([slot,owner])=>eligible(slot,owner.current)))
   throw Error("Model unavailable in a fresh synchronized account catalog");
  return {model:request.upstreamId,quotaFamily:policy.quotaFamily,eligible};
 }
 exhausted(slot){
  const account=this.dispatch.pool.slots.get(slot)?.current;
  const snapshot=this.snapshot(slot,account);
  if(!snapshot)return false;
  const models=snapshot.models.filter(m=>this.policies.has(m.id)&&m.methods?.includes("generateContent"));
  if(!models.length)return false;
  return models.every(m=>{
   const p=this.policies.get(m.id),q=this.dispatch.quotas.view(account,m.id,p.quotaFamily);
   return !q.legacyBlocked && q.used>=q.limit;
  });
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
