'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { DispatchCore } = require('./dispatch-core');
const { RequestScheduler } = require('./request-scheduler');
const { rejectionCooldown } = require('./rejection-policy');
const route = '/v1/chat/completions';
const model = 'fixture-flash';
const body = Buffer.from(JSON.stringify({ model }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, message = 'condition not reached') {
 const until = Date.now() + 1500;
 while (!predicate() && Date.now() < until) await sleep(2);
 assert.ok(predicate(), message);
}
function response() {
 const res = new EventEmitter();
 Object.assign(res, { headers: {}, chunks: [], headersSent: false, destroyed: false, writableEnded: false });
 res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
 res.end = data => { if (data) res.chunks.push(Buffer.from(data)); res.headersSent = true; res.writableEnded = true; res.emit('finish'); };
 res.destroy = () => { res.destroyed = true; res.emit('close'); };
 return res;
}
function fixture(t, forward, options = {}, clientOverrides = {}) {
 const pool = { ids: [4, 5, 6, 7], slots: new Map([['A', { current: 4 }], ['B', { current: 5 }]]),
  owners: new Map([[4, 'A'], [5, 'B']]), cooldowns: new Map(),
  cooldown(id, until) { this.cooldowns.set(id, Math.max(this.cooldowns.get(id) || 0, until)); } };
 let saves = 0;
 const dispatch = new DispatchCore(pool, () => { saves++; });
 for (const state of dispatch.slots.values()) { state.ready = true; state.workerEpoch = randomUUID(); }
 const client = {
  execution: async () => ({ found: true, record: { releasable: true } }),
  retireExecution: async () => ({}), ...clientOverrides
 };
 const scheduler = new RequestScheduler(dispatch, client, forward, { A: {}, B: {} }, {
  queueTimeoutMs: 400, controlTimeoutMs: 30, confirmationTimeoutMs: 30, executionTimeoutMs: 500, ...options
 });
 scheduler.resolveModel = (_, input) => ({ model: JSON.parse(input.toString()).model, quotaFamily: 'flash', eligible: () => true });
 t.after(() => scheduler.close());
 return { dispatch, scheduler, pool, client, saves: () => saves };
}
function rejected(status = 429, text = '{"error":{"message":"rate limit"}}', retryAfter = '60') {
 return { status, retryAfter, rejection: { status, headers: { 'content-type': 'application/json', 'retry-after': retryAfter }, body: Buffer.from(text) } };
}

test('429 is persisted only against rejected account/model and retries a different account after proof', async t => {
 const calls = [];
 const f = fixture(t, async (ticket, requestRoute, requestBody, res, keys, options) => {
  assert.equal(options.deferRejections, true); assert.equal(requestBody, body); assert.equal(requestRoute, route);
  calls.push(ticket);
  if (calls.length === 1) return rejected();
  assert.equal(f.dispatch.slots.get('A').active, 0, 'original execution must be proven settled');
  res.statusCode = 200; res.end('ok'); return { status: 200 };
 });
 const res = response(); f.scheduler.submit(route, body, res);
 await eventually(() => res.writableEnded);
 assert.equal(res.statusCode, 200); assert.equal(Buffer.concat(res.chunks).toString(), 'ok');
 assert.deepEqual(calls.map(c => c.account), [4, 5]);
 assert.notEqual(calls[0].id, calls[1].id);
 assert.equal(f.dispatch.globalUntil, 0);
 assert.equal(f.pool.cooldowns.has(4), false);
 assert.equal(f.dispatch.quotas.view(4, model, 'flash').allowed, false);
 assert.equal(f.dispatch.quotas.view(4, 'other-flash', 'flash').allowed, true);
 assert.equal(f.dispatch.quotas.view(5, model, 'flash').cooldownUntil, 0);
 assert.ok(f.saves() >= 3); assert.equal(f.scheduler.status().retried, 1);
});

test('unproven rejection is returned but neither replayed nor released', async t => {
 let calls = 0;
 const f = fixture(t, async () => { calls++; return rejected(); }, {}, {
  execution: async () => ({ found: true, record: { releasable: false } })
 });
 const res = response(); f.scheduler.submit(route, body, res);
 await eventually(() => res.writableEnded);
 assert.equal(calls, 1); assert.equal(res.statusCode, 429);
 assert.equal(res.headers['retry-after'], '60');
 assert.equal(f.dispatch.slots.get('A').active, 1);
 assert.equal(Object.values(f.dispatch.slots.get('A').executions)[0].phase, 'reconciling');
 assert.equal(f.scheduler.queue.length, 0);
});

test('a disconnected or uncertain request cannot be replayed even if execution later settles', async t => {
 for (const result of [{ ...rejected(), uncertain: true }, { ...rejected(), cancelled: true }]) {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return result; });
  const res = response(); f.scheduler.submit(route, body, res);
  await eventually(() => res.writableEnded);
  assert.equal(calls, 1); assert.equal(f.scheduler.status().retried, 0);
 }
});

