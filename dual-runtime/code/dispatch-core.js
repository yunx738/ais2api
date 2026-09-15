'use strict';
const QUOTA_WINDOW_MS=24*60*60*1000;
class DispatchCore {
 constructor(pool,persist){
  this.pool=pool;this.persist=persist;this.halted=false;
  this.slots=new Map(['A','B'].map(slot=>[slot,{active:0,requests:new Set(),usesFlash37:0,usesFlash38:0,usesPro:0,windowStart:0,ready:false}]));
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
 acquire(id,kind){
  if(this.halted||this.globalUntil>Date.now())return;
  const now=Date.now();
  for(let n=0;n<2;n++){
   const pos=(this.cursor+n)%2,slot=['A','B'][pos],s=this.slots.get(slot),owner=this.pool.slots.get(slot);
   if(s.active>=2||s.ready===false||owner?.pending||owner?.current===undefined)continue;
   if(s.windowStart>0&&now-s.windowStart>=QUOTA_WINDOW_MS){s.usesFlash37=0;s.usesFlash38=0;s.usesPro=0;s.windowStart=0;}
   if(s.usesFlash37>=100&&s.usesFlash38>=100&&s.usesPro>=10)continue;
   if((this.pool.cooldowns.get(owner.current)||0)>Date.now())continue;
   s.active++;s.requests.add(id);
   if(s.windowStart===0)s.windowStart=now;
   if(kind==='pro')s.usesPro++;else if(kind==='flash37')s.usesFlash37++;else s.usesFlash38++;
   this.cursor=(pos+1)%2;
   this.checkpoint();
   return {slot,account:owner.current,id};
  }
 }
 finish(ticket,confirmedIdle){
  const s=this.slots.get(ticket.slot);
  if(s===undefined||s.requests.has(ticket.id)===false)throw Error('Stale request');
  if(confirmedIdle!==true){s.ready=false;this.checkpoint();return false;}
  s.requests.delete(ticket.id);s.active--;this.checkpoint();return true;
 }
 reserveRotation(slot,manual,target){
  if(this.halted)throw Error('Coordinator halted');
  const s=this.slots.get(slot);
  if(s===undefined||s.active>0||s.ready===false)throw Error('Slot not safe to rotate');
  if(manual!==true&&s.usesFlash37<100&&s.usesFlash38<100&&s.usesPro<10)throw Error('Quota not exhausted');
  const ticket=this.pool.reserve(slot,target);
  if(ticket){s.ready=false;this.checkpoint();}
  return ticket;
 }
 commitRotation(ticket,oldClosed){
  this.pool.commit(ticket,oldClosed);
  const s=this.slots.get(ticket.slot);s.usesFlash37=0;s.usesFlash38=0;s.usesPro=0;s.windowStart=0;s.ready=false;
  this.checkpoint();
 }
}
module.exports={DispatchCore};
