'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const fs = require('fs'), vm = require('vm'), path = require('path');
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

const bodyMsg='{"error":{"message":"谷歌拒绝生成这条请求","code":"build_input_rejected"}}';
const failed=()=>({status:400,rejection:{status:400,headers:{'content-type':'application/json','x-ais-build-retry':'upstream_failed'},body:Buffer.from(bodyMsg)}});
test('Build upstream failure (400 + retry marker) is replayed once on the other slot', async t => {
 const calls=[];
 const f=fixture(t, async (ticket, r, b, res) => {
  calls.push(ticket);
  if(calls.length===1)return failed();
  res.statusCode=200;res.end('ok');return {status:200};
 });
 const res=response();f.scheduler.submit(route, body, res);
 await eventually(()=>res.writableEnded);
 assert.equal(res.statusCode,200);assert.equal(Buffer.concat(res.chunks).toString(),'ok');
 assert.deepEqual(calls.map(c=>c.slot),['A','B']);
 assert.equal(f.pool.cooldowns.size,0,'no account cooldown');
 assert.equal(f.scheduler.status().retried,1);
});
test('both slots fail: the original "edit your input" 400 is returned, marker not leaked', async t => {
 const calls=[];
 const f=fixture(t, async ticket => { calls.push(ticket); return failed(); });
 const res=response();f.scheduler.submit(route, body, res);
 await eventually(()=>res.writableEnded);
 assert.equal(res.statusCode,400);
 assert.match(Buffer.concat(res.chunks).toString(),/build_input_rejected/);
 assert.equal(res.headers['x-ais-build-retry'],undefined);
 assert.deepEqual(calls.map(c=>c.slot),['A','B']);
});
test('a plain 400 (no marker) is never retried', async t => {
 const calls=[];
 const f=fixture(t, async ticket => { calls.push(ticket); return {status:400,rejection:{status:400,headers:{'content-type':'application/json'},body:Buffer.from('{}')}}; });
 const res=response();f.scheduler.submit(route, body, res);
 await eventually(()=>res.writableEnded);
 assert.equal(res.statusCode,400);assert.equal(calls.length,1);assert.equal(f.scheduler.status().retried,0);
});
test('forward-worker defers only the marked 400 and keeps the marker internally', () => {
 const s=fs.readFileSync(path.join(__dirname,'forward-worker.js'),'utf8');
 assert.ok(s.includes("const buildRetry=reply.statusCode===400&&reply.headers['x-ais-build-retry']==='upstream_failed';"));
 assert.ok(s.includes('([401,403,429].includes(reply.statusCode)||buildRetry)'));
 const w=fs.readFileSync(path.join(__dirname,'build-worker.js'),'utf8');
 assert.ok(w.includes("res.setHeader('X-AIS-Build-Retry','upstream_failed')"));
});
