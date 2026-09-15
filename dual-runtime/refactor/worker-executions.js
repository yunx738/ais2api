 'use strict';
const {AsyncLocalStorage}=require('async_hooks');
const {randomUUID}=require('crypto');
const {ExecutionLedger}=require('./execution-ledger');
// Protocol v2: completion is bound to page session and worker epoch.
function install({system,tracker,account,slot}) {
  if(!['A','B'].includes(slot))throw Error('Invalid execution slot');
  const ledger=new ExecutionLedger(),scope=new AsyncLocalStorage();
  const epoch=system.connectionRegistry.workerEpoch,attempts=new Map(),owners=new Map(),sessions=new WeakMap();
  const h=system.requestHandler,r=system.connectionRegistry;
  const identity=/^[a-f0-9-]{36}$/;
  let clock=Date.now(); const now=()=>clock=Math.max(clock,Date.now()); const tombstones=new Map();
  const prune=()=>{const time=now();for(const [id,until] of tombstones)if(until<time){tombstones.delete(id);attempts.delete(id);}};
  const session=socket=>{
    const value=r.sessionIdentity(socket);
    if(!value)throw Error("Verified browser session unavailable");
    sessions.set(socket,value);
    return value;
  };
  const begin=tracker.begin.bind(tracker);
  tracker.begin=id=>{
    const attempt=scope.getStore();
    if(!attempt)return begin(id); // Catalog operations retain their own tracker.
    const sessionId=session(r.getFirstConnection());
    begin(id);
    try {
      ledger.register(attempt,{operationId:id,sessionId});
      owners.set(id,{attemptId:attempt,operationId:id,sessionId,workerEpoch:epoch});
    } catch(error) {
      tracker.quarantined=true;
      throw error;
    }
  };
  const acknowledge=tracker.acknowledge.bind(tracker);
  tracker.acknowledge=id=>{
    const evidence=owners.get(id);
    if(!tracker.active.has(id))return false;
    if(evidence)ledger.confirm(evidence);
    const confirmed=acknowledge(id);
    if(confirmed)owners.delete(id);
    return confirmed;
  };
  r.on('connectionRemoved',socket=>{
    const sessionId=sessions.get(socket);
    if(sessionId)ledger.disconnected(epoch,sessionId);
  });
  for(const name of ['processRequest','processOpenAIRequest']) {
    const original=h[name].bind(h);
    h[name]=async(req,res)=>{
      // Reentrant calls belong to the same execution, never a second admission.
      if(scope.getStore())return original(req,res);
      const attemptId=req.headers['x-execution-id'];
      const requestId=req.headers['x-request-id'];
      const expected=req.headers['x-worker-epoch'];
      if(!identity.test(attemptId||'')||!identity.test(requestId||'')||
         expected!==epoch) {
        return h._sendErrorResponse(res,409,'Execution identity or worker epoch mismatch');
      }
      prune(); const deadline=Number(req.headers["x-admission-deadline"]),time=now();
      if(!Number.isSafeInteger(deadline)||deadline<time||deadline>time+60000)return h._sendErrorResponse(res,409,"Invalid admission deadline");
      if(attempts.size>=20000)return h._sendErrorResponse(res,503,"Admission capacity unavailable");
      if(attempts.has(attemptId)) {
        return h._sendErrorResponse(res,409,'Execution attempt already admitted');
      }
      // No unsafe eviction. Durable settlement receipts will permit bounded
      // record pruning; until then refuse new records at the ledger limit.
      try {
        ledger.begin({requestId,attemptId,account,slot,workerEpoch:epoch});
        attempts.set(attemptId,deadline);
      } catch {
        return h._sendErrorResponse(res,503,'Execution record capacity unavailable');
      }
      let responseRecorded=false;
      const record=outcome=>{
        if(responseRecorded)return;
        ledger.responseEnded(attemptId,outcome);responseRecorded=true;
      };
      const finished=()=>record(res.statusCode >= 400?'failed':'success');
      const closed=()=>{
        if(res.writableFinished)finished();else record('cancelled');
      };
      res.once('finish',finished);res.once('close',closed);
      try {
        return await scope.run(attemptId,()=>original(req,res));
      } catch(error) {
        record('failed');
        if(!res.destroyed && !res.writableEnded) {
          if(res.headersSent)res.destroy();
          else h._sendErrorResponse(res,502,'Execution failed');
        }
      } finally {
        // The original operation wrapper includes cancellation settlement.
        // A completed HTTP response alone never seals this record.
        ledger.seal(attemptId);
        if(res.writableFinished)finished();else if(res.destroyed)closed();
      }
    };
  }
  const originalStatus=system.workerStatus.bind(system);
  system.workerStatus=()=>({...originalStatus(),workerEpoch:epoch,executionProtocol:2});
  const read=(attemptId,admissionDeadline)=>{
    if(!identity.test(attemptId||''))throw Error('Invalid attempt ID');
    let record;
    try{record=ledger.get(attemptId);}catch{ prune(); const admissionClosed=Number.isSafeInteger(admissionDeadline) && admissionDeadline>0 && admissionDeadline<now() && !attempts.has(attemptId); return {account,slot,workerEpoch:epoch,found:false,attemptId,admissionClosed,admissionDeadline:admissionClosed?admissionDeadline:undefined}; }
    return {account,slot,workerEpoch:epoch,found:true,record};
  };
  const retire=(attemptId,expectedEpoch,expectedAccount)=>{
    if(!identity.test(attemptId)||expectedEpoch!==epoch||expectedAccount!==account)throw Error("Retirement identity mismatch");
    prune(); const result=read(attemptId);
    if(result.found){
      if(!result.record.releasable)throw Error("Execution not settled");
      const deadline=attempts.get(attemptId);
      if(!Number.isSafeInteger(deadline))throw Error("Admission evidence unavailable");
      ledger.forget(attemptId);tombstones.set(attemptId,deadline);prune();
    }
    return {retired:true,account,slot,workerEpoch:epoch,attemptId};
  };
  system.executions={read,retire,epoch};
  return system.executions;
}
module.exports={install};
