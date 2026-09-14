'use strict';
class DispatchCore {
 constructor(pool,persist){
  this.pool=pool;this.persist=persist;this.halted=false;
  this.slots=new Map(['A','B'].map(slot=>[slot,{busy:false,uses:0,ready:false}]));
  this.cursor=0;this.globalUntil=0;
 }
 checkpoint(){
  try{this.persist(this);}catch(e){this.halted=true;throw e;}
 }
 update(slot,status){
  const s=this.slots.get(slot),owner=this.pool.slots.get(slot);
  if(s===undefined)throw Error('Unknown slot');
  s.ready=status.account===owner?.current && status.ready===true && status.busy===false && status.browserOperations===0 && status.quarantined===false;
 }
 acquire(id){
  if(this.halted||this.globalUntil>Date.now())return;
  for(let n=0;n<2;n++){
   const pos=(this.cursor+n)%2,slot=['A','B'][pos],s=this.slots.get(slot),owner=this.pool.slots.get(slot);
   if(s.busy||s.ready===false||s.uses>=80||owner?.pending||owner?.current===undefined)continue;
   if((this.pool.cooldowns.get(owner.current)||0)>Date.now())continue;
   s.busy=true;s.request=id;s.uses++;this.cursor=(pos+1)%2;
   this.checkpoint();
   return {slot,account:owner.current,id};
  }
 }
 finish(ticket,confirmedIdle){
  const s=this.slots.get(ticket.slot);
  if(s===undefined||s.busy===false||s.request!==ticket.id)throw Error('Stale request');
  if(confirmedIdle!==true){s.ready=false;this.checkpoint();return false;}
  s.busy=false;delete s.request;this.checkpoint();return true;
 }
 reserveRotation(slot){
  if(this.halted)throw Error('Coordinator halted');
  const s=this.slots.get(slot);
  if(s===undefined||s.busy||s.ready===false||s.uses<80)throw Error('Slot not safe to rotate');
  const ticket=this.pool.reserve(slot);
  if(ticket){s.ready=false;this.checkpoint();}
  return ticket;
 }
 commitRotation(ticket,oldClosed){
  this.pool.commit(ticket,oldClosed);
  const s=this.slots.get(ticket.slot);s.uses=0;s.ready=false;
  this.checkpoint();
 }
}
module.exports={DispatchCore};
