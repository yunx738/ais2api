'use strict';
class QuarantineRecovery {
 constructor(dispatch,scheduler,client,driver,rotation){
  Object.assign(this,{dispatch,scheduler,client,driver,rotation});
  this.checking=new Set();
 }
 occupied(slot){return [...this.scheduler.executing].some(t=>t.slot===slot);}
 idle(slot,state,owner,account){
  return !this.dispatch.halted&&!this.scheduler.closed&&this.dispatch.pool.slots.get(slot)===owner&&
   !owner.pending&&owner.current===account&&state.active===0&&!state.requests.size&&
   !Object.keys(state.executions||{}).length&&!Object.keys(state.retirements||{}).length&&!this.occupied(slot);
 }
 owned(description,account,id){
  return /^[a-f0-9]{64}$/.test(description?.Id||'')&&(!id||description.Id===id)&&
   description.Config?.Labels?.['operit.account']===String(account);
 }
 stopped(description){
  return description.State?.Running===false&&description.State?.Pid===0&&
   ['created','exited'].includes(description.State?.Status);
 }
 attempts(state){return (state.recoveryAttempts||[]).filter(t=>Date.now()-t<3600000);}
 mayRestart(state){const attempts=this.attempts(state);return attempts.length<3&&!attempts.some(t=>Date.now()-t<300000);}
 async check(slot){
  if(this.dispatch.operations.has(slot)||this.checking.has(slot)||this.dispatch.halted||this.scheduler.closed||this.occupied(slot)||this.rotation.running.has(slot))return;
  this.checking.add(slot);
  let locked=false,lease;
  try{
   const state=this.dispatch.slots.get(slot),owner=this.dispatch.pool.slots.get(slot);
   if(!owner||!state||!this.idle(slot,state,owner,owner.current))return;
   const account=owner.current;
   let marker=state.recovery,description;
   if(marker){
    if((this.rotation.failures.get(slot)?.retryAt||0)>Date.now())return;
    if(marker.account!==account||!['stopping','starting','waiting'].includes(marker.phase)||
       !/^[a-f0-9]{64}$/.test(marker.containerId||''))return;
    lease=this.dispatch.operations.acquire(slot,'recovery');
    if(!lease)return;
    this.rotation.running.add(slot);locked=true;
    description=await this.driver.describe(slot);
    if(!this.owned(description,account,marker.containerId))throw Error('Recovery container identity unconfirmed');
   }else{
    if(this.rotation.failures.has(slot))return;
    let probe;
    try{probe=await this.client.status(slot,account);}catch{}
    const quarantined=probe?.account===account&&probe.hardQuarantine===true&&
     probe.pendingCompletions===0&&probe.quarantined===true&&probe.busy===false&&probe.activeRequests===0;
    // A transport failure is not evidence that a browser has stopped. Only a
    // positively inspected, account-owned Docker container can be restarted.
    if(probe&&!quarantined)return;
    if(!this.idle(slot,state,owner,account)||!this.mayRestart(state))return;
    lease=this.dispatch.operations.acquire(slot,'recovery');
    if(!lease)return;
    description=await this.driver.describe(slot);
    if(!this.owned(description,account))return;
    if(!quarantined&&!this.stopped(description))return;
    if(!this.idle(slot,state,owner,account))return;
    this.rotation.running.add(slot);locked=true;
    state.ready=false;
    marker=state.recovery={account,containerId:description.Id,
     phase:description.State?.Running===true?'stopping':'starting'};
    this.dispatch.checkpoint();
   }
   if(!this.idle(slot,state,owner,account))return;
   if(marker.phase==='stopping'&&description.State?.Running===true){
    await this.driver.stop(slot);
    description=await this.driver.describe(slot);
    if(!this.owned(description,account,marker.containerId)||!this.stopped(description))throw Error('Recovery closure unconfirmed');
   }
   if(description.State?.Running!==true){
    if(!this.stopped(description))throw Error('Recovery closure unconfirmed');
    if(!this.idle(slot,state,owner,account)||!this.mayRestart(state))return;
    state.recoveryAttempts=[...this.attempts(state),Date.now()];
    marker.phase='starting';this.dispatch.checkpoint();
    await this.driver.restartStopped(slot,account,marker.containerId);
    marker.phase='waiting';this.dispatch.checkpoint();
    const fresh=await this.client.waitReady(slot,account,180000);
    if(!this.rotation.ready(fresh,account))throw Error('Recovery readiness unconfirmed');
    if(!this.idle(slot,state,owner,account)||state.recovery!==marker)return;
    delete state.recovery;this.rotation.failures.delete(slot);
    this.dispatch.update(slot,fresh);this.dispatch.checkpoint();
    return;
   }
   const fresh=await this.client.status(slot,account);
   if(!this.rotation.ready(fresh,account))throw Error('Recovery readiness unconfirmed');
   if(!this.idle(slot,state,owner,account)||state.recovery!==marker)return;
   delete state.recovery;this.rotation.failures.delete(slot);
   this.dispatch.update(slot,fresh);this.dispatch.checkpoint();
  }catch(error){
   if(locked){
    const state=this.dispatch.slots.get(slot);state.ready=false;
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
