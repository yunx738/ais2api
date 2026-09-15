'use strict';
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const {estimateCost,validatePrice}=require('./usage-metrics');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const numeric=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const model=v=>typeof v==='string'&&/^[a-zA-Z0-9._/-]{1,200}$/.test(v)?v:null;
const copy=v=>JSON.parse(JSON.stringify(v));
function metrics(input){
 if(!input||typeof input!=='object')return null;
 const out={};
 for(const k of ['firstByteMs','firstContentMs','durationMs'])out[k]=numeric(input[k]);
 for(const k of ['usageComplete','transportComplete','streamDoneSeen','applicationError','captureLimited','malformed'])out[k]=input[k]===true;
 out.timingSource='coordinator-response-observer';
 const u=input.usage;
 out.usage=null;
 if(u&&['gemini','openai'].includes(u.format)){
  const result={};
  for(const k of ['input','output','cached','reasoning','total'])result[k]=numeric(u[k]);
  result.format=u.format;
  result.source=['upstream-reported','local-estimate','response-reported-unverified'].includes(u.source)?u.source:'response-reported-unverified';
  result.reasoningIncludedInOutput=u.format==='openai';
  result.validCache=result.cached===null||result.input===null||result.cached<=result.input;
  out.usage=result;
 }
 out.usageComplete=out.usageComplete && out.transportComplete && !!out.usage && !out.applicationError && !out.captureLimited && !out.malformed;
 return out;
}
function priceSnapshot(p){
 if(!p)return null;
 validatePrice(p);
 const out={};
 for(const k of ['currency','revision','inputPerMillion','outputPerMillion','cachedPerMillion','reasoningPerMillion','reasoningMode'])out[k]=p[k];
 if(out.revision.length>100)throw Error('Price revision too long');
 return out;
}
class RequestHistory{
 constructor(dir,{clock=Date.now,maxRecords=100000}={}){
  this.dir=dir;this.clock=clock;this.maxRecords=maxRecords;
  this.rows=new Map();this.pending=Promise.resolve();this.degraded=false;this.error=null;this.ready=false;
 }
 async init(){
  await fs.mkdir(this.dir,{recursive:true,mode:0o700});
  const names=(await fs.readdir(this.dir)).filter(n=>n.endsWith('.json'));
  if(names.length>this.maxRecords)throw Error('History capacity exceeded; archive required');
  for(const name of names){
   const id=name.slice(0,-5);
   if(!UUID.test(id))throw Error('Invalid history filename');
   const file=path.join(this.dir,name),info=await fs.lstat(file);
   if(!info.isFile()||info.isSymbolicLink()||info.size>32768)throw Error('Invalid history file');
   const row=JSON.parse(await fs.readFile(file,'utf8'));
   if(row.version!==1||row.id!==id||!Number.isSafeInteger(row.createdAt)||!['pending','finished'].includes(row.phase))throw Error('History record invalid');
   this.rows.set(id,row);
  }
  this.ready=true;return this;
 }
 enqueue(fn){
  const task=this.pending.then(async()=>{
   if(!this.ready||this.degraded)throw Error('History unavailable');
   return fn();
  });
  this.pending=task.catch(()=>{});
  return task;
 }
 async persist(row){
  const file=path.join(this.dir,row.id+'.json');
  const tmp=path.join(this.dir,'.'+row.id+'.'+crypto.randomUUID()+'.tmp');
  let h;
  try{
   h=await fs.open(tmp,'wx',0o600);
   await h.writeFile(JSON.stringify(row)+'\n');await h.sync();await h.close();h=null;
   await fs.rename(tmp,file);
   const d=await fs.open(this.dir,'r');try{await d.sync();}finally{await d.close();}
   this.rows.set(row.id,row);
  }catch(e){
   this.degraded=true;this.error='history_write_failed';
   throw Error('History persistence failed');
  }finally{
   if(h)await h.close().catch(()=>{});
   await fs.unlink(tmp).catch(()=>{});
  }
 }
 begin(input){
  return this.enqueue(async()=>{
   if(!UUID.test(input.id||'')||!model(input.model))throw Error('Invalid request identity');
   const old=this.rows.get(input.id);
   if(old){
    if(old.model!==input.model||old.account!==(numeric(input.account)))throw Error('History identity conflict');
    return copy(old);
   }
   if(this.rows.size>=this.maxRecords)throw Error('History capacity reached');
   const row={
    version:1,id:input.id,createdAt:this.clock(),phase:'pending',outcome:'pending',
    model:input.model,requestedModel:model(input.requestedModel)||input.model,
    account:numeric(input.account),slot:['A','B'].includes(input.slot)?input.slot:null,
    workerEpoch:UUID.test(input.workerEpoch||'')?input.workerEpoch:null,
    stream:input.stream===true,queueMs:numeric(input.queueMs),
    price:priceSnapshot(input.price),metrics:null,cost:null,httpStatus:null,finishedAt:null
   };
   await this.persist(row);return copy(row);
  });
 }
 finish(id,input={}){
  return this.enqueue(async()=>{
   const old=this.rows.get(id);if(!old)throw Error('History request missing');
   if(old.phase==='finished')return copy(old);
   if(!['success','http_error','application_error','cancelled','uncertain','rejected'].includes(input.outcome))throw Error('Invalid outcome');
   const m=metrics(input.metrics);
   const cost=m?.usageComplete?estimateCost(m.usage,old.price):
    {amount:null,currency:'USD',estimated:true,reason:'usage_incomplete'};
   const row={...old,phase:'finished',outcome:input.outcome,finishedAt:this.clock(),
    httpStatus:Number.isInteger(input.httpStatus)&&input.httpStatus>=100&&input.httpStatus<=599?input.httpStatus:null,
    metrics:m,cost};
   await this.persist(row);return copy(row);
  });
 }
 status(){return {ready:this.ready,degraded:this.degraded,error:this.error,records:this.rows.size,capacity:this.maxRecords};}
 select({from=0,to=Number.MAX_SAFE_INTEGER,model:filterModel,account,outcome}={}){
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from)throw Error('Invalid date range');
  return [...this.rows.values()].filter(r=>r.createdAt>=from&&r.createdAt<to&&
   (!filterModel||r.model===filterModel)&&(account===undefined||r.account===account)&&(!outcome||r.outcome===outcome));
 }
 list(options={}){
  const {page=1,pageSize=20}=options;
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw Error('Invalid pagination');
  const rows=this.select(options).sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id));
  return {items:copy(rows.slice((page-1)*pageSize,page*pageSize)),total:rows.length,page,pageSize,health:this.status()};
 }
 summary(options={}){
  const rows=this.select(options),now=this.clock();
  const result={requests:rows.length,success:0,errors:0,cancelled:0,uncertain:0,pending:0,
   knownTokenTotal:0,tokenKnownRequests:0,tokenUnknownRequests:0,
   estimatedCostKnownSubtotal:0,pricedRequests:0,unpricedRequests:0,currency:'USD',
   rpm:0,tpmKnown:0,tpmUnknownRequests:0,averageDurationMs:null,errorRate:null,
   models:[],health:this.status(),scope:'recorded-requests-only'};
  let duration=0,timed=0;const models=new Map();
  for(const row of rows){
   if(row.outcome==='success')result.success++;
   else if(['http_error','application_error','rejected'].includes(row.outcome))result.errors++;
   else if(Object.hasOwn(result,row.outcome))result[row.outcome]++;
   const m=row.metrics;
   const known=m?.usageComplete&&Number.isSafeInteger(m.usage?.total);
   if(known){result.knownTokenTotal+=m.usage.total;result.tokenKnownRequests++;}
   else result.tokenUnknownRequests++;
   if(Number.isFinite(row.cost?.amount)){result.estimatedCostKnownSubtotal+=row.cost.amount;result.pricedRequests++;}
   else result.unpricedRequests++;
   if(row.phase==='finished'&&Number.isFinite(m?.durationMs)){duration+=m.durationMs;timed++;}
   if(row.createdAt>=now-60000&&row.createdAt<=now)result.rpm++;
   // Tokens attributed by response completion time, not admission time.
   if(row.finishedAt!==null&&row.finishedAt>=now-60000&&row.finishedAt<=now){
    if(known)result.tpmKnown+=m.usage.total;else result.tpmUnknownRequests++;
   }
   const group=models.get(row.model)||{model:row.model,requests:0,knownTokenTotal:0,tokenUnknownRequests:0};
   group.requests++;if(known)group.knownTokenTotal+=m.usage.total;else group.tokenUnknownRequests++;
   models.set(row.model,group);
  }
  result.averageDurationMs=timed?duration/timed:null;
  result.errorRate=result.success+result.errors?result.errors/(result.success+result.errors):null;
  result.models=[...models.values()].sort((a,b)=>b.requests-a.requests);
  return result;
 }
}
module.exports={RequestHistory};
