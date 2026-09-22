'use strict';
// Analytics never owns admission, quota deduction or execution reconciliation.
function createRecordedForward({history,forward,priceFor=()=>void 0,clock=Date.now}){
 const health={beginFailures:0,finishFailures:0,lastFailureAt:null};
 async function recorded(ticket,route,body,res,credentials,options){
  let started=false,continuationPossible=false;
  try{
   let parsed={};try{parsed=JSON.parse(body.toString('utf8'));}catch{}
   const native=route.startsWith('/v1beta/models/');
   const requestedModel=native?route.slice('/v1beta/models/'.length).split(':')[0]:parsed.model;
   continuationPossible=typeof requestedModel==='string' && requestedModel.startsWith('anti-truncation/');
   await history.begin({
    id:ticket.id,model:ticket.model,requestedModel,account:ticket.account,
    slot:ticket.slot,workerEpoch:ticket.workerEpoch,
    stream:native?route.endsWith(':streamGenerateContent'):parsed.stream===true,
    price:priceFor(ticket.model)
   });
   started=true;
  }catch{
   health.beginFailures++;health.lastFailureAt=clock();
  }
  let result;
  try{
   result=await forward(ticket,route,body,res,credentials,options);
   return result;
  }finally{
   if(started){
    const m=result?.metrics;
    const recordedMetrics=m && continuationPossible?
     {...m,usageComplete:false}:m;
    const outcome=result?.cancelled?'cancelled':
     !result||result.uncertain?'uncertain':
     Number.isInteger(result.status)&&result.status>=400?'http_error':
     m?.applicationError?'application_error':
     result.status>=200&&result.status<300&&m?.transportComplete?'success':'uncertain';
    try{await history.finish(ticket.id,{outcome,httpStatus:result?.status,metrics:recordedMetrics});}
    catch{health.finishFailures++;health.lastFailureAt=clock();}
   }
  }
 }
 recorded.status=()=>({...health,history:history.status()});
 return recorded;
}
module.exports={createRecordedForward};
