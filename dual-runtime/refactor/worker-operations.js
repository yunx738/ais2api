'use strict';
const {OperationTracker,requestScope}=require('./operation-tracker');
function install(system){
 const h=system.requestHandler,r=system.connectionRegistry;
 const tracker=new OperationTracker();
 h._atWaitOperationDone=id=>tracker.finishOrCancel(id,x=>h._cancelBrowserRequest(x),1000,10000);
 const forward=h._forwardRequest.bind(h);
 const operationConnections=new Map();
 const cancel=h._cancelBrowserRequest.bind(h);
 h._cancelBrowserRequest=function(id){
  const socket=operationConnections.get(id);
  const current=r.getFirstConnection();
  if(!socket||!current||current.readyState!==1)return;
  if(socket===current)return cancel(id);
  if(r.sessionIdentity(socket)!==r.sessionIdentity(current))return;
  current.send(JSON.stringify({event_type:"cancel_request",request_id:id}),()=>{});
  return;

 };
 r.on('operationDone',id=>{
  tracker.acknowledge(id);
  operationConnections.delete(id);
 });
 r.on('connectionRemoved',socket=>{
  let affected=0;
  for(const [id,owner] of operationConnections){
   if(owner!==socket)continue;
   const entry=tracker.active.get(id);
   if(!entry)continue;
   tracker.disconnected(id);
   r.removeMessageQueue(id);
   affected++;
  }
  if(affected)console.warn('[Worker] disconnected operation owner; requests failed; completion reconciliation pending',affected);
 });
 h._forwardRequest=function(request){
  const socket=r.getFirstConnection();
  if(!socket || socket.readyState!==1)throw Error('Verified browser connection unavailable');
  tracker.begin(request.request_id);
  operationConnections.set(request.request_id,socket);
  try{const operationSequence=r.bindOperation(request.request_id,socket);return forward({...request,operationSequence,workerEpoch:r.workerEpoch});}
  catch(error){tracker.quarantined=true;throw error;}
 };
 for(const name of ['processRequest','processOpenAIRequest']){
  const original=h[name].bind(h);
  h[name]=(req,res)=>requestScope.run(new Set(),()=>h.stabilityGate.run(async()=>{
   if(res.destroyed)return;
   if(tracker.quarantined){
    return h._sendErrorResponse(res,503,'工作实例等待安全恢复');
   }
   try{return await original(req,res);}
   finally{
    const scope=requestScope.getStore()||new Set();
    for(const id of [...tracker.active.keys()]){
     if(scope.has(id)===false)continue;
     await tracker.finishOrCancel(id,x=>h._cancelBrowserRequest(x),res.writableEnded?250:0);
    }
   }
  },()=>!res.destroyed).catch(()=>{
   // Request failure is not an invariant failure; unconfirmed operations retain occupancy.
   if(!res.destroyed){
    h._sendErrorResponse(res,503,'工作实例请求未安全完成');
    if(!res.writableEnded)res.end();
   }
  }));
 }
 return tracker;
}
module.exports={install};
