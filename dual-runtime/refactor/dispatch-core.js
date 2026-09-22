'use strict';
const {SlotOperations}=require('./slot-operations');
const {ModelQuotaLedger}=require('./model-quota-ledger');
class DispatchCore {
 constructor(pool,persist){
  this.pool=pool;this.persist=persist;this.halted=false;
  this.quotas=new ModelQuotaLedger();this.quotaExhausted=()=>false;
  this.slots=new Map(['A','B'].map(slot=>[slot,{active:0,requests:new Set(),executions:{},retirements:{},usesFlash37:0,usesFlash38:0,usesPro:0,windowStart:0,ready:false}]));
  this.cursor=0;this.globalUntil=0;this.operations=new SlotOperations();
 }
 checkpoint(){
  try{this.persist(this);}catch(e){this.halted=true;throw e;}
 }
 update(slot,status){
  const s=this.slots.get(slot),owner=this.pool.slots.get(slot);
  if(s===undefined)throw Error('Unknown slot');
  const validEpoch=/^[a-f0-9-]{36}$/.test(status.workerEpoch||"");
  if(status.account===owner?.current && validEpoch)s.workerEpoch=status.workerEpoch;
  s.workerHealth={observedAt:Date.now(),account:status.account,workerEpoch:status.workerEpoch,
   hardQuarantine:status.hardQuarantine===true,
   pendingCompletions:Number.isSafeInteger(status.pendingCompletions)?status.pendingCompletions:null};
  const records=Object.values(s.executions||{});
  const unresolved=Boolean(s.rotation||s.recovery)||Object.keys(s.retirements||{}).length>0 || records.length!==s.requests.size || records.some(t=>t.phase!=="running"||t.workerEpoch!==s.workerEpoch);
  s.ready=validEpoch && !unresolved && !this.operations.has(slot) && status.account===owner?.current && status.ready===true && status.busy===false && status.browserOperations===0 && status.quarantined===false;
 }
 acquire(id,plan,eligible=()=>true){
  if(!/^[a-f0-9-]{36}$/.test(id||""))throw Error("Invalid request ID");
  if(!plan||typeof plan.model!=="string"||!["flash","pro"].includes(plan.quotaFamily))throw Error("Explicit model quota required");
  const {model,quotaFamily:kind}=plan;
  if([...this.slots.values()].some(s=>s.requests.has(id)||Object.hasOwn(s.retirements||{},id)))throw Error("Duplicate request");
  // Older coordinators persisted an account's 429 backoff as globalUntil.
  // Keep that legacy field for checkpoint compatibility; only the durable
  // account/model restrictions below govern admission now.
  if(this.halted)return;
  const now=Date.now();
  for(let n=0;n<2;n++){
   const pos=(this.cursor+n)%2,slot=['A','B'][pos],s=this.slots.get(slot),owner=this.pool.slots.get(slot);
   if(Object.keys(s.retirements||{}).length>=100||this.operations.has(slot)||s.active>=2||s.ready===false||owner?.pending||owner?.current===undefined)continue;
   if(!s.workerEpoch||!eligible(slot,owner.current))continue;
   // Quota is owned by account and canonical model, not slot.
   if(!this.quotas.view(owner.current,model,kind,now).allowed)continue;
   if((this.pool.cooldowns.get(owner.current)||0)>Date.now())continue;
   if(!this.quotas.charge(owner.current,model,kind))continue;
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
 rotationCandidate(target,plan){
  const now=Date.now();
  const excluded=new Set(plan?.excludedAccounts||[]);
  const available=id=>!this.pool.owners.has(id)&&(this.pool.cooldowns.get(id)||0)<=now&&
   !excluded.has(id)&&(!plan||this.quotas.view(id,plan.model,plan.quotaFamily,now).allowed);
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
 reserveRotation(slot,manual,target,plan){
  if(this.halted)throw Error('Coordinator halted');
  const s=this.slots.get(slot);
  if(s===undefined||s.active>0||s.requests.size||Object.keys(s.executions||{}).length||Object.keys(s.retirements||{}).length>0||s.ready===false)throw Error('Slot not safe to rotate');
  if(manual!==true&&!this.quotaExhausted(slot,plan))throw Error('Model quotas not exhausted');
  target=this.rotationCandidate(target,plan);
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
