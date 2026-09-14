'use strict';
const fs=require('fs');
const path=require('path');
function createWorker(System,account,authDir){
 if(!Number.isSafeInteger(account)||account<1)throw Error('Invalid worker account');
 const names=fs.readdirSync(authDir).filter(n=>n.startsWith(`auth-`) && n.endsWith(`.json`));
 if(names.length!==1||names[0]!==`auth-${account}.json`)throw Error('Worker requires exactly its assigned authentication file');
 const stat=fs.lstatSync(path.join(authDir,names[0]));
 if(!stat.isFile()||stat.isSymbolicLink())throw Error('Authentication must be a regular file');
 const system=new System();
 const ids=system.authSource.availableIndices;
 if(ids.length!==1||ids[0]!==account)throw Error('Loaded account differs from assignment');
 system.config.switchOnUses=0;
 system.config.failureThreshold=0;
 system.config.immediateSwitchStatusCodes=[];
 system.requestHandler.maxRetries=1;
 system.requestHandler._switchToNextAuth=async()=>({success:false,reason:'Account assignment is controlled by the coordinator'});
 system.requestHandler._switchToSpecificAuth=async()=>({success:false,reason:'Account assignment is controlled by the coordinator'});
 const status=()=>{
  const b=system.browserManager;
  const ready=b.currentAuthIndex===account && Boolean(b.context) && Boolean(b.page) && !b.page.isClosed() && system.connectionRegistry.hasActiveConnections() && system.connectionRegistry.protocolReady?.()===true;
  return {account,ready,busy:system.requestHandler.stabilityGate?.busy===true,activeRequests:system.connectionRegistry.messageQueues.size};
 };
 return {system,status};
}
module.exports={createWorker};
