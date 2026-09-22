'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('vm'), fs = require('fs'), path = require('path');

test('gateway labels only its own authentication denials before reaching generation', () => {
 const middleware = [];
 const outer = { disable() {}, use(fn) { middleware.push(fn); } };
 const context = { module: { exports: {} }, Buffer,
  require: name => name === 'express' ? () => outer : require(name) };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'worker-http.js'), 'utf8'), context);
 const secret = 'a'.repeat(32);
 const system = { _createExpressApp: () => function generation() {} };
 context.module.exports.install(system, secret); system._createExpressApp();
 for (const key of [undefined, 'wrong', 'b'.repeat(32), secret]) {
  const headers = {}; let next = 0, status, payload;
  const res = {
   setHeader(name, value) { headers[name.toLowerCase()] = value; return this; },
   status(value) { status = value; return this; },
   json(value) { payload = value; return this; }
  };
  middleware[0]({ method: 'POST', path: '/v1/chat/completions', headers: { 'x-worker-key': key } }, res, () => next++);
  if (key === secret) {
   assert.equal(next, 1); assert.equal(status, undefined);
   assert.equal(headers['x-ais-worker-rejection'], undefined);
  } else {
   assert.equal(next, 0); assert.equal(status, 401);
   assert.equal(headers['x-ais-worker-rejection'], 'control_auth');
   assert.equal(payload.error, 'Unauthorized worker access');
  }
 }
});
