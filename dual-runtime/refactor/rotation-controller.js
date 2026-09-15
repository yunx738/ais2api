'use strict';
class RotationController {
 constructor(dispatch,driver){
  this.dispatch=dispatch;
  this.driver=driver;
  this.running=new Set();
  this.failures=new Map();
 }
 async rotate(slot,manual,target){
  if(this.running.size>0)throw Error('Another slot rotation or recovery is running');
  if(this.failures.has(slot))throw Error('Manual reconciliation required');
  const lease=this.dispatch.operations.acquire(slot,'rotation');
  if(!lease)throw Error('Slot operation already running');
  this.running.add(slot);
  let ticket;
  try{
   ticket=this.dispatch.reserveRotation(slot,manual===true,target);
   if(!ticket)return {waiting:true};
   await this.driver.stop(slot);
   const stopped=await this.driver.inspect(slot);
   if(stopped.running!==false || stopped.processesStopped!==true)throw Error('Old environment closure unconfirmed');
   await this.driver.prepare(slot,ticket.id);
   await this.driver.start(slot,ticket.id);
   const status=await this.driver.waitReady(slot,ticket.id);
   if(status.account!==ticket.id || status.ready!==true || status.busy!==false || status.browserOperations!==0 || status.quarantined!==false)throw Error('Target readiness unconfirmed');
   this.dispatch.commitRotation(ticket,true);
   this.dispatch.update(slot,status);
   this.dispatch.checkpoint();
   return {slot,account:ticket.id};
  }catch(error){
   if(ticket){
    this.failures.set(slot,{account:ticket.id,token:ticket.token});
    this.dispatch.slots.get(slot).ready=false;
    try{this.dispatch.checkpoint();}catch{this.dispatch.halted=true;}
   }
   throw error;
  }finally{
   this.running.delete(slot);
   this.dispatch.operations.release(lease);
  }
 }
}
module.exports={RotationController};
