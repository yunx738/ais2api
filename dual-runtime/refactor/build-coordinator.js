'use strict';
// Coordinator glue for the Build channel.
// - resolve(): build/* and build-st/* models get a token-metered plan (own ledger, own eligibility)
// - wrapForward(): adds __build {app, model, thinking} for the chosen account, then charges reported usage
// Build projects per account live in build-apps.json: {"31":"<applet uuid>"}.
const fs=require('fs');
const {parseBuildModel,listModels,BuildTokenLedger}=require('./build-routing');
const {tokens}=require('./build-context');
const APP=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class BuildChannel{
 constructor({appsFile,ledgerFile,tierOf,isPremium,limits,presets=null,log=console}){
  this.appsFile=appsFile;this.isPremium=isPremium;this.log=log;this.presets=presets;
  this.ledger=new BuildTokenLedger(ledgerFile,{tierOf,limits});
  this.reservations=new Map();
  this.denied=new Map(); // 'account|model' -> until: Google refused this model for this account (e.g. free tier vs pro models)
  this.stats={requests:0,charged:0,missingUsage:0,rejected:0};
 }
 apps(){
  try{const d=JSON.parse(fs.readFileSync(this.appsFile,'utf8'));
   return Object.fromEntries(Object.entries(d).filter(([k,v])=>/^\d+$/.test(k)&&APP.test(String(v))).map(([k,v])=>[Number(k),String(v).toLowerCase()]));
  }catch{return {};}
 }
 appFor(id){return this.apps()[id]||null;}
 ready(id,model){return !!this.appFor(id)&&this.ledger.view(id).allowed&&!(model&&this.denied.get(id+'|'+model)>Date.now());}
 // Returns null for non-Build models so the normal routing runs.
 resolve(route,body,{allowUnavailable=false,accountIds=[]}={}){
  let parsed;try{parsed=Buffer.isBuffer(body)||typeof body==='string'?JSON.parse(body.toString()):body;}catch{return null;}
  const spec=parseBuildModel(parsed?.model);
  if(!spec)return null;
  if(route!=='/v1/chat/completions')throw Object.assign(Error('Build 通道只支持 /v1/chat/completions'),{statusCode:400});
  const candidates=Object.keys(this.apps()).map(Number);
  if(!candidates.length)throw Object.assign(Error('没有已开通 Build 项目的账号'),{statusCode:503});
  if(!allowUnavailable&&candidates.length&&candidates.every(id=>this.denied.get(id+'|'+spec.model)>Date.now()))throw Object.assign(Error('没有账号能使用 '+spec.model+'（Google 拒绝），请换模型'),{statusCode:403});
  if(!allowUnavailable&&!candidates.some(id=>this.ledger.view(id).allowed)){
   const soon=Math.min(...candidates.map(id=>{const v=this.ledger.view(id);return v.remaining===null||v.remaining>0?v.cooldownUntil:v.windowEnd;}));
   const at=new Date(soon+8*3600000).toISOString().slice(0,16).replace('T',' ');
   throw Object.assign(Error('Build 通道暂不可用（冷却或额度），约 '+at+'（北京时间）恢复'),{statusCode:429,retryAfter:Math.max(1,Math.ceil((soon-Date.now())/1000))});
  }
  let estimate=0;try{estimate=(parsed.messages||[]).reduce((n,m)=>n+tokens(typeof m.content==='string'?m.content:JSON.stringify(m.content||'')),0);}catch{}
  const self=this;
  return {
   model:'build-'+spec.model,quotaFamily:'ultra',build:spec,estimate,
   eligible:(slot,account)=>self.ready(account,spec.model),
   admit(account,id){
    if(!self.ready(account,spec.model))return false;
    self.reservations.set(id,{account,n:self.ledger.reserve(account,estimate)});
    return true;
   }
  };
 }
 wrapForward(forward){
  return async(ticket,route,body,res,credentials,options={})=>{
   let parsed=null;try{parsed=JSON.parse(body.toString('utf8'));}catch{}
   const spec=parsed&&parseBuildModel(parsed.model);
   if(!spec)return forward(ticket,route,body,res,credentials,options);
   const held=this.reservations.get(ticket.id);this.reservations.delete(ticket.id);
   const reserved=held&&held.account===ticket.account?held.n:0;
   const app=this.appFor(ticket.account);
   this.stats.requests++;
   let result;const t0=Date.now();
   try{
    if(!app){res.statusCode=503;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{message:'账号 #'+ticket.account+' 没有 Build 项目',code:'build_app_missing'}}));return {status:503};}
    parsed.__build={app,model:spec.model,thinking:spec.thinking};
    // Uploaded ST presets: mark preset text for the composer, the rest goes to the attachment.
    if(this.presets){try{const m=this.presets.apply(parsed.messages);if(m){parsed.messages=[{role:'user',content:m.content}];this.stats.presetHits=(this.stats.presetHits||0)+1;}}
     catch(e){this.log.error('[BuildPresets]',e.message);}}
    result=await forward(ticket,route,Buffer.from(JSON.stringify(parsed)),res,credentials,options);
    return result;
   }finally{
    this.ledger.release(ticket.account,reserved);
    const u=result?.metrics?.usage;
    const total=u&&Number.isSafeInteger(u.total)?u.total:u&&Number.isSafeInteger(u.input)&&Number.isSafeInteger(u.output)?u.input+u.output:null;
    const detail={model:spec.requested,input:u?.input,output:u?.output,cached:u?.cached};
    let charged=0;
    if(total!==null){this.ledger.charge(ticket.account,total,detail);this.stats.charged+=total;charged=total;}
    else if(result&&result.status===200){this.stats.missingUsage++;this.ledger.charge(ticket.account,reserved,{model:spec.requested});charged=reserved;}
    else this.ledger.fail(ticket.account);
    try{this.ledger.log({at:Date.now(),account:ticket.account,model:spec.requested,status:result?.status??0,ms:Date.now()-t0,
     input:u?.input??null,output:u?.output??null,cached:u?.cached??null,charged,estimated:total===null});}catch{}
    if(result?.status===429)this.ledger.defer(ticket.account,Date.now()+60000);
    if(result?.status===403){this.denied.set(ticket.account+'|'+spec.model,Date.now()+6*3600000);this.log.warn('[Build] #'+ticket.account+' refused '+spec.model+'; skipped for 6h');}
    if(result?.status>=400)this.stats.rejected++;
   }
  };
 }
 models(){return listModels();}
 status(ids){
  const apps=this.apps();
  const {LIMITS}=require('./build-context'),{periodStart,WINDOW}=require('./model-quota-ledger'),now=Date.now();
  return {apps,stats:this.stats,presets:this.presets?this.presets.list():[],limits:this.ledger.limits,maxContextBytes:LIMITS.maxBytes,inlineBudget:LIMITS.inlineBudget,
   windowStart:periodStart(now),windowEnd:periodStart(now)+WINDOW,models:listModels(),
   accounts:Object.keys(apps).map(Number).map(id=>({...this.ledger.view(id),premium:this.isPremium(id),app:apps[id],
    deniedModels:[...this.denied].filter(([k,t])=>t>now&&k.startsWith(id+'|')).map(([k])=>k.slice(String(id).length+1))})),
   recent:this.ledger.recent()};
 }
}
module.exports={BuildChannel};
