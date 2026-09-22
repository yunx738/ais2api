'use strict';
class QuarantineRecovery {
 constructor(dispatch,scheduler,client,driver,rotation){
  Object.assign(this,{dispatch,scheduler,client,driver,rotation});
  this.checking=new Set();
 }
 occupied(slot){return [...this.scheduler.executing].some(t=>t.slot===slot);}
 async check(slot){
  if(this.dispatch.operations.has(slot)||this.checking.has(slot)||this.dispatch.halted||this.scheduler.closed||this.occupied(slot)||this.rotation.running.has(slot))return;
  this.checking.add(slot);
  let locked=false,lease;
  try{
   const state=this.dispatch.slots.get(slot),owner=this.dispatch.pool.slots.get(slot);
   if(!owner||owner.pending||!state||state.active>0||state.requests.size||Object.keys(state.executions||{}).length||Object.keys(state.retirements||{}).length)return;
   const account=owner.current;
   if(state.recovery){
    const marker=state.recovery;
    if((this.rotation.failures.get(slot)?.retryAt||0)>Date.now())return;
    if(marker.account!==account||!['starting','waiting'].includes(marker.phase)||
       !/^[a-f0-9]{64}$/.test(marker.containerId||''))return;
    lease=this.dispatch.operations.acquire(slot,'recovery');
    if(!lease)return;
    this.rotation.running.add(slot);locked=true;
    const description=await this.driver.describe(slot);
    if(description.Id!==marker.containerId||description.Config?.Labels?.['operit.account']!==String(account)||description.State?.Running!==true)throw Error('Recovery container identity or readiness unconfirmed');
    const fresh=await this.client.status(slot,account);
    if(!this.rotation.ready(fresh,account))throw Error('Recovery readiness unconfirmed');
    if(this.dispatch.pool.slots.get(slot)!==owner||owner.pending||this.dispatch.halted)return;
    delete state.recovery;this.rotation.failures.delete(slot);
    this.dispatch.update(slot,fresh);this.dispatch.checkpoint();
    return;
   }
   if(this.rotation.failures.has(slot))return;
   const probe=await this.client.status(slot,account);
   if(probe.hardQuarantine!==true||probe.pendingCompletions!==0||!probe.quarantined||probe.busy||probe.activeRequests!==0)return;
   if(Object.keys(state.retirements||{}).length||state.active>0||this.dispatch.halted||this.scheduler.closed||this.occupied(slot)||this.rotation.running.has(slot)||owner.pending||owner.current!==account)return;
   const now=Date.now();
   const attempts=(state.recoveryAttempts||[]).filter(t=>now-t<3600000);
   if(attempts.length>=3||attempts.some(t=>now-t<300000))return;
   lease=this.dispatch.operations.acquire(slot,'recovery');
   if(!lease)return;
   this.rotation.running.add(slot);locked=true;
   state.ready=false;state.recoveryAttempts=[...attempts,now];
   this.dispatch.checkpoint();
   const before=await this.driver.describe(slot);
   if(before.Config.Labels['operit.account']!==String(account))throw Error('Recovery account mismatch');
   console.log('[Recovery]',slot,'stopping quarantined worker');
   await this.driver.stop(slot);
   const stopped=await this.driver.describe(slot);
   if(stopped.Id!==before.Id||stopped.State.Running||stopped.State.Pid!==0)throw Error('Recovery closure unconfirmed');
   if(this.occupied(slot))throw Error('Recovery request ownership changed');
   if(state.active!==0)throw Error("Unresolved executions block recovery");
   state.recovery={account,containerId:before.Id,phase:'starting'};this.dispatch.checkpoint();
   await this.driver.run('docker',['start',before.Id],{timeout:30000,maxBuffer:16384});
   state.recovery.phase='waiting';this.dispatch.checkpoint();
   const fresh=await this.client.waitReady(slot,account,180000);
   if(!this.rotation.ready(fresh,account))throw Error('Recovery readiness unconfirmed');
   if(this.dispatch.pool.slots.get(slot)!==owner||owner.current!==account||owner.pending)throw Error('Recovery ownership changed');
   delete state.recovery;this.rotation.failures.delete(slot);
   this.dispatch.update(slot,fresh);this.dispatch.checkpoint();
   console.log('[Recovery]',slot,'ready; quota preserved');
  }catch(error){
   if(locked){
    this.dispatch.slots.get(slot).ready=false;
    const state=this.dispatch.slots.get(slot);
    this.rotation.failures.set(slot,{reason:error.message,retryable:Boolean(state.recovery),retryAt:Date.now()+15000});
    try{this.dispatch.checkpoint();}catch{this.dispatch.halted=true;}
   }
   console.error('[Recovery]',slot,error.code||error.name||'Error');
  }finally{
   if(locked)this.rotation.running.delete(slot);
   if(lease)this.dispatch.operations.release(lease);
   this.checking.delete(slot);
  }
 }
}
module.exports={QuarantineRecovery};
