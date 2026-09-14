'use strict';
const {AccountPool}=require('./account-pool');
const {DispatchCore}=require('./dispatch-core');
const {read,save}=require('./dispatch-state');
function restore(file){
 const d=read(file),p=d.pool;
 if(!Array.isArray(p.ids)||!p.ids.length||p.ids.some(x=>!Number.isSafeInteger(x)||x<1)||new Set(p.ids).size!==p.ids.length)
  throw Error('Invalid account pool');
 if(!Number.isSafeInteger(p.cursor)||p.cursor<0||p.cursor>=p.ids.length||!Number.isSafeInteger(p.sequence)||p.sequence<0)
  throw Error('Invalid pool counters');
 if(!Array.isArray(p.slots)||p.slots.length!==2||!Array.isArray(p.cooldowns))throw Error('Invalid ownership');
 const pool=new AccountPool(p.ids);pool.cursor=p.cursor;pool.sequence=p.sequence;
 for(const [slot,state] of p.slots){
  if(!['A','B'].includes(slot)||pool.slots.has(slot)||!state)throw Error('Invalid slot');
  for(const id of [state.current,state.pending?.id]){
   if((id ?? undefined)===undefined)continue;
   if(!pool.ids.includes(id)||pool.owners.has(id))throw Error('Duplicate or unknown account');
   pool.owners.set(id,slot);
  }
  if(state.pending && (!Number.isSafeInteger(state.pending.token)||state.pending.token<1||state.pending.token>p.sequence))
   throw Error('Invalid pending reservation');
  if((state.current ?? undefined)===undefined && !state.pending)throw Error('Unassigned slot');
  pool.slots.set(slot,{current:state.current??undefined,pending:state.pending});
 }
 for(const [id,until] of p.cooldowns){
  if(!pool.ids.includes(id)||!Number.isFinite(until)||until<0)throw Error('Invalid cooldown');
  pool.cooldowns.set(id,until);
 }
 const dispatch=new DispatchCore(pool,x=>save(x,file));
 dispatch.slots=new Map(d.dispatch.slots);
 dispatch.cursor=d.dispatch.cursor;
 dispatch.globalUntil=d.dispatch.globalUntil;
 dispatch.halted=d.dispatch.halted;
 return dispatch;
}
module.exports={restore};