test('hung generation stays quarantined while another slot serves new work', async t => {
 const calls = [], signals = [];
 const f = fixture(t, async (ticket, requestRoute, requestBody, res, credentials, options) => {
  calls.push(ticket);
  signals.push(options.signal);
  if (ticket.slot === 'A') return new Promise(() => {});
  res.statusCode = 200; res.end('healthy'); return { status: 200 };
 }, { executionTimeoutMs: 35 }, {
  execution: async ticket => ({ found: true, record: { releasable: ticket.slot !== 'A' } })
 });
 const stuck = response(), healthy = response();
 f.scheduler.submit(route, body, stuck); f.scheduler.submit(route, body, healthy);
 await eventually(() => healthy.writableEnded);
 assert.equal(healthy.statusCode, 200);
 await eventually(() => stuck.writableEnded);
 assert.equal(stuck.statusCode, 504);
 assert.equal(f.dispatch.slots.get('A').active, 1);
 assert.equal(f.dispatch.slots.get('A').ready, false);
 assert.equal(calls.length, 2); assert.equal(f.scheduler.status().executionTimeouts, 1);
 assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
});

test('retirement stuck on A does not block completed execution checks on B', async t => {
 const queried = [];
 const f = fixture(t, async () => ({}), {}, {
  execution: async ticket => { queried.push(ticket.slot); return { found: true, record: { releasable: true } }; },
  retireExecution: async ticket => ticket.slot === 'A' ? new Promise(() => {}) : {}
 });
 const a = f.dispatch.acquire(randomUUID(), { model, quotaFamily: 'flash' }, slot => slot === 'A');
 f.dispatch.finish(a, true);
 const b = f.dispatch.acquire(randomUUID(), { model, quotaFamily: 'flash' }, slot => slot === 'B');
 const reconciliation = f.scheduler.reconcile();
 await eventually(() => queried.includes('B'));
 assert.equal(f.dispatch.slots.get('B').active, 0);
 await reconciliation;
 assert.ok(f.dispatch.slots.get('A').retirements[a.id]);
 assert.equal(f.dispatch.slots.get('B').executions[b.id], undefined);
});

test('the same rejected account is never retried and no remaining accounts returns the original error promptly', async t => {
 const calls = [];
 const f = fixture(t, async ticket => { calls.push(ticket); return rejected(); });
 f.pool.ids = [4, 5];
 const res = response(); f.scheduler.submit(route, body, res);
 await eventually(() => res.writableEnded);
 assert.equal(res.statusCode, 429); assert.deepEqual(calls.map(c => c.account), [4, 5]);
 assert.equal(f.scheduler.queue.length, 0);
 assert.equal(f.scheduler.status().queueExpired, 0);
});

