'use strict';
class QuarantineRecovery {
 constructor(dispatch,scheduler,client,driver,rotation){
  Object.assign(this,{dispatch,scheduler,client,driver,rotation});
  this.checking=new Set();
 }
 occupied(slot){return [...this.scheduler.executing].some(t=>t.slot===slot);}
 async check(slot){
  if(this.dispatch.operations.has(slot)||this.checking.has(slot)||this.dispatch.halted||this.occupied(slot)||this.rotation.running.size>0||this.rotation.failures.has(slot))return;
  this.checking.add(slot);
  let locked=false,lease;
  try{
   const state=this.dispatch.slots.get(slot),owner=this.dispatch.pool.slots.get(slot);
   if(!owner||owner.pending||state.active>0||Object.keys(state.retirements||{}).length)return;
   const account=owner.current;
   const probe=await this.client.status(slot,account);
   if(probe.hardQuarantine!==true||probe.pendingCompletions!==0||!probe.quarantined||probe.busy||probe.activeRequests!==0)return;
   if(Object.keys(state.retirements||{}).length||state.active>0||this.dispatch.halted||this.scheduler.closed||this.occupied(slot)||this.rotation.running.size>0||owner.pending||owner.current!==account)return;
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
   this.dispatch.checkpoint();
   await this.driver.run('docker',['start',before.Id],{timeout:30000,maxBuffer:16384});
   const fresh=await this.client.waitReady(slot,account,180000);
   if(this.dispatch.pool.slots.get(slot)!==owner||owner.current!==account||owner.pending)throw Error('Recovery ownership changed');
   this.dispatch.update(slot,fresh);this.dispatch.checkpoint();
   console.log('[Recovery]',slot,'ready; quota preserved');
  }catch(error){
   if(locked){
    this.dispatch.slots.get(slot).ready=false;
    this.rotation.failures.set(slot,{reason:'Recovery failed; manual reconciliation required'});
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
