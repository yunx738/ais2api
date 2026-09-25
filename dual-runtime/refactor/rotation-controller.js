'use strict';
class RotationController {
 constructor(dispatch,driver){
  this.dispatch=dispatch;
  this.driver=driver;
  this.running=new Set();
  this.failures=new Map();
 }
 gate(slot,token){
  const g=this.dispatch.rotationThrottle||{lastAt:0};
  if(g.slot!==undefined)return g.slot===slot&&g.token===token ? null : 'Waiting for previous rotation result';
  if([...this.running].some(s=>s!==slot))return 'Another rotation is running';
  if(Date.now()-g.lastAt<300000)return 'Global rotation interval: wait at least 5 minutes';
  return null;
 }
 claim(slot,token){
  if(this.gate(slot,token))return false;
  const g=this.dispatch.rotationThrottle||{lastAt:0};
  if(g.slot===undefined){
   this.dispatch.rotationThrottle={lastAt:Date.now(),slot,token};
   this.dispatch.checkpoint();
  }
  return true;
 }
 releaseGate(slot,token){
  const g=this.dispatch.rotationThrottle;
  if(g?.slot===slot&&g.token===token){
   delete g.slot;delete g.token;this.dispatch.checkpoint();
  }
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
  const gate=this.gate(slot);if(gate)return {available:false,reason:gate};
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
  const gate=this.gate(slot);if(gate)throw Error(gate);
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
   if(!await this.advance(slot,ticket,false))return {waiting:true,slot};
   return {slot,account:ticket.id};
  }catch(error){
   if(ticket){
    const state=this.dispatch.slots.get(slot);
    this.failures.set(slot,{account:ticket.id,token:ticket.token,
     retryable:Boolean(state.rotation),
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
 async skipInvalid(slot,ticket,marker,description){
  const d=this.dispatch,s=d.slots.get(slot),owner=d.pool.slots.get(slot);
  if(d.halted||s.rotation!==marker||owner?.pending?.id!==ticket.id||owner.pending.token!==ticket.token||
     s.active||s.requests.size||Object.keys(s.executions||{}).length||Object.keys(s.retirements||{}).length)
   throw Error('Invalid target transition blocked');
  if(description.Id===marker.oldContainerId||description.Config?.Labels?.['operit.account']!==String(ticket.id)||
     description.State?.Running!==false||description.State?.Pid!==0||description.State?.Status!=='exited')
   throw Error('Failed target closure unconfirmed');
  d.accountFlags[ticket.id]||={status:'invalid',reason:'login_required',at:Date.now()};
  d.checkpoint();
  this.releaseGate(slot,ticket.token);
  if(this.gate(slot))return false;
  let next=d.rotationCandidate();
  while(next!==undefined){
   try{this.driver.validateAccount(next);break;}
   catch{d.pool.cooldown(next,Date.now()+300000);d.checkpoint();next=d.rotationCandidate();}
  }
  if(next===undefined)throw Error('No available account; failed login target excluded');
  const nextToken=d.pool.sequence+1;
  if(!Number.isSafeInteger(nextToken))throw Error('Account sequence exhausted');
  // No await between ownership transfer and durable checkpoint. Old logical
  // owner remains reserved until a replacement has positively become ready.
  d.pool.owners.delete(ticket.id);d.pool.owners.set(next,slot);
  owner.pending={id:next,token:nextToken};d.pool.sequence=nextToken;
  d.pool.cursor=(d.pool.ids.indexOf(next)+1)%d.pool.ids.length;
  s.rotation={account:next,token:nextToken,oldAccount:owner.current,
   predecessorAccount:ticket.id,oldContainerId:description.Id,phase:'old_closed'};
  s.ready=false;d.checkpoint();this.failures.delete(slot);
  return false;
 }
 async advance(slot,ticket,reconciling){
  const state=this.dispatch.slots.get(slot),owner=this.dispatch.pool.slots.get(slot),marker=state.rotation;
  const unchanged=()=>{
   if(this.dispatch.halted||this.dispatch.pool.slots.get(slot)!==owner||state.rotation!==marker||
      owner.pending?.id!==ticket.id||owner.pending?.token!==ticket.token)
    throw Error('Pending rotation ownership changed');
  };
  unchanged();
  const knownInvalid=this.dispatch.accountFlags[ticket.id]?.reason==='login_required';
  if(!knownInvalid && !this.claim(slot,ticket.token))return false;
  if(marker.phase==='reserved'){
   const before=await this.driver.describe(slot);unchanged();
   if(!/^[a-f0-9]{64}$/.test(before.Id||'')||before.Config?.Labels?.['operit.account']!==String(owner.current))
    throw Error('Old worker identity unconfirmed');
   marker.oldAccount=owner.current;marker.oldContainerId=before.Id;marker.phase='stopping';
   this.dispatch.checkpoint();
  }
  if(marker.phase==='stopping'){
   const before=await this.driver.describe(slot);unchanged();
   if(before.Id!==marker.oldContainerId||before.Config?.Labels?.['operit.account']!==String(owner.current))
    throw Error('Old worker identity changed');
   await this.driver.stop(slot);
   const stopped=await this.driver.inspect(slot);unchanged();
   if(stopped.id!==marker.oldContainerId||stopped.running!==false||stopped.processesStopped!==true)
    throw Error('Old environment closure unconfirmed');
   marker.phase='old_closed';this.dispatch.checkpoint();
  }
  if(marker.phase==='old_closed'){
   if(marker.oldAccount===undefined){marker.oldAccount=owner.current;this.dispatch.checkpoint();}
   await this.driver.prepare(slot,ticket.id,marker);unchanged();
   marker.phase='prepared';this.dispatch.checkpoint();
  }
  if(marker.phase==='prepared'){
   if(reconciling){
    const now=Date.now(),attempts=(marker.restartAttempts||[]).filter(t=>now-t<3600000);
    if(attempts.length>=3||attempts.some(t=>now-t<300000))return false;
    marker.restartAttempts=[...attempts,now];this.dispatch.checkpoint();
   }
   this.dispatch.rotationThrottle.lastAt=Date.now();this.dispatch.checkpoint();
   await this.driver.start(slot,ticket.id,marker);unchanged();
   marker.phase='started';this.dispatch.checkpoint();
  }
  if(reconciling){
   let description=await this.driver.describe(slot);unchanged();
   if(description.Config?.Labels?.['operit.account']!==String(marker.account)||
      !/^[a-f0-9]{64}$/.test(description.Id||'')||description.Id===marker.oldContainerId)
    throw Error('Pending target identity unconfirmed');
   if(description.State?.Running!==true){
    if(description.State?.Running!==false||description.State?.Pid!==0||
       !['created','exited'].includes(description.State?.Status))
     throw Error('Pending target closure unconfirmed');
    const login=await this.driver.loginFailure?.(slot,marker.account);unchanged();
    if(login||this.dispatch.accountFlags[marker.account]?.reason==='login_required'){
     const failed=await this.driver.describe(slot);unchanged();
     return this.skipInvalid(slot,ticket,marker,failed);
    }
    const now=Date.now(),attempts=(marker.restartAttempts||[]).filter(t=>now-t<3600000);
    if(attempts.length>=3||attempts.some(t=>now-t<300000))return false;
    if(Date.now()-this.dispatch.rotationThrottle.lastAt<300000)return false;
    marker.restartAttempts=[...attempts,now];this.dispatch.checkpoint();
    this.dispatch.rotationThrottle.lastAt=Date.now();this.dispatch.checkpoint();
    await this.driver.restartStopped(slot,marker.account,description.Id);unchanged();
   }
  }
  const status=await (reconciling?this.driver.probeReady(slot,ticket.id):this.driver.waitReady(slot,ticket.id));
  unchanged();
  if(!this.ready(status,ticket.id))throw Error('Target readiness unconfirmed');
  const g=this.dispatch.rotationThrottle;
  if(g?.slot===slot && g.token===ticket.token){delete g.slot;delete g.token;}
  this.dispatch.commitRotation(ticket,true);
  this.failures.delete(slot);this.dispatch.update(slot,status);this.dispatch.checkpoint();
  // Optional housekeeping records are separate from the critical checkpoint.
  // A full disk or unavailable journal must not roll back a successful switch.
  try{this.onRetired?.(slot,marker);}catch{}
  return true;
 }
 async reconcile(slot){
  const owner=this.dispatch.pool.slots.get(slot),state=this.dispatch.slots.get(slot);
  let marker=state?.rotation;const failure=this.failures.get(slot);
  if(this.dispatch.halted||this.running.has(slot)||!owner?.pending||!state||
     (marker&&(!['reserved','stopping','old_closed','prepared','started'].includes(marker.phase)||
      (marker.phase!=='reserved'&&!/^[a-f0-9]{64}$/.test(marker.oldContainerId||''))||
      marker.account!==owner.pending.id||marker.token!==owner.pending.token))||
     state.active||state.requests.size||Object.keys(state.executions||{}).length||
     Object.keys(state.retirements||{}).length||(failure?.retryAt||0)>Date.now())return false;
  const lease=this.dispatch.operations.acquire(slot,'rotation');
  if(!lease)return false;
  this.running.add(slot);state.ready=false;
  try{
   if(!marker){
    // Pre-journal coordinators could die between reserving and stopping. Only
    // the still-canonical CURRENT account is enough evidence to resume safely.
    // An already-present target does not prove its predecessor was ever closed.
    const before=await this.driver.describe(slot);
    if(this.dispatch.halted||this.dispatch.pool.slots.get(slot)!==owner||state.rotation||
       state.active||state.requests.size||Object.keys(state.executions||{}).length||Object.keys(state.retirements||{}).length)
     throw Error('Legacy rotation ownership changed');
    if(!/^[a-f0-9]{64}$/.test(before.Id||'')||before.Config?.Labels?.['operit.account']!==String(owner.current))
     throw Error('Legacy rotation lacks old-container closure proof; manual reconciliation required');
    marker=state.rotation={account:owner.pending.id,token:owner.pending.token,oldAccount:owner.current,
     oldContainerId:before.Id,phase:'stopping'};
    this.dispatch.checkpoint();
   }
   return await this.advance(slot,{slot,id:marker.account,token:marker.token},true);
  }catch(error){
   this.failures.set(slot,{account:owner.pending.id,token:owner.pending.token,retryable:Boolean(marker),
    reason:error.message,retryAt:Date.now()+15000});
   return false;
  }finally{
   this.running.delete(slot);this.dispatch.operations.release(lease);
  }
 }
}
module.exports={RotationController};