test('retries are capped even when many spare accounts exist', async t => {
 const calls = [];
 const f = fixture(t, async ticket => { calls.push(ticket); return rejected(); }, { maxAttempts: 2 });
 const res = response(); f.scheduler.submit(route, body, res);
 await eventually(() => res.writableEnded);
 assert.equal(res.statusCode, 429); assert.equal(calls.length, 2); assert.equal(f.scheduler.queue.length, 0);
});

test('temporarily missing catalog preserves queued demand and skips to an unrelated model', async t => {
 const f = fixture(t, async (ticket, requestRoute, requestBody, res) => { res.end(ticket.model); return { status: 200 }; });
 for (const state of f.dispatch.slots.values()) state.ready = false;
 const slow = response(); f.scheduler.submit(route, body, slow);
 const resolve = f.scheduler.resolveModel;
 f.scheduler.resolveModel = (requestRoute, input) => {
  if (JSON.parse(input.toString()).model === model) throw Error('catalog refreshing');
  return resolve(requestRoute, input);
 };
 f.dispatch.slots.get('B').ready = true;
 const fast = response(); f.scheduler.submit(route, Buffer.from('{"model":"healthy-model"}'), fast);
 await eventually(() => fast.writableEnded);
 assert.equal(slow.writableEnded, false); assert.equal(f.scheduler.queue.length, 1);
 assert.deepEqual(f.scheduler.pendingPlans(), [{ model, quotaFamily: 'flash', excludedAccounts: [] }]);
});

test('queue deadline is not reset after a rejected attempt and disconnect removes waiting work', async t => {
 const f = fixture(t, async () => rejected(), { queueTimeoutMs: 55 });
 f.dispatch.slots.get('B').ready = false;
 const res = response(); f.scheduler.submit(route, body, res);
 await eventually(() => f.scheduler.queue.length === 1);
 assert.deepEqual(f.scheduler.pendingPlans()[0].excludedAccounts, [4]);
 const originalDeadline = f.scheduler.queue[0].deadline;
 await eventually(() => res.writableEnded);
 assert.equal(res.statusCode, 429); assert.ok(Date.now() >= originalDeadline);
 const waiting = response(); f.scheduler.submit(route, body, waiting);
 assert.equal(f.scheduler.queue.length, 1); waiting.destroy();
 assert.equal(f.scheduler.queue.length, 0);
});

test('queued requests fail promptly when persistence halts dispatch', t => {
 const f = fixture(t, async () => ({}));
 for (const state of f.dispatch.slots.values()) state.ready = false;
 const res = response(); f.scheduler.submit(route, body, res);
 f.dispatch.halted = true; f.scheduler.pump();
 assert.equal(res.statusCode, 503); assert.equal(res.writableEnded, true); assert.equal(f.scheduler.queue.length, 0);
});

test('Retry-After and explicit exhaustion are bounded without treating every 429 as daily quota', () => {
 const now = 1700000000000;
 assert.deepEqual(rejectionCooldown(rejected(), now), { scope: 'model', until: now + 60000 });
 assert.equal(rejectionCooldown(rejected(429, '', '2'), now).until, now + 2000);
 assert.equal(rejectionCooldown(rejected(429, '', '1.0001'), now).until, now + 1001);
 assert.equal(rejectionCooldown(rejected(429, '', new Date(now + 90000).toUTCString()), now).until, now + 90000);
 assert.equal(rejectionCooldown(rejected(429, '', '999999999999'), now).until, now + 86400000);
 const daily = rejected(429, '{"error":{"message":"GenerateContent requests per day exceeded"}}', undefined);
 delete daily.retryAfter;
 assert.equal(rejectionCooldown(daily, now).until, now + 86400000);
 assert.equal(rejectionCooldown({ status: 429 }, now).until, now + 60000);
 assert.equal(rejectionCooldown({ status: 403 }, now).scope, 'model');
 assert.equal(rejectionCooldown({ status: 401 }, now).scope, 'account');
 assert.equal(rejectionCooldown({ status: 500 }, now), undefined);
});
