'use strict';
const {RequestHistory}=require('./request-history');
const {withDeadline}=require('./control-deadline');

// Analytics may be unavailable without taking generation admission down.
// Do not delete, repair or partially expose a corrupt history directory.
async function openHistory(dir,{timeoutMs=10000,historyOptions={},createHistory}={}){
 const history=createHistory?createHistory():new RequestHistory(dir,historyOptions);
 try{return await withDeadline(()=>history.init(),timeoutMs,'History initialization deadline exceeded');}
 catch{
  const unavailable=()=>{throw Object.assign(Error('Request history unavailable'),{statusCode:503});};
  // Use a separate failed facade: even a late init cannot publish partial data.
  return {begin:async()=>unavailable(),finish:async()=>unavailable(),
   list:unavailable,summary:unavailable,
   status:()=>({ready:false,degraded:true,error:'history_initialization_failed',records:null,capacity:null})};
 }
}
module.exports={openHistory};
