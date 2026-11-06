'use strict';
// Dispatch facade for the no-browser mode. The scheduler talks to it exactly like DispatchCore, but there are no
// worker slots: every account in the pool that is imported into the headless service can serve, several at once.
// Account state (pool, cooldowns, flags, per-model quotas, checkpoint) is the real DispatchCore's, so quotas and
// cooldowns carry over between modes. Executions are in memory: a coordinator restart ends them with the process.
const crypto=require('crypto');
const SLOT='H';
class HeadlessDispatch{
 constructor({core,usable=()=>true,isPremium=()=>false,perAccount=()=>2,log=console}){
  Object.assign(this,{core,usable,isPremium,perAccount,log});
  this.epoch=crypto.randomUUID();
  this.state={active:0,requests:new Set(),executions:{},retirements:{},ready:true};
  this.slots=new Map([[SLOT,this.state]]);
  this.inflight=new Map();this.settled=new Set();this.cursor=0;
 }
 get halted(){return this.core.halted;}
 set halted(v){this.core.halted=v;}
 get pool(){return this.core.pool;}
 get quotas(){return this.core.quotas;}
 get accountFlags(){return this.core.accountFlags;}
 set egressBlocked(v){this.core.egressBlocked=v;}
 get egressBlocked(){return this.core.egressBlocked;}
 checkpoint(){return this.core.checkpoint();}
 busy(account){return this.inflight.get(account)||0;}
 candidates(){
  const now=Date.now();
  return this.pool.ids.filter(id=>!this.accountFlags[id]&&(this.pool.cooldowns.get(id)||0)<=now&&this.usable(id));
 }
 acquire(id,plan,eligible=()=>true){
  if(!/^[a-f0-9-]{36}$/.test(id||''))throw Error('Invalid request ID');
  if(!plan||typeof plan.model!=='string'||!['flash','pro','ultra'].includes(plan.quotaFamily))throw Error('Explicit model quota required');
  if(this.state.requests.has(id))throw Error('Duplicate request');
  if(this.halted)return;
  const now=Date.now(),metered=typeof plan.admit==='function',ids=this.candidates();
  if(!ids.length)return;
  // Round robin; plain (non-premium) work prefers standard accounts so Pro/Ultra capacity stays free.
  let order=ids.map((acct,i)=>({acct,i:(i-this.cursor+ids.length)%ids.length}));
  const rank=a=>{if(typeof plan.rank==='function'){try{const v=Number(plan.rank(SLOT,a));if(Number.isFinite(v))return v;}catch{}}
   return plan.quotaFamily!=='ultra'&&this.isPremium(a)?1:0;};
  order=order.map(o=>({...o,k:rank(o.acct)})).sort((a,b)=>a.k-b.k||a.i-b.i);
  for(const {acct} of order){
   if(!eligible(SLOT,acct))continue;
   if(!metered&&this.busy(acct)>=this.perAccount(acct))continue;
   if(!metered&&!this.quotas.view(acct,plan.model,plan.quotaFamily,now).allowed)continue;
   if(metered?!plan.admit(acct,id):!this.quotas.charge(acct,plan.model,plan.quotaFamily))continue;
   const ticket={slot:SLOT,account:acct,id,workerEpoch:this.epoch,kind:plan.quotaFamily,model:plan.model,phase:'running',createdAt:now,admissionDeadline:now+30000};
   this.state.executions[id]={...ticket};this.state.requests.add(id);this.state.active++;
   this.inflight.set(acct,this.busy(acct)+1);
   this.cursor=(ids.indexOf(acct)+1)%ids.length;
   if(!metered)this.checkpoint();
   return ticket;
  }
 }
 // Called by the forward wrapper when the local execution has really ended (response closed, upstream gone).
 settle(ticket){
  if(this.settled.has(ticket.id))return;
  this.settled.add(ticket.id);
  this.inflight.set(ticket.account,Math.max(0,this.busy(ticket.account)-1));
 }
 markUncertain(ticket){const r=this.state.executions[ticket.id];if(r)r.phase='reconciling';}
 finish(ticket,confirmed){
  const r=this.state.executions[ticket.id];
  if(!r||r.account!==ticket.account)throw Error('Stale execution');
  if(confirmed!==true){r.phase='reconciling';return false;}
  this.state.retirements[ticket.id]={...r,phase:'settled'};
  delete this.state.executions[ticket.id];this.state.requests.delete(ticket.id);this.state.active--;
  return true;
 }
 retire(ticket){delete this.state.retirements[ticket.id];this.settled.delete(ticket.id);}
 status(){
  return {epoch:this.epoch,active:this.state.active,accounts:this.candidates().map(id=>({id,busy:this.busy(id),limit:this.perAccount(id)}))};
 }
}
// Stand-in for WorkerClient: an execution is releasable once the local forward settled.
class HeadlessClient{
 constructor(dispatch){this.dispatch=dispatch;}
 async execution(ticket){
  const done=this.dispatch.settled.has(ticket.id);
  return {account:ticket.account,slot:SLOT,workerEpoch:this.dispatch.epoch,found:true,
   record:{requestId:ticket.id,attemptId:ticket.id,account:ticket.account,slot:SLOT,workerEpoch:this.dispatch.epoch,sealed:done,releasable:done,operations:[],response:done?'success':null}};
 }
 async retireExecution(ticket){return {retired:true,account:ticket.account,slot:SLOT,workerEpoch:this.dispatch.epoch,attemptId:ticket.id};}
}
// forward wrapper: marks the execution settled whatever happens.
function settling(dispatch,forward){
 return async(ticket,...args)=>{try{return await forward(ticket,...args);}finally{dispatch.settle(ticket);}};
}
module.exports={HeadlessDispatch,HeadlessClient,settling,SLOT};
