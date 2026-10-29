'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('vm'), fs = require('fs'), path = require('path'), {EventEmitter} = require('events');
function setup({idle = true, evalResult = '{"status":200,"text":"[]"}'} = {}) {
 const middleware = [];
 const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wrp-'));
 fs.mkdirSync(path.join(tmp, 'auth')); fs.writeFileSync(path.join(tmp, 'auth', 'auth-1.json'), '{}');
 const outer = { disable() {}, use(fn) { middleware.push(fn); } };
 const context = { module: { exports: {} }, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, URL,
  process: { ...process, env: { ...process.env, WORKER_ACCOUNT: '1', WORKER_SLOT: 'A' } },
  __dirname: tmp, __filename: path.join(tmp, 'worker-http.js'),
  require: name => name === 'express' ? () => outer : require(name) };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'worker-http.js'), 'utf8'), context);
 const evals = [];
 const page = { url: () => 'https://aistudio.google.com/apps/x', isClosed: () => false, evaluate: async (fn, code) => { evals.push(code); return evalResult; } };
 const system = { _createExpressApp: () => function generation() {},
  workerStatus: () => ({ account: 1, ready: true, busy: !idle, quarantined: false, hardQuarantine: false, activeRequests: idle ? 0 : 1, browserOperations: 0, pendingCompletions: 0 }),
  browserManager: { page, context: {}, currentAuthIndex: 1 } };
 const secret = 'a'.repeat(32);
 context.module.exports.install(system, secret); system._createExpressApp();
 const call = (body, key = secret) => new Promise(resolve => {
  const req = new EventEmitter(); Object.assign(req, { method: 'POST', path: '/internal/debug/rpc-probe', headers: { 'x-worker-key': key }, destroy() {} });
  let status = 200; const res = { destroyed: false, writableEnded: false, setHeader() { return this; },
   status(v) { status = v; return this; }, json(v) { this.writableEnded = true; resolve({ status, body: v }); return this; } };
  middleware[0](req, res, () => resolve({ status: 'next' }));
  setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
 });
 return { call, evals };
}
const ok = { method: 'CreateInteractionStream', request: [null, true, null, [], null, true], hashText: 'hi' };
test('rpc probe needs the worker key', async () => {
 const { call, evals } = setup(); const r = await call(ok, 'wrong');
 assert.equal(r.status, 401); assert.equal(evals.length, 0);
});
test('rpc probe only allows the two listed methods', async () => {
 const { call, evals } = setup();
 for (const method of ['GenerateContent', 'DeleteApplet', 'ProxyUnaryCall', '__proto__', 'constructor']) {
  const r = await call({ ...ok, method }); assert.equal(r.status, 400, method);
 }
 assert.equal(evals.length, 0);
});
test('rpc probe refuses while the worker is busy', async () => {
 const { call, evals } = setup({ idle: false }); const r = await call(ok);
 assert.equal(r.status, 409); assert.equal(evals.length, 0);
});
test('rpc probe runs once in the page and returns the page result', async () => {
 const { call, evals } = setup(); const r = await call({ ...ok, method: 'CreateOrchestrationStream' });
 assert.equal(r.status, 200); assert.equal(r.body.status, 200); assert.equal(evals.length, 1);
 assert.match(evals[0], /"CreateOrchestrationStream"/); assert.match(evals[0], /\[5\]\)$/);
});
test('rpc probe rejects oversized hash text', async () => {
 const { call, evals } = setup(); const r = await call({ ...ok, hashText: 'x'.repeat(2001) });
 assert.equal(r.status, 400); assert.equal(evals.length, 0);
});
