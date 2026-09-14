'use strict';
// Execute only in an inspected application frame before accepting worker requests.
function installInFrame(){
 if(typeof ProxySystem==='undefined'||typeof RequestProcessor==='undefined')
  return {installed:false,reason:'Client classes unavailable'};
 const proto=ProxySystem.prototype;
 if(proto.__operitCompletionAdapter===1)return {installed:true,version:1};
 if(typeof proto._processProxyRequest!=='function'||typeof proto._handleIncomingMessage!=='function')
  return {installed:false,reason:'Unsupported client structure'};
 const process=proto._processProxyRequest,handle=proto._handleIncomingMessage;
 // Never stack an adapter over a client that already implements completion.
 if(Function.prototype.toString.call(process).includes('operation_done'))
  return {installed:false,reason:'Native protocol must be verified separately'};
 const execute=RequestProcessor.prototype.execute; const states=new WeakMap(); RequestProcessor.prototype.execute=function(spec,id){ const result=execute.call(this,spec,id); const controller=this.activeOperations.get(id); let entries=states.get(this); if(!entries){entries=new Map();states.set(this,entries);} entries.set(id,controller); return {...result,responsePromise:Promise.resolve(result.responsePromise).finally(()=>result.cancelTimeout())}; };
 proto._processProxyRequest=async function(spec){
  const p=this.requestProcessor,c=this.connectionManager;
  if(!p||!(p.activeOperations instanceof Map)||!(p.cancelledOperations instanceof Set)||
     !c||typeof c.transmit!=='function'||typeof spec.request_id!=='string')
   throw Error('Unsupported client operation state');
  try{return await process.call(this,spec);}
  finally{
   // A terminal response alone is not proof that browser work has stopped.
   const entries=states.get(p),controller=entries?.get(spec.request_id); entries?.delete(spec.request_id);
   if(controller && !controller.signal.aborted && !p.activeOperations.has(spec.request_id)&&!p.cancelledOperations.has(spec.request_id))
    c.transmit({event_type:'operation_done',request_id:spec.request_id});
  }
 };
 proto._handleIncomingMessage=async function(raw){
  let m;try{m=JSON.parse(raw);}catch{return handle.call(this,raw);}
  if(m.event_type==='worker_challenge'){
   if(m.protocol===1&&typeof m.challenge==='string')
    this.connectionManager.transmit({event_type:'worker_hello',protocol:1,
     operation_done:true,challenge:m.challenge});
   return;
  }
  return handle.call(this,raw);
 };
 Object.defineProperty(proto,'__operitCompletionAdapter',{value:1});
 return {installed:true,version:1};
}
module.exports={installInFrame};
