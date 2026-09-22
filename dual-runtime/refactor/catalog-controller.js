 'use strict';
const {randomUUID}=require('crypto');
const {withDeadline}=require('./control-deadline');
// Task intent is persisted in slot.catalogTask before sending to the worker.
class CatalogController {
  constructor({dispatch,scheduler,client,call,rotation,timeoutMs=6000}) {
    Object.assign(this,{dispatch,scheduler,client,call,rotation});
    this.timeoutMs=timeoutMs;
    this.jobs=new Map();
    this.checking=new Set();
    this.cache=new Map();
    this.reading=new Map();
    for(const [slot,state] of dispatch.slots) {
      const saved=state.catalogTask;
      if(saved===undefined)continue;
      const owner=dispatch.pool.slots.get(slot);
      if(!saved || !/^[a-f0-9-]{36}$/.test(saved.id) ||
         !Number.isSafeInteger(saved.startedAt) || saved.startedAt<1 ||
         typeof saved.sent!=='boolean' || owner?.current!==saved.account ||
         owner.pending || state.active!==0) {
        throw Error('Invalid persisted catalog task');
      }
      const lease=dispatch.operations.acquire(slot,'catalog');
      if(!lease)throw Error('Catalog restore lock conflict');
      const job={...saved,slot,owner,lease,
        phase:saved.sent?'uncertain':'checking',
        error:saved.sent?'catalog_restart_reconciliation':undefined};
      state.ready=false;
      this.jobs.set(slot,job);
      // A persisted unsent intent cannot have reached the worker.
      if(!saved.sent)this.release(job);
    }
  }
  occupied(slot) {
    return [...this.scheduler.executing].some(t=>t.slot===slot);
  }
  current(job) {
    const owner=this.dispatch.pool.slots.get(job.slot);
    return owner===job.owner && owner.current===job.account && !owner.pending;
  }
  status() {
    return Object.fromEntries(['A','B'].map(slot=>{
      const account=this.dispatch.pool.slots.get(slot)?.current;
      const job=this.jobs.get(slot), cached=this.cache.get(slot);
      return [slot,{
        account,
        operation:job?{jobId:job.id,phase:job.phase,startedAt:job.startedAt,error:job.error}:undefined,
        catalog:cached?.account===account?structuredClone(cached):undefined
      }];
    }));
  }
  async read(slot) {
    if(!['A','B'].includes(slot))throw Error('Invalid slot');
    const owner=this.dispatch.pool.slots.get(slot),account=owner?.current;
    if(!account||owner.pending)throw Error('Account unavailable');
    const existing=this.reading.get(slot);
    if(existing?.owner===owner&&existing.account===account)return existing.promise;
    const reading={owner,account};
    reading.promise=withDeadline(()=>this.call(slot,account),this.timeoutMs).then(data=>{
      if(this.dispatch.pool.slots.get(slot)!==owner||owner.current!==account||owner.pending)
        throw Error('Account changed during catalog read');
      this.cache.set(slot,{...data,observedAt:Date.now()});
      return data;
    }).finally(()=>{if(this.reading.get(slot)===reading)this.reading.delete(slot);});
    this.reading.set(slot,reading);
    return reading.promise;
  }
  async start(slot) {
    if(!['A','B'].includes(slot))throw Error('Invalid slot');
    const d=this.dispatch,s=d.slots.get(slot),owner=d.pool.slots.get(slot);
    if(d.halted||this.scheduler.closed||!s?.ready||s.active!==0||
       this.occupied(slot)||!owner?.current||owner.pending||
       this.rotation.running.has(slot)||this.rotation.failures.has(slot)) {
      return {accepted:false,reason:'slot_not_idle'};
    }
    const lease=d.operations.acquire(slot,'catalog');
    if(!lease)return {accepted:false,reason:'slot_operation_running'};
    const job={slot,account:owner.current,owner,lease,id:randomUUID(),
      startedAt:Date.now(),phase:'checking',sent:false,error:undefined};
    this.jobs.set(slot,job);
    s.ready=false;
    try {
      this.persist(job);
      const probe=await withDeadline(()=>this.client.status(slot,job.account),this.timeoutMs);
      if(!this.current(job)||d.halted||this.scheduler.closed||s.active!==0||
         this.occupied(slot)||!probe.ready||probe.busy||probe.quarantined||
         probe.activeRequests!==0||probe.browserOperations!==0||probe.cooldownUntil>Date.now()) {
        this.release(job);
        return {accepted:false,reason:'worker_not_idle'};
      }
      // Mark uncertainty BEFORE the POST can reach the worker.
      if(!/^[a-f0-9-]{36}$/.test(probe.workerEpoch||""))throw Error("Worker epoch unavailable");
       job.workerEpoch=probe.workerEpoch;
       job.phase='starting';job.sent=true;
      this.persist(job);
      const result=await withDeadline(()=>this.call(slot,job.account,job.id),this.timeoutMs);
      if(!this.current(job))throw Error('Catalog ownership changed');
      if(result.accepted===false) {
        // Authenticated rejection of this exact ID confirms it was not started.
        this.release(job);
        return {accepted:false,reason:result.reason};
      }
      job.phase='syncing';
      return {accepted:true,slot,account:job.account,jobId:job.id};
    } catch {
      if(!job.sent) {
        this.release(job);
        return {accepted:false,reason:'catalog_preflight_failed'};
      }
      job.phase='uncertain';job.error='catalog_start_unconfirmed';
      return {accepted:false,pending:true,slot,jobId:job.id,reason:job.error};
    }
  }
  persist(job) {
    const state=this.dispatch.slots.get(job.slot);
    state.catalogTask={
      id:job.id,account:job.account,startedAt:job.startedAt,sent:job.sent,workerEpoch:job.workerEpoch
    };
    this.dispatch.checkpoint();
  }
  release(job) {
    // Leave ready=false. A fresh health reconciliation may re-enable admission.
    const state=this.dispatch.slots.get(job.slot);
    state.ready=false;
    const saved=state.catalogTask;
    delete state.catalogTask;
    try {
      this.dispatch.checkpoint();
    } catch(error) {
      // Keep the in-memory lock and intent if durable removal failed.
      if(saved!==undefined)state.catalogTask=saved;
      throw error;
    }
    this.dispatch.operations.release(job.lease);
    this.jobs.delete(job.slot);
  }
  async reconcile(slot) {
    const job=this.jobs.get(slot);
    if(!job||!job.sent||this.checking.has(slot)||job.phase==='starting')return;
    this.checking.add(slot);
    try {
      if(!this.current(job))throw Error('Catalog ownership changed');
      const data=await this.read(slot);
      if(!job.workerEpoch||data.workerEpoch!==job.workerEpoch||data.jobId!==job.id) {
        job.phase='uncertain';job.error='catalog_job_identity_unconfirmed';return;
      }
      if(data.syncing) {
        job.phase='syncing';job.error=undefined;return;
      }
      const probe=await withDeadline(()=>this.client.status(slot,job.account),this.timeoutMs);
      if(!this.current(job)||probe.workerEpoch!==job.workerEpoch||probe.busy||probe.activeRequests!==0) {
        job.phase='settling';return;
      }
      if(probe.browserOperations!==0||probe.pendingCompletions!==0) {
        job.phase='settling';return;
      }
      // Release only after this worker incarnation confirms browser occupancy is zero.
      this.release(job);
    } catch {
      job.phase='uncertain';job.error='catalog_reconciliation_unavailable';
    } finally {
      this.checking.delete(slot);
    }
  }
}
module.exports={CatalogController};
