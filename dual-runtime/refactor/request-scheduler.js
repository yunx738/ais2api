"use strict";
const { randomUUID } = require("crypto");
const { rejectionCooldown, deadline } = require("./rejection-policy");

class RequestScheduler {
 constructor(dispatch, client, forward, credentials, options = {}) {
  Object.assign(this, { dispatch, client, forward, credentials });
  this.queue = []; this.executing = new Set(); this.checking = new Map();
  this.closed = false; this.pumping = false; this.resolveModel = null;
  this.limits = { queueLimit: 10, queueTimeoutMs: 120000, maxAttempts: 3,
   executionTimeoutMs: 610000, controlTimeoutMs: 5500, confirmationTimeoutMs: 5500, ...options };
  for (const value of Object.values(this.limits)) {
   if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid scheduler limit');
  }
  this.counts = { retried: 0, queueExpired: 0, queueRejected: 0, executionTimeouts: 0 };
  this.wakeup = setInterval(() => {
   this.reconcile().catch(() => console.error("[Execution] reconciliation failed"));
   this.pump();
  }, 1000);
  this.wakeup.unref();
 }
 close() {
  this.closed = true; clearInterval(this.wakeup);
  this.drain("Coordinator stopping");
 }
 drain(message) {
  for (const item of [...this.queue]) { item.remove(); this.fail(item.res, 503, message); }
 }
 fail(res, code, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.statusCode = code; res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: { message } }));
 }
 status() {
  return { ...this.limits, ...this.counts, queued: this.queue.length, executing: this.executing.size };
 }
 pendingPlans() {
  const plans = new Map();
  for (const item of this.queue) {
   if (item.res.destroyed || item.res.writableEnded) continue;
   const excludedAccounts = [...item.attemptedAccounts];
   const key = JSON.stringify([item.plan.model, excludedAccounts]);
   if (!plans.has(key)) plans.set(key, { model: item.plan.model,
    quotaFamily: item.plan.quotaFamily, excludedAccounts });
  }
  return [...plans.values()];
 }
 respondRejection(item) {
  const response = item.rejection;
  if (!response || item.res.destroyed || item.res.writableEnded) return;
  if (item.res.headersSent) { item.res.destroy(); return; }
  item.res.statusCode = response.status;
  for (const key of ['content-type', 'retry-after', 'cache-control']) {
   if (response.headers?.[key] !== undefined) item.res.setHeader(key, response.headers[key]);
  }
  item.res.end(response.body);
 }
 enqueue(item) {
  if (this.closed || this.dispatch.halted) {
   this.fail(item.res, 503, this.closed ? 'Coordinator stopping' : 'Dispatch admission unavailable'); return false;
  }
  if (item.res.destroyed || item.res.writableEnded) return false;
  const remaining = item.deadline - Date.now();
  if (remaining <= 0) {
   this.counts.queueExpired++;
   if (item.rejection) this.respondRejection(item);
   else this.fail(item.res, 503, 'Queue wait deadline exceeded');
   return false;
  }
  if (this.queue.length >= this.limits.queueLimit) {
   this.counts.queueRejected++;
   if (item.rejection) this.respondRejection(item);
   else this.fail(item.res, 503, 'Request queue full');
   return false;
  }
  const expire = () => {
   if (!this.queue.includes(item)) return;
   const wait = item.deadline - Date.now();
   // Timers may fire before an absolute wall-clock deadline (rounding or a
   // clock adjustment). Keep the admitted request until its real deadline.
   if (wait > 0) { item.timer = setTimeout(expire, Math.min(wait, 2147483647)); return; }
   item.remove(); this.counts.queueExpired++;
   if (item.rejection) this.respondRejection(item);
   else this.fail(item.res, 503, 'Queue wait deadline exceeded');
  };
  item.timer = setTimeout(expire, Math.min(remaining, 2147483647));
  item.res.on('close', item.remove); this.queue.push(item); return true;
 }
 submit(route, body, res) {
  if (this.closed || this.dispatch.halted) return this.fail(res, 503, 'Coordinator unavailable');
  let plan;
  try {
   if (!this.resolveModel) throw Error('Model routing unavailable');
   // Validate model policy immediately, but admit known models while their
   // account catalogs are temporarily unavailable. Keeping that demand in the
   // bounded queue lets recovery/rotation prepare a worker for this request.
   plan = this.resolveModel(route, body, { allowUnavailable: true });
  } catch (error) { return this.fail(res, error.statusCode || 503, error.message); }
  const item = { id: randomUUID(), route, body, res, plan, attempts: 0,
   attemptedAccounts: new Set(), deadline: Date.now() + this.limits.queueTimeoutMs };
  item.remove = () => {
   const i = this.queue.indexOf(item); if (i >= 0) this.queue.splice(i, 1);
   clearTimeout(item.timer); res.removeListener('close', item.remove);
  };
  if (this.enqueue(item)) this.pump();
 }
 pump() {
  if (this.closed || this.pumping) return;
  if (this.dispatch.halted) { this.drain('Dispatch admission unavailable'); return; }
  this.pumping = true;
  try {
   // Scan every queued model. A stuck worker or unavailable model must not
   // prevent unrelated work from reaching another healthy worker.
   for (const item of [...this.queue]) {
    if (item.res.destroyed || item.res.writableEnded) { item.remove(); continue; }
    if (Date.now() >= item.deadline) {
     item.remove(); this.counts.queueExpired++;
     if (item.rejection) this.respondRejection(item);
     else this.fail(item.res, 503, 'Queue wait deadline exceeded');
     continue;
    }
    let ticket;
    try {
     item.plan = this.resolveModel(item.route, item.body);
    } catch (error) {
     // Catalogs temporarily disappear while an account rotates. Preserve the
     // admitted request and its original deadline while waiting for readiness.
     if ([400, 404, 422].includes(error.statusCode)) {
      item.remove(); this.fail(item.res, error.statusCode, error.message);
     }
     continue;
    }
    try {
     ticket = this.dispatch.acquire(item.id, item.plan, (slot, account) =>
      !item.attemptedAccounts.has(account) && (!item.plan.eligible || item.plan.eligible(slot, account)));
    } catch {
     item.remove(); this.fail(item.res, 503, 'Dispatch admission unavailable');
     if (this.dispatch.halted) { this.drain('Dispatch admission unavailable'); break; }
     continue;
    }
    if (!ticket) continue;
    item.remove(); item.attempts++; item.attemptedAccounts.add(ticket.account);
    this.executing.add(ticket);
    this.execute(ticket, item).catch(() => {
     this.fail(item.res, 502, 'Execution failed; completion requires reconciliation');
    }).finally(() => { this.executing.delete(ticket); this.pump(); });
   }
  } finally { this.pumping = false; }
 }
 applyRejection(ticket, result) {
  if (result?.workerRejection) return;
  const restriction = rejectionCooldown(result);
  if (!restriction) return;
  if (restriction.scope === 'account') this.dispatch.pool.cooldown(ticket.account, restriction.until);
  else this.dispatch.quotas.defer(ticket.account, ticket.model, ticket.kind, restriction.until);
  this.dispatch.checkpoint();
 }
 hasRetryCandidate(item) {
  return this.dispatch.pool.ids.some(account => {
   if (item.attemptedAccounts.has(account) || (this.dispatch.pool.cooldowns.get(account) || 0) >= item.deadline) return false;
   const quota = this.dispatch.quotas.view(account, item.plan.model, item.plan.quotaFamily);
   return quota.cooldownUntil < item.deadline && (!quota.legacyBlocked || quota.legacyUntil < item.deadline) &&
    (quota.remaining > 0 || (quota.windowEnd > 0 && quota.windowEnd < item.deadline));
  });
 }
 async execute(ticket, item) {
  let result;
  const controller = new AbortController();
  try {
   result = await deadline(() => this.forward(ticket, item.route, item.body, item.res,
    this.credentials[ticket.slot], { deferRejections: true, signal: controller.signal }), this.limits.executionTimeoutMs, 'Forwarding deadline exceeded');
  } catch (error) {
   controller.abort();
   const timeout = error.message === 'Forwarding deadline exceeded';
   if (timeout) this.counts.executionTimeouts++;
   this.fail(item.res, timeout ? 504 : 502, timeout ? 'Worker request timeout' : 'Worker forwarding failed');
  }
  // A transport timeout/disconnect NEVER releases occupancy and NEVER retries
  // a generation. Only the worker execution protocol may prove it is settled.
  try { this.applyRejection(ticket, result); }
  finally { this.dispatch.markUncertain(ticket); }

  const retryable = !!result?.rejection && !result.workerRejection && !result.uncertain && !result.cancelled &&
   [401, 403, 429].includes(result.status) && !item.res.headersSent &&
   !item.res.destroyed && !item.res.writableEnded;
  const canRetry = retryable && item.attempts < this.limits.maxAttempts && this.hasRetryCandidate(item);
  const until = Math.min(item.deadline, Date.now() + this.limits.confirmationTimeoutMs);
  let confirmed = await this.check(ticket, canRetry ? Math.max(1, until - Date.now()) : this.limits.controlTimeoutMs);
  if (canRetry && !confirmed) {
   while (!confirmed && Date.now() < until && !this.closed && !this.dispatch.halted && !item.res.destroyed) {
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, until - Date.now()))));
    if (Date.now() < until) confirmed = await this.check(ticket, until - Date.now());
   }
  }
  if (!result?.rejection) return;
  item.rejection = result.rejection;
  if (canRetry && confirmed && !this.closed && !this.dispatch.halted && this.hasRetryCandidate(item)) {
   // Each attempt has a new execution identity; never reuse or double-charge
   // the old ticket. Failed accounts remain excluded for this logical request.
   item.id = randomUUID();
   if (this.enqueue(item)) { this.counts.retried++; return; }
  } else this.respondRejection(item);
 }
 async check(ticket, timeoutMs = this.limits.controlTimeoutMs) {
  if (this.dispatch.halted) return false;
  if (this.checking.has(ticket.id)) return this.checking.get(ticket.id);
  const work = (async () => {
   try {
    const data = await deadline(() => this.client.execution(ticket), Math.min(this.limits.controlTimeoutMs, timeoutMs), 'Execution check timed out');
    if ((data.found && data.record?.releasable === true) || (!data.found && data.admissionClosed === true)) {
     this.dispatch.finish(ticket, true);
     // Retirement is independent of completion. One slow acknowledgement must
     // not delay reconciliation or failover onto the other slot.
     this.retire(ticket).catch(() => {});
     return true;
    }
   } catch {
    // Missing records, transport failure and changed epochs are not completion.
   }
   return false;
  })();
  this.checking.set(ticket.id, work);
  try { return await work; } finally { this.checking.delete(ticket.id); }
 }
 async retire(ticket) {
  const key = 'retire:' + ticket.id;
  if (this.dispatch.halted || this.checking.has(key)) return;
  const work = (async () => {
   try {
    await deadline(() => this.client.retireExecution(ticket), this.limits.controlTimeoutMs, 'Retirement timed out');
    if (!this.dispatch.halted) this.dispatch.retire(ticket);
   } catch {} // Durable pending retirement remains available for retry.
  })();
  this.checking.set(key, work);
  try { await work; } finally { this.checking.delete(key); }
 }
 async reconcile() {
  if (this.dispatch.halted) return;
  const retired = [...this.dispatch.slots.values()].flatMap(s => Object.values(s.retirements || {}));
  const live = new Set([...this.executing].map(t => t.id));
  const tickets = [...this.dispatch.slots.values()].flatMap(s => Object.values(s.executions || {}));
  // Start all independent checks together; never await one worker's retirement
  // before even contacting another worker's completed executions.
  await Promise.allSettled([
   ...retired.map(t => this.retire(t)),
   ...tickets.filter(t => !live.has(t.id)).map(t => this.check(t))
  ]);
 }
}
module.exports = { RequestScheduler };
