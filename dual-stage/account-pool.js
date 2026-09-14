'use strict';
class AccountPool {
 constructor(ids){
  this.ids=[...new Set(ids)].sort((a,b)=>a-b);
  this.cursor=0;this.owners=new Map();this.slots=new Map();this.cooldowns=new Map();this.sequence=0;
 }
 reserve(slot){
  const state=this.slots.get(slot);
  if(state?.pending)throw Error('Slot already switching');
  for(let offset=0;offset<this.ids.length;offset++){
   const pos=(this.cursor+offset)%this.ids.length,id=this.ids[pos];
   if(this.owners.has(id)||(this.cooldowns.get(id)||0)>Date.now())continue;
   const token=++this.sequence;
   this.owners.set(id,slot);
   this.slots.set(slot,{current:state?.current ?? undefined,pending:{id,token}});
   this.cursor=(pos+1)%this.ids.length;
   return {slot,id,token};
  }
  return null;
 }
 commit(ticket,oldEnvironmentClosed){
  const s=this.slots.get(ticket.slot);
  if(s?.pending?.token!==ticket.token||s.pending.id!==ticket.id)throw Error('Stale ticket');
  if(s.current !== undefined && oldEnvironmentClosed!==true)throw Error('Old environment not confirmed closed');
  if(s.current !== undefined)this.owners.delete(s.current);
  this.slots.set(ticket.slot,{current:ticket.id,pending:null});
 }
 rollback(ticket,targetEnvironmentClosed){
  const s=this.slots.get(ticket.slot);
  if(s?.pending?.token!==ticket.token)throw Error('Stale ticket');
  if(targetEnvironmentClosed!==true)throw Error('Target environment not confirmed closed');
  this.owners.delete(s.pending.id);
  this.slots.set(ticket.slot,{current:s.current,pending:null});
 }
 cooldown(id,until){this.cooldowns.set(id,Math.max(this.cooldowns.get(id)||0,until));}
}
module.exports={AccountPool};
