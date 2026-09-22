'use strict';
class RotationController {
 constructor(dispatch,driver){
  this.dispatch=dispatch;
  this.driver=driver;
  this.running=new Set();
  this.failures=new Map();
 }
 ready(status,account){
  return status?.account===account && /^[a-f0-9-]{36}$/.test(status.workerEpoch||'') &&
   status.ready===true && status.busy===false && status.browserOperations===0 &&
   status.quarantined===false && status.hardQuarantine!==true &&
   (status.activeRequests===undefined||status.activeRequests===0) &&
   (status.pendingCompletions===undefined||status.pendingCompletions===0);
 }
 preflight(slot,target,plan){
  const state=this.dispatch.slots.get(slot),owner=this.dispatch.pool.slots.get(slot);
  if(this.dispatch.halted)return {available:false,reason:'Coordinator halted'};
  if(!state||!owner||owner.pending||!state.ready||state.active||state.requests.size||
     Object.keys(state.executions||{}).length||Object.keys(state.retirements||{}).length||
     this.running.has(slot)||this.dispatch.operations.has(slot)||this.failures.has(slot))
   return {available:false,reason:'Slot not safe to rotate'};
  try{
   const candidate=this.dispatch.rotationCandidate(target,plan);
   if(candidate===undefined)return {available:false,reason:'No available spare account'};
   try{this.driver.validateAccount?.(candidate);}
   catch{return {available:false,reason:'Target account credentials unavailable'};}
   return {available:true,target:candidate};
  }catch(error){return {available:false,reason:error.message};}
 }
 async rotate(slot,manual,target,plan){
  if(this.running.has(slot))throw Error('Slot rotation or recovery is running');
  if(this.failures.has(slot))throw Error('Manual reconciliation required');
  const lease=this.dispatch.operations.acquire(slot,'rotation');
  if(!lease)throw Error('Slot operation already running');
  this.running.add(slot);
  let ticket;
  try{
   const candidate=this.dispatch.rotationCandidate(target,plan);
   if(candidate===undefined)return {waiting:true};
   // A bounded local read happens before reserving or stopping anything. Bad
   // credentials are account-local and must not strand a healthy worker.
   try{this.driver.validateAccount?.(candidate);}
   catch(error){
    this.dispatch.pool.cooldown(candidate,Date.now()+300000);this.dispatch.checkpoint();
    throw Object.assign(Error('Target account credentials unavailable'),{code:'ACCOUNT_AUTH_INVALID',cause:error});
   }
   ticket=this.dispatch.reserveRotation(slot,manual===true,candidate,plan);
   if(!ticket)return {waiting:true};
   await this.driver.stop(slot);
   const stopped=await this.driver.inspect(slot);
   if(stopped.running!==false || stopped.processesStopped!==true)throw Error('Old environment closure unconfirmed');
   const state=this.dispatch.slots.get(slot);
   state.rotation={account:ticket.id,token:ticket.token,phase:'old_closed',oldContainerId:stopped.id};
   this.dispatch.checkpoint();
   await this.driver.prepare(slot,ticket.id);
   state.rotation.phase='prepared';this.dispatch.checkpoint();
   await this.driver.start(slot,ticket.id);
   state.rotation.phase='started';this.dispatch.checkpoint();
   const status=await this.driver.waitReady(slot,ticket.id);
   if(!this.ready(status,ticket.id))throw Error('Target readiness unconfirmed');
   this.dispatch.commitRotation(ticket,true);
   delete state.rotation;
   this.dispatch.update(slot,status);
   this.dispatch.checkpoint();
   return {slot,account:ticket.id};
  }catch(error){
   if(ticket){
    const state=this.dispatch.slots.get(slot);
    this.failures.set(slot,{account:ticket.id,token:ticket.token,
     retryable:['prepared','started'].includes(state.rotation?.phase),
     reason:error.message,retryAt:Date.now()+5000});
    this.dispatch.slots.get(slot).ready=false;
    try{this.dispatch.checkpoint();}catch{this.dispatch.halted=true;}
   }
   throw error;
  }finally{
   this.running.delete(slot);
   this.dispatch.operations.release(lease);
  }
 }
 async reconcile(slot){
  const owner=this.dispatch.pool.slots.get(slot),state=this.dispatch.slots.get(slot);
  const marker=state?.rotation,failure=this.failures.get(slot);
  if(this.dispatch.halted||this.running.has(slot)||!owner?.pending||
     !marker||!['prepared','started'].includes(marker.phase)||
     !/^[a-f0-9]{64}$/.test(marker.oldContainerId||'')||
     marker.account!==owner.pending.id||marker.token!==owner.pending.token||
     state.active||state.requests.size||Object.keys(state.executions||{}).length||
     Object.keys(state.retirements||{}).length||(failure?.retryAt||0)>Date.now())return false;
  const lease=this.dispatch.operations.acquire(slot,'rotation');
  if(!lease)return false;
  this.running.add(slot);state.ready=false;
  try{
   // A timed-out start may have succeeded in Docker. Read identity and readiness;
   // never repeat a destructive step or release an unresolved reservation.
   const description=await this.driver.describe(slot);
   if(description.Config?.Labels?.['operit.account']!==String(marker.account)||
      description.State?.Running!==true||description.Id===marker.oldContainerId)
    throw Error('Pending target identity or readiness unconfirmed');
   const status=await this.driver.probeReady(slot,marker.account);
   if(!this.ready(status,marker.account))throw Error('Pending target readiness unconfirmed');
   if(this.dispatch.pool.slots.get(slot)!==owner||state.rotation!==marker||this.dispatch.halted)
    throw Error('Pending rotation ownership changed');
   this.dispatch.commitRotation({slot,id:marker.account,token:marker.token},true);
   delete state.rotation;this.failures.delete(slot);
   this.dispatch.update(slot,status);this.dispatch.checkpoint();
   return true;
  }catch(error){
   this.failures.set(slot,{account:marker.account,token:marker.token,retryable:true,
    reason:error.message,retryAt:Date.now()+15000});
   return false;
  }finally{
   this.running.delete(slot);this.dispatch.operations.release(lease);
  }
 }
}
module.exports={RotationController};
