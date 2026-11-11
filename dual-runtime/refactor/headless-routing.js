'use strict';
// Model routing in no-browser mode: configured policies + the headless service's own model list (one catalog for
// all accounts). Same plan shape as CatalogRouting.resolve.
const {parseRequestModel}=require('./request-model');
class HeadlessRouting{
 constructor({service,policies,dispatch,isPremium=()=>false,isUltra=()=>false,refreshMs=600000}){
  Object.assign(this,{service,policies,dispatch,isPremium,isUltra,refreshMs});
  this.premiumFor=(model,id)=>require('./model-access').ultraOnly(model)?this.isUltra(id):this.isPremium(id);
  this.models=new Set();this.at=0;this.timer=null;
 }
 async refresh(){
  try{const r=await this.service.call(null,'GET','/v1/models');
   if(r.status===200&&Array.isArray(r.json?.data)){this.models=new Set(r.json.data.map(m=>m.id));this.at=Date.now();}}catch{}
  return this.models;
 }
 start(){this.refresh();this.timer=setInterval(()=>this.refresh(),this.refreshMs);this.timer.unref();}
 resolve(route,body){
  let request;
  try{request=parseRequestModel(route,body);}catch{throw Object.assign(Error('Invalid request model'),{statusCode:400});}
  const policy=this.policies.get(request.upstreamId);
  if(!policy)throw Object.assign(Error('Explicit quota policy required for this model'),{statusCode:422});
  if(request.antiTruncation&&!policy.antiTruncation)throw Object.assign(Error('Anti-truncation unsupported for this model'),{statusCode:422});
  if(this.models.size&&!this.models.has(request.upstreamId))throw Object.assign(Error('Model not available on the no-browser service'),{statusCode:404});
  const d=this.dispatch;
  if(policy.quotaFamily==='ultra'){
   const prem=d.pool.ids.filter(id=>this.premiumFor(request.upstreamId,id)&&!d.accountFlags[id]);
   if(!prem.length)throw Object.assign(Error('This model needs a Pro or Ultra account; none is available in the account pool'),{statusCode:503});
   const now=Date.now();let soonest=Infinity;
   for(const id of prem){const q=d.quotas.view(id,request.upstreamId,'ultra');soonest=Math.min(soonest,Math.max(q.cooldownUntil||0,d.pool.cooldowns.get(id)||0));}
   if(soonest!==Infinity&&soonest>now+120000){
    const at=new Date(soonest+8*3600000).toISOString().slice(0,16).replace('T',' ');
    throw Object.assign(Error('All Pro/Ultra accounts are rate limited for '+request.upstreamId+' by Google; quota resets around '+at+' (Beijing time)'),{statusCode:429,retryAfter:Math.ceil((soonest-now)/1000)});
   }
  }
  const eligible=(slot,account)=>policy.quotaFamily!=='ultra'||this.premiumFor(request.upstreamId,account);
  return {model:request.upstreamId,quotaFamily:policy.quotaFamily,eligible};
 }
 list(){
  const ids=new Set();
  for(const [id,p] of this.policies){
   if(this.models.size&&!this.models.has(id))continue;
   ids.add(id);if(p.antiTruncation)ids.add('anti-truncation/'+id);
  }
  return [...ids].sort();
 }
}
module.exports={HeadlessRouting};
