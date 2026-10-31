'use strict';
const {SlotOperations}=require('./slot-operations');
const {ModelQuotaLedger}=require('./model-quota-ledger');
class DispatchCore {
 constructor(pool,persist){
  this.pool=pool;this.persist=persist;this.halted=false;
  this.accountFlags={};this.quotas=new ModelQuotaLedger();this.quotaExhausted=()=>false;
  this.slots=new Map(['A','B'].map(slot=>[slot,{active:0,requests:new Set(),executions:{},retirements:{},usesFlash37:0,usesFlash38:0,usesPro:0,windowStart:0,ready:false}]));
  this.cursor=0;this.globalUntil=0;this.operations=new SlotOperations();this.slotAllows=()=>true;
  this.slotLimit=()=>2; // per-slot concurrency; replaced by the persisted setting at startup
 }
 checkpoint(){
  try{this.persist(this);}catch(e){this.halted=true;throw e;}
 }
 // A halt only means memory may be ahead of disk. Once a full checkpoint lands
 // again, disk matches memory and admission can resume without a restart.
 tryResume(){
  if(!this.halted)return false;
  this.halted=false;
  try{this.persist(this);return true;}catch{this.halted=true;return false;}
 }
 update(slot,status){
  const s=this.slots.get(slot),owner=this.pool.slots.get(slot);
  if(s===undefined)throw Error('Unknown slot');
  const validEpoch=/^[a-f0-9-]{36}$/.test(status.workerEpoch||"");
  if(status.account===owner?.current && validEpoch)s.workerEpoch=status.workerEpoch;
  s.workerHealth={observedAt:Date.now(),account:status.account,workerEpoch:status.workerEpoch,
   hardQuarantine:status.hardQuarantine===true,
   pendingCompletions:Number.isSafeInteger(status.pendingCompletions)?status.pendingCompletions:null};
  Object.assign(s.workerHealth,{executionProtocol:status.executionProtocol,busy:status.busy,
   activeRequests:status.activeRequests,browserOperations:status.browserOperations,quarantined:status.quarantined});
  const sig=status.signer&&typeof status.signer==='object'?status.signer:null,str=(v,n)=>typeof v==='string'?v.slice(0,n):null,num=v=>Number.isFinite(v)?v:null;
  s.workerHealth.frontend=typeof status.frontend==='string'&&/^[0-9a-f]{12}$/.test(status.frontend)?status.frontend:null;
  s.workerHealth.signer=sig?{state:str(sig.state,16),reason:str(sig.reason,40),message:str(sig.message,80),detail:str(sig.detail,200),since:num(sig.since),okRequests:num(sig.okRequests),lastOkAt:num(sig.lastOkAt),
   names:sig.names&&typeof sig.names==='object'?{hash:str(sig.names.hash,24),sign:str(sig.names.sign,24),service:str(sig.names.service,24)}:null}:null;
  const records=Object.values(s.executions||{});
  const unresolved=Boolean(s.rotation||s.recovery||s.proxyApply)||Object.keys(s.retirements||{}).length>0 || records.length!==s.requests.size || records.some(t=>t.phase!=="running"||t.workerEpoch!==s.workerEpoch);
  s.ready=validEpoch && !unresolved && !this.operations.has(slot) && status.account===owner?.current && status.ready===true && Number.isSafeInteger(status.browserOperations) && status.browserOperations<this.limitOf(slot) && status.quarantined===false;
  const wu=status.unready&&typeof status.unready==='object'&&/^[a-z_]{1,40}$/.test(status.unready.reason||'')?
   {reason:status.unready.reason,message:str(status.unready.message,80)||status.unready.reason,since:num(status.unready.since)}:null;
  s.unready=s.ready?null:!validEpoch?{reason:'epoch_unconfirmed',message:'实例身份未确认'}:
   status.account!==owner?.current?{reason:'account_mismatch',message:'实例账号与分配不一致'}:
   status.ready!==true?(wu||{reason:'worker_unready',message:'实例未就绪'}):
   status.quarantined!==false?{reason:'quarantined',message:'实例已隔离'}:
   this.operations.has(slot)?{reason:'operation',message:'正在执行维护操作'}:
   unresolved?{reason:'unresolved',message:'有执行或轮换待核实'}:
   {reason:'at_capacity',message:'并发已满'};
  try{this.onWorkerStatus?.(slot,status,s);}catch{}
 }
 acquire(id,plan,eligible=()=>true){
  if(!/^[a-f0-9-]{36}$/.test(id||""))throw Error("Invalid request ID");
  if(!plan||typeof plan.model!=="string"||!["flash","pro","ultra"].includes(plan.quotaFamily))throw Error("Explicit model quota required");
  const {model,quotaFamily:kind}=plan;
  if([...this.slots.values()].some(s=>s.requests.has(id)||Object.hasOwn(s.retirements||{},id)))throw Error("Duplicate request");
  // Older coordinators persisted an account's 429 backoff as globalUntil.
  // Keep that legacy field for checkpoint compatibility; only the durable
  // account/model restrictions below govern admission now.
  if(this.halted)return;
  const now=Date.now();
  for(let n=0;n<2;n++){
   const pos=(this.cursor+n)%2,slot=['A','B'][pos],s=this.slots.get(slot),owner=this.pool.slots.get(slot);
   if(Object.keys(s.retirements||{}).length>=100||this.operations.has(slot)||s.active>=this.limitOf(slot)||s.proxyApply||s.ready===false||owner?.pending||owner?.current===undefined)continue;
   if(this.accountFlags[owner.current]||!s.workerEpoch||!eligible(slot,owner.current))continue;
   // Quota is owned by account and canonical model, not slot.
   // Token-metered plans (Build channel) use their own ledger instead of per-request model counters.
   const metered=typeof plan.admit==='function';
   if(!metered&&!this.quotas.view(owner.current,model,kind,now).allowed)continue;
   if((this.pool.cooldowns.get(owner.current)||0)>Date.now())continue;
   if(metered?!plan.admit(owner.current,id):!this.quotas.charge(owner.current,model,kind))continue;
   const ticket={slot,account:owner.current,id,workerEpoch:s.workerEpoch,kind,model,phase:"running",createdAt:now,admissionDeadline:now+30000};
   s.executions||={};s.executions[id]={...ticket};
   s.active++;s.requests.add(id);
   // Legacy slot counters remain unchanged as historical evidence.
   // Charge and execution intent are persisted together below.
   this.cursor=(pos+1)%2;
   this.checkpoint();
   return ticket;
  }
 }
 markUncertain(ticket){
  const s=this.slots.get(ticket.slot),record=s?.executions?.[ticket.id];
  if(!record||record.account!==ticket.account||record.workerEpoch!==ticket.workerEpoch)throw Error("Stale execution");
  record.phase="reconciling";s.ready=false;this.checkpoint();
 }
 finish(ticket,confirmed){
  const s=this.slots.get(ticket.slot),record=s?.executions?.[ticket.id];
  if(!record||!s.requests.has(ticket.id)||record.account!==ticket.account||record.workerEpoch!==ticket.workerEpoch)throw Error("Stale execution");
  if(confirmed!==true){this.markUncertain(ticket);return false;}
  s.retirements||={};s.retirements[ticket.id]={...record,phase:"settled"};s.ready=false;
  delete s.executions[ticket.id];s.requests.delete(ticket.id);s.active--;
  this.checkpoint();return true;
 }
 retire(ticket){ const s=this.slots.get(ticket.slot),r=s?.retirements?.[ticket.id]; if(!r||r.account!==ticket.account||r.workerEpoch!==ticket.workerEpoch)throw Error("Stale retirement"); delete s.retirements[ticket.id];this.checkpoint(); }
 rotationCandidate(target,plan,slot){
  const now=Date.now();
  const excluded=new Set(plan?.excludedAccounts||[]);
  const available=id=>!this.accountFlags[id]&&!this.pool.owners.has(id)&&(this.pool.cooldowns.get(id)||0)<=now&&
   !excluded.has(id)&&(slot===undefined||this.slotAllows(slot,id))&&(!plan||this.quotas.view(id,plan.model,plan.quotaFamily,now).allowed);
  if(target!==undefined){
   if(!this.pool.ids.includes(target))throw Error('Unknown account');
   // Explicit account selection must never fall through to another account.
   if(!available(target))throw Error('Target account unavailable');
  }else{
   for(let i=0;i<this.pool.ids.length;i++){
    const id=this.pool.ids[(this.pool.cursor+i)%this.pool.ids.length];
    if(available(id)){target=id;break;}
   }
   if(target===undefined)return undefined;
  }
  return target;
 }
 limitOf(slot){const n=Number(this.slotLimit(slot));return Number.isSafeInteger(n)&&n>=1&&n<=10?n:2;}
 rotationIdle(slot){
  const s=this.slots.get(slot),o=this.pool.slots.get(slot);
  if(this.halted||!s||!o||o.pending||s.active||s.requests.size||s.rotation||s.recovery||s.proxyApply||
     Object.keys(s.executions||{}).length||Object.keys(s.retirements||{}).length)return false;
  if(s.ready)return true;
  const h=s.workerHealth,age=Date.now()-(h?.observedAt||0);
  return !!h&&age>=0&&age<6000&&h.account===o.current&&h.workerEpoch===s.workerEpoch&&
   /^[a-f0-9-]{36}$/.test(h.workerEpoch||'')&&h.executionProtocol===2&&
   h.busy===false&&h.activeRequests===0&&h.browserOperations===0&&
   h.pendingCompletions===0&&h.quarantined===false&&h.hardQuarantine===false;
 }
 reserveRotation(slot,manual,target,plan){
  if(this.halted)throw Error('Coordinator halted');
  const s=this.slots.get(slot);
  if(!this.rotationIdle(slot))throw Error('Slot not safe to rotate');
  if(manual!==true&&!this.quotaExhausted(slot,plan))throw Error('Model quotas not exhausted');
  target=this.rotationCandidate(target,plan,slot);
  if(target===undefined)return null;
  const ticket=this.pool.reserve(slot,target);
  if(ticket){
   s.ready=false;
   // The reservation and resumable transaction intent must be durable together.
   s.rotation={account:ticket.id,token:ticket.token,oldAccount:this.pool.slots.get(slot).current,phase:'reserved'};
   this.checkpoint();
  }
  return ticket;
 }
 commitRotation(ticket,oldClosed){
  this.pool.commit(ticket,oldClosed);
  const s=this.slots.get(ticket.slot);s.ready=false;
  // Ownership and the end of the rotation transaction must share one durable
  // checkpoint; retaining the marker after commit would strand the new owner
  // following a crash between checkpoints.
  delete s.rotation;
  // Keep all account quota ledgers when ownership changes.
  this.checkpoint();
 }
}
module.exports={DispatchCore};
