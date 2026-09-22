'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('vm'), fs = require('fs'), path = require('path');
const { PassThrough, Writable } = require('stream'), { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { ResponseMetrics } = require('./response-metrics');
async function forwardFixture({ status = 429, chunks = [], abort = false, defer = true, slow = false, signal, delay = 0, headers = {} }) {
 const collected = [];
 const res = new Writable({ highWaterMark: slow ? 1 : 16384,
  write(chunk, encoding, done) { collected.push(Buffer.from(chunk)); if (slow) setTimeout(done, 1); else done(); } });
 res.headers = {}; res.setHeader = (key, value) => { res.headers[key] = value; };
 res.on('error', () => {});
 let requests = 0;
 const http = { request(options, callback) {
  requests++;
  const req = new EventEmitter(); req.destroy = () => {};
  req.end = () => setTimeout(() => {
   const reply = new PassThrough(); reply.statusCode = status;
   reply.headers = { 'content-type': 'application/json', 'retry-after': '42', 'cache-control': 'no-store', ...headers };
   callback(reply);
   for (const chunk of chunks) reply.write(chunk);
   if (abort) { reply.emit('aborted'); reply.destroy(); } else reply.end();
  }, delay);
  return req;
 } };
 const context = { module: { exports: {} }, Buffer, setTimeout, clearTimeout,
  require: name => name === 'http' ? http : name === './response-metrics' ? { ResponseMetrics } : (() => { throw Error('Unexpected dependency'); })() };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'forward-worker.js'), 'utf8'), context);
 const ticket = { slot: 'A', id: randomUUID(), workerEpoch: randomUUID(), admissionDeadline: Date.now() + 30000 };
 const result = await context.module.exports.forwardWorker(ticket, '/v1/chat/completions', Buffer.from('{}'), res,
  { api: 'fixture', control: 'fixture' }, { deferRejections: defer, signal });
 if (!result.rejection && !result.uncertain && !res.destroyed && !res.writableFinished) await new Promise(resolve => res.once('finish', resolve));
 return { res, result, requests, bytes: Buffer.concat(collected) };
}

test('complete account rejection is withheld before any downstream output for scheduler decision', async () => {
 for (const status of [401, 403, 429]) {
  const source = Buffer.from('{"error":{"message":"fixture rejection"}}');
  const { result, res, bytes } = await forwardFixture({ status, chunks: [source.subarray(0, 10), source.subarray(10)] });
  assert.equal(result.status, status); assert.equal(result.retryAfter, '42');
  assert.deepEqual(result.rejection.body, source);
  assert.equal(result.rejection.headers['content-type'], 'application/json');
  assert.equal(result.rejection.headers['retry-after'], '42');
  assert.equal(result.metrics.transportComplete, true);
  assert.equal(bytes.length, 0); assert.equal(res.writableEnded, false);
  assert.equal(Object.keys(res.headers).length, 0);
  res.destroy();
 }
});

test('normal responses and unrelated HTTP errors remain byte-for-byte transparent', async () => {
 for (const status of [200, 400, 500]) {
  const source = Buffer.from('{"choices":[{"message":{"content":"原始内容"}}]}');
  const { result, res, bytes } = await forwardFixture({ status, chunks: [source] });
  assert.deepEqual(bytes, source); assert.equal(res.statusCode, status);
  assert.equal(result.rejection, undefined); assert.equal(res.writableEnded, true);
 }
});

test('oversized rejection becomes ordinary pass-through with no replay eligibility and preserves backpressure bytes', async () => {
 const chunks = [Buffer.alloc(32768, 'a'), Buffer.alloc(32768, 'b'), Buffer.alloc(10, 'c'), Buffer.alloc(32768, 'd')];
 const { result, res, bytes } = await forwardFixture({ chunks, slow: true });
 assert.deepEqual(bytes, Buffer.concat(chunks));
 assert.equal(res.statusCode, 429); assert.equal(result.rejection, undefined);
 assert.equal(result.status, 429); assert.equal(res.writableEnded, true);
});

test('incomplete rejection never provides retry eligibility or complete transport evidence', async () => {
 const { result, res, bytes } = await forwardFixture({ chunks: [Buffer.from('{"error":')], abort: true });
 assert.equal(result.rejection, undefined); assert.equal(result.uncertain, true);
 assert.equal(result.metrics.transportComplete, false);
 assert.equal(res.destroyed, true); assert.equal(bytes.length, 0);
});

test('deferral is explicitly opt-in and standalone caller keeps previous rejection behavior', async () => {
 const source = Buffer.from('{"error":{"message":"throttled"}}');
 const { result, res, bytes } = await forwardFixture({ chunks: [source], defer: false });
 assert.deepEqual(bytes, source); assert.equal(res.statusCode, 429);
 assert.equal(result.rejection, undefined); assert.equal(result.metrics.applicationError, true);
});

test('local gateway denial retains provenance for scheduling without exposing internal response headers', async () => {
 const source = Buffer.from('{"error":"Unauthorized worker access"}');
 const { result, res, bytes } = await forwardFixture({ status: 401, chunks: [source],
  headers: { 'x-ais-worker-rejection': 'control_auth' } });
 assert.equal(result.workerRejection, 'control_auth');
 assert.deepEqual(result.rejection.body, source); assert.equal(bytes.length, 0);
 assert.equal(result.rejection.headers['x-ais-worker-rejection'], undefined);
 assert.equal(res.headers['x-ais-worker-rejection'], undefined);
 res.destroy();
});

test('cancellation prevents a late upstream reply from writing after the scheduler timeout response', async () => {
 const controller = new AbortController();
 const pending = forwardFixture({ status: 200, chunks: [Buffer.from('late generation')], signal: controller.signal, delay: 30 });
 setTimeout(() => controller.abort(), 3);
 const { res, result } = await pending;
 assert.equal(result.uncertain, true); assert.equal(result.rejection, undefined);
 res.statusCode = 504; res.end('timeout');
 await new Promise(resolve => setTimeout(resolve, 45));
 assert.equal(res.statusCode, 504);
 assert.equal(Object.keys(res.headers).length, 0);
});

test('cancellation before a delayed wrapper starts forwarding never opens a new request', async () => {
 const controller = new AbortController(); controller.abort();
 const { res, result, requests } = await forwardFixture({ signal: controller.signal });
 assert.equal(requests, 0); assert.equal(result.uncertain, true);
 res.destroy();
});
