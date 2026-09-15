'use strict';
const {randomUUID}=require('crypto');
function modelKind(body){
 try{
  const d=typeof body==='string'||Buffer.isBuffer(body)?JSON.parse(body.toString()):body;
  const m=String(d?.model||'').toLowerCase();
  if(m.includes('pro'))return 'pro';
  if(m.includes('3.7'))return 'flash37';
  if(m.includes('3.8'))return 'flash38';
  return 'flash38';
 }catch{return 'flash';}
}
class RequestScheduler {
 constructor(dispatch,client,forward,credentials){
  this.dispatch=dispatch;this.client=client;this.forward=forward;
  this.credentials=credentials;this.queue=[];this.pumping=false;
  this.closed=false;this.executing=new Set();
  this.wakeup=setInterval(()=>this.pump(),1000);
  this.wakeup.unref();

 }
 close(){
  this.closed=true;
  clearInterval(this.wakeup);
  for(const item of [...this.queue]){
   item.remove();
   if(!item.res.destroyed){item.res.statusCode=503;item.res.end('Coordinator stopping');}
  }
 }
 submit(route,body,res){
  if(this.closed){res.statusCode=503;res.end('Coordinator stopping');return;}

  if(this.queue.length>=10){res.statusCode=503;res.end('Request queue full');return;}
  const kind=modelKind(body);
  const item={id:randomUUID(),route,body,res,kind};
  const remove=()=>{
   const index=this.queue.indexOf(item);
   if(index>=0)this.queue.splice(index,1);
   clearTimeout(item.timer);res.removeListener('close',remove);
  };
  item.remove=remove;
  item.timer=setTimeout(()=>{
   remove();
   if(res.destroyed===false){res.statusCode=503;res.end('Queue wait exceeded 120 seconds');}
  },120000);
  res.on('close',remove);
  this.queue.push(item);this.pump();
 }
 pump(){
  if(this.closed||this.pumping)return;
  this.pumping=true;
  try{
   while(this.queue.length){
    const item=this.queue[0];
    if(item.res.destroyed){item.remove();continue;}
    const ticket=this.dispatch.acquire(item.id,item.kind);
    if(ticket===undefined)break;
    item.remove();
    this.executing.add(ticket);this.execute(ticket,item).finally(()=>this.executing.delete(ticket)).catch(error=>{console.error(error);
     this.dispatch.halted=true;
     if(item.res.destroyed===false){
      if(item.res.headersSent===false){item.res.statusCode=503;item.res.end('Coordinator safety stop');}
      else item.res.destroy();
     }
    });
   }
  }catch{
   this.dispatch.halted=true;
  }finally{this.pumping=false;}
 }
 async execute(ticket,item){
  let result;
  try{
   result=await this.forward(ticket,item.route,item.body,item.res,this.credentials[ticket.slot]);
  }finally{
   // Preserve upstream restrictions even when browser completion is uncertain.
   if(result && [401,403,429].includes(result.status)){
    const now=Date.now();
    if(result.status===429){
     const raw=result.retryAfter;
     const seconds=typeof raw==='string' && raw.trim()!==''?Number(raw):NaN;
     const date=typeof raw==='string'?Date.parse(raw):NaN;
     const until=Number.isFinite(seconds)?now+Math.max(60,seconds)*1000:
      Number.isFinite(date)?Math.max(now+60000,date):now+60000;
     this.dispatch.globalUntil=Math.max(this.dispatch.globalUntil,until);
     this.dispatch.pool.cooldown(ticket.account,until);
    }else{
     this.dispatch.pool.cooldown(ticket.account,now+86400000);
    }
    this.dispatch.checkpoint();
   }
   let status;
   try{status=await this.client.waitReady(ticket.slot,ticket.account,15000);}catch{}
   if(status){
    const until=status.cooldownUntil||0;
    if(until>Date.now())this.dispatch.pool.cooldown(ticket.account,until);
    if(result?.status===429){
     const raw=result.retryAfter;
     const seconds=Number(raw);
     const parsed=Number.isFinite(seconds)?Date.now()+Math.max(60,seconds)*1000:Date.parse(raw);
     this.dispatch.globalUntil=Math.max(this.dispatch.globalUntil,until,Number.isFinite(parsed)?parsed:Date.now()+60000);
    }
    this.dispatch.update(ticket.slot,status);
    this.dispatch.finish(ticket,true);
   }else{
    this.dispatch.finish(ticket,false);
   }
   this.pump();
  }
 }
}
module.exports={RequestScheduler};
