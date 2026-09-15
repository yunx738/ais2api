 'use strict';
const {ModelCatalog}=require('./model-catalog');
const {createBrowserCatalogSource}=require('./browser-catalog-source');
function install({system,tracker,requestScope,account}) {
  const source=createBrowserCatalogSource({system,tracker,requestScope,account});
  const catalog=new ModelCatalog({fetchPage:source,timeoutMs:60000});
  let running=null,attemptedAt=null,completedAt=null,error=null,retryAt=0;
  let jobId;
  const workerStatus=system.workerStatus.bind(system);
  const status=()=>({
    account,workerEpoch:system.executions.epoch,jobId,source:'browser-upstream',syncing:Boolean(running),
    attemptedAt,completedAt,retryAt,error,snapshot:catalog.snapshot(account),
    storage:'memory',generationRoutingIntegrated:false
  });
  system.workerStatus=()=>{
    const s=workerStatus();
    return {...s,ready:s.ready && !running,busy:s.busy || Boolean(running),catalogSyncing:Boolean(running)};
  };
  const refresh=(requestedJob,expectedAccount)=>{
    if(expectedAccount!==account || typeof requestedJob!=='string' ||
       !/^[a-f0-9-]{36}$/.test(requestedJob)) {
      return {accepted:false,account,jobId:requestedJob,reason:'invalid_job'};
    }
    const reject=reason=>({accepted:false,account,jobId:requestedJob,reason,retryAt});
    if(jobId===requestedJob)return {accepted:true,account,jobId,replayed:true};
    if(running)return reject('already_syncing');
    if(Date.now()<retryAt)return reject('retry_later');
    const s=workerStatus();
    if(s.account!==account || !s.ready || s.quarantined || s.busy ||
       s.activeRequests!==0 || s.browserOperations!==0 || s.cooldownUntil>Date.now()) {
      return reject('worker_not_idle');
    }
    jobId=requestedJob;attemptedAt=Date.now();error=null;retryAt=attemptedAt+60000;
    running=Promise.resolve().then(()=>catalog.refresh(account))
      .then(()=>{completedAt=Date.now();})
      .catch(()=>{error='upstream_catalog_sync_failed';})
      .finally(()=>{running=null;});
    return {accepted:true,account,jobId};
  };
  system.modelCatalog={status,refresh};
  return system.modelCatalog;
}
module.exports={install};
