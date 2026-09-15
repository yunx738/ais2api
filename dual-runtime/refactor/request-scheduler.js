"use strict";
const {randomUUID}=require("crypto");
class RequestScheduler {
 constructor(dispatch,client,forward,credentials){
  Object.assign(this,{dispatch,client,forward,credentials});
  this.queue=[];this.executing=new Set();this.checking=new Set();
  this.closed=false;this.pumping=false;this.resolveModel=null;
  this.wakeup=setInterval(()=>{
   this.reconcile().catch(()=>console.error("[Execution] reconciliation failed"));
   this.pump();
  },1000);
  this.wakeup.unref();
 }
 close(){
  this.closed=true;clearInterval(this.wakeup);
  for(const item of [...this.queue]){item.remove();this.fail(item.res,503,"Coordinator stopping");}
 }
 fail(res,code,message){
  if(res.destroyed||res.writableEnded)return;
  if(res.headersSent){res.destroy();return;}
  res.statusCode=code;res.setHeader("Content-Type","application/json");
  res.end(JSON.stringify({error:{message}}));
 }
 submit(route,body,res){
  if(this.closed)return this.fail(res,503,"Coordinator stopping");
  if(this.queue.length>=10)return this.fail(res,503,"Request queue full");
  let plan;
  try{
   if(!this.resolveModel)throw Error("Model routing unavailable");
   plan=this.resolveModel(route,body);
  }catch(error){return this.fail(res,error.statusCode||503,error.message);}
  const item={id:randomUUID(),route,body,res,plan};
  item.remove=()=>{
   const i=this.queue.indexOf(item);if(i>=0)this.queue.splice(i,1);
   clearTimeout(item.timer);res.removeListener("close",item.remove);
  };
  item.timer=setTimeout(()=>{item.remove();this.fail(res,503,"Queue wait exceeded 120 seconds");},120000);
  res.on("close",item.remove);this.queue.push(item);this.pump();
 }
 pump(){
  if(this.closed||this.pumping||this.dispatch.halted)return;
  this.pumping=true;
  try{
   // An unavailable model must not head-of-line block other queued models.
   for(const item of [...this.queue]){
    if(item.res.destroyed){item.remove();continue;}
    let ticket;
    try{
     item.plan=this.resolveModel(item.route,item.body);
     ticket=this.dispatch.acquire(item.id,item.plan,item.plan.eligible);
    }
    catch{
     item.remove();this.fail(item.res,503,"Dispatch admission unavailable");
     if(this.dispatch.halted)break;
     continue;
    }
    if(!ticket)continue;
    item.remove();this.executing.add(ticket);
    this.execute(ticket,item).catch(()=>{
     this.fail(item.res,502,"Execution failed; completion requires reconciliation");
    }).finally(()=>{this.executing.delete(ticket);this.pump();});
   }
  }finally{this.pumping=false;}
 }
 async execute(ticket,item){
  let result;
  try{
   result=await this.forward(ticket,item.route,item.body,item.res,this.credentials[ticket.slot]);
  }catch{
   this.fail(item.res,502,"Worker forwarding failed");
  }finally{
   // Keep upstream restrictions even when completion evidence is unavailable.
   if(result && [401,403,429].includes(result.status)){
    const now=Date.now();
    if(result.status===429){
     const raw=result.retryAfter;
     const seconds=typeof raw==="string"&&raw.trim()!==""?Number(raw):NaN;
     const date=typeof raw==="string"?Date.parse(raw):NaN;
     const until=Number.isFinite(seconds)?now+Math.max(60,seconds)*1000:
      Number.isFinite(date)?Math.max(now+60000,date):now+60000;
     this.dispatch.globalUntil=Math.max(this.dispatch.globalUntil,until);
     this.dispatch.pool.cooldown(ticket.account,until);
    }else this.dispatch.pool.cooldown(ticket.account,now+86400000);
   }
   this.dispatch.markUncertain(ticket);
   await this.check(ticket);
  }
 }
 async check(ticket){
  if(this.dispatch.halted||this.checking.has(ticket.id))return;
  this.checking.add(ticket.id);
  try{
   const data=await this.client.execution(ticket);
   if((data.found && data.record.releasable===true)||(!data.found && data.admissionClosed===true)){this.dispatch.finish(ticket,true);await this.retire(ticket);}
  }catch{
   // Missing records, transport failure and changed epochs are not completion.
  }finally{this.checking.delete(ticket.id);}
 }
 async retire(ticket){
  const key="retire:"+ticket.id;
  if(this.dispatch.halted||this.checking.has(key))return;
  this.checking.add(key);
  try{await this.client.retireExecution(ticket);if(!this.dispatch.halted)this.dispatch.retire(ticket);}
  catch{} // Durable pending retirement remains available for retry.
  finally{this.checking.delete(key);}
 }
 async reconcile(){
  if(this.dispatch.halted)return;
  const retired=[...this.dispatch.slots.values()].flatMap(s=>Object.values(s.retirements||{}));
  await Promise.all(retired.map(t=>this.retire(t)));
  const live=new Set([...this.executing].map(t=>t.id));
  const tickets=[...this.dispatch.slots.values()].flatMap(s=>Object.values(s.executions||{}));
  await Promise.all(tickets.filter(t=>!live.has(t.id)).map(t=>this.check(t)));
 }
}
module.exports={RequestScheduler};
