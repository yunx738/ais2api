'use strict';
// Only decide when to request the existing durable catalog job workflow.
function shouldRefresh({account,epoch,state,cached,operation=false,jobs=0,rotating=false,now=Date.now()}){
 if(!Number.isSafeInteger(account)||account<1||!epoch||!state?.ready||state.active!==0||
    state.pending||state.pendingRetirements>0||state.legacyUnresolved>0||
    Object.keys(state.retirements||{}).length||Object.keys(state.executions||{}).length||
    state.requests?.size>0||operation||jobs>0||rotating)return false;
 // A fresh authenticated observation is required; transport failure is not an empty directory.
 if(!cached||cached.account!==account||cached.workerEpoch!==epoch||
    !Number.isFinite(cached.observedAt)||cached.observedAt>now||now-cached.observedAt>30000||
    cached.syncing)return false;
 const retryAt=Number.isFinite(cached.retryAt)?cached.retryAt:0;
 const attemptedAt=Number.isFinite(cached.attemptedAt)?cached.attemptedAt:0;
 if(now<Math.max(retryAt,attemptedAt?attemptedAt+60000:0))return false;
 const snapshot=cached.snapshot;
 return Boolean(cached.error||!snapshot||snapshot.account!==account||snapshot.stale||
   !Number.isSafeInteger(snapshot.updatedAt)||snapshot.updatedAt>now||now-snapshot.updatedAt>=1800000);
}
module.exports={shouldRefresh};
