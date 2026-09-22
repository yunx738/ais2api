'use strict';
const {withDeadline} = require('./control-deadline');
const {shouldRefresh} = require('./catalog-refresh-policy');

// Each slot progresses independently; an unreachable worker never owns a global tick lock.
class CoordinatorMonitor {
  constructor({dispatch, client, catalogs, recovery, rotation, routing, scheduler, timeoutMs = 6000}) {
    Object.assign(this, {dispatch, client, catalogs, recovery, rotation, routing, scheduler, timeoutMs});
    this.running = new Map();
    this.health = new Map();
    this.closed = false;
  }
  status(slot) {
    return {...(this.health.get(slot) || {checkedAt: null, error: null, failureCount: 0}),
      inProgress: this.running.has(slot)};
  }
  close() { this.closed = true; }
  tick() {
    if (this.closed || this.dispatch.halted) return;
    for (const slot of this.dispatch.slots.keys()) {
      if (this.running.has(slot)) continue;
      const task = this.poll(slot).catch(() => {
        const state = this.dispatch.slots.get(slot);
        state.ready = false;
        const previous = this.health.get(slot);
        this.health.set(slot, {checkedAt: Date.now(), error: 'worker_control_unavailable',
          failureCount: (previous?.failureCount || 0) + 1});
        // Only checkpoint failures halt the whole coordinator, never an individual probe.
        try { this.dispatch.checkpoint(); } catch {}
      }).finally(() => {
        this.running.delete(slot);
        if (!this.closed) this.scheduler.pump();
      });
      this.running.set(slot, task);
    }
    this.scheduler.pump();
  }
  async poll(slot) {
    const d = this.dispatch, state = d.slots.get(slot);
    await this.rotation.reconcile?.(slot);
    this.catalogs.reconcile(slot).catch(() => {});
    this.recovery.check(slot).catch(() => {});
    const owner = d.pool.slots.get(slot), account = owner?.current;
    if (!owner || owner.pending || this.rotation.running.has(slot) || this.rotation.failures.has(slot)) return;

    const [probe] = await Promise.all([
      withDeadline(() => this.client.status(slot, account), this.timeoutMs),
      this.catalogs.jobs.has(slot) ? undefined :
        withDeadline(() => this.catalogs.read(slot), this.timeoutMs).catch(() => undefined)
    ]);
    if (this.closed || d.halted || d.pool.slots.get(slot) !== owner || owner.current !== account ||
        owner.pending || this.rotation.running.has(slot)) return;
    this.health.set(slot, {checkedAt: Date.now(), error: null, failureCount: 0});
    d.update(slot, probe);
    if (probe.cooldownUntil > Date.now()) d.pool.cooldown(account, probe.cooldownUntil);
    d.checkpoint();
    if (d.operations.has(slot)) return;

    const plan = this.routing.rotationPlan(slot, this.scheduler.pendingPlans());
    if (state.active === 0 && state.ready && plan) {
      // Rotation's per-slot lease and durable intent own this asynchronous operation.
      this.rotation.rotate(slot, false, plan.target, plan).catch(() => {});
      return;
    }
    if (shouldRefresh({account, epoch: state.workerEpoch, state,
      cached: this.catalogs.cache.get(slot), operation: d.operations.has(slot),
      jobs: this.catalogs.jobs.has(slot) ? 1 : 0, rotating: this.rotation.running.has(slot)})) {
      await this.catalogs.start(slot);
    }
  }
}
module.exports = {CoordinatorMonitor};
