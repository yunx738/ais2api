'use strict';
const {OperationTracker}=require('./operation-tracker');
function install(system){
 const h=system.requestHandler,r=system.connectionRegistry;
 const tracker=new OperationTracker();
 const forward=h._forwardRequest.bind(h);
 r.on('operationDone',id=>tracker.acknowledge(id));
 h._forwardRequest=function(request){
  tracker.begin(request.request_id);
  try{return forward(request);}
  catch(error){tracker.quarantined=true;throw error;}
 };
 for(const name of ['processRequest','processOpenAIRequest']){
  const original=h[name].bind(h);
  h[name]=(req,res)=>h.stabilityGate.run(async()=>{
   if(res.destroyed)return;
   if(tracker.quarantined){
    return h._sendErrorResponse(res,503,'工作实例等待安全恢复');
   }
   try{return await original(req,res);}
   finally{
    for(const id of [...tracker.active.keys()]){
     await tracker.finishOrCancel(id,x=>h._cancelBrowserRequest(x),res.writableEnded?250:0);
    }
   }
  },()=>!res.destroyed).catch(()=>{
   tracker.quarantined=true;
   if(!res.destroyed){
    h._sendErrorResponse(res,503,'工作实例请求未安全完成');
    if(!res.writableEnded)res.end();
   }
  });
 }
 return tracker;
}
module.exports={install};
