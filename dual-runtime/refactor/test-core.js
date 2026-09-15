'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseRequestModel} = require('./request-model');
const {ExecutionLedger} = require('./execution-ledger');
function begin(l, attemptId) {
  l.begin({requestId:'r-'+attemptId, attemptId, slot:'A', account:4, workerEpoch:'w1'});
}
function operation(l, attemptId, operationId) {
  l.register(attemptId,{operationId,sessionId:'s1'});
}
function confirm(l, attemptId, operationId, sessionId='s1') {
  return l.confirm({attemptId,operationId,sessionId,workerEpoch:'w1'});
}
test('native model comes from URL, not a default quota bucket', () => {
  assert.equal(parseRequestModel('/v1beta/models/example-pro:generateContent',{}).upstreamId,'example-pro');
  assert.throws(() => parseRequestModel('/v1beta/models/example-pro:generateContent',{model:'other'}));
});
test('proxy prefix is separate from the upstream model ID', () => {
  const r = parseRequestModel('/v1/chat/completions',{model:'anti-truncation/example-new'});
  assert.equal(r.upstreamId,'example-new'); assert.equal(r.antiTruncation,true);
  assert.throws(() => parseRequestModel('/v1/chat/completions',{}));
  assert.throws(() => parseRequestModel('/v1/chat/completions',{model:'../bad'}));
});
test('one completed execution does not wait for another execution', () => {
  const l = new ExecutionLedger();
  begin(l,'a'); begin(l,'b'); operation(l,'a','oa'); operation(l,'b','ob');
  l.responseEnded('a','success'); l.seal('a'); confirm(l,'a','oa');
  assert.equal(l.get('a').releasable,true);
  assert.equal(l.get('b').releasable,false);
});
test('continuations require sealing and all operation confirmations', () => {
  const l = new ExecutionLedger(); begin(l,'a'); operation(l,'a','o1'); confirm(l,'a','o1');
  assert.equal(l.get('a').releasable,false);
  operation(l,'a','o2'); l.seal('a');
  assert.equal(l.get('a').releasable,false);
  confirm(l,"a","o2"); assert.equal(l.get("a").releasable,false);
  l.responseEnded("a","success"); assert.equal(l.get("a").releasable,true);
  assert.throws(() => operation(l,'a','o3'));
});
test('disconnect and response failure cannot release browser occupancy', () => {
  const l = new ExecutionLedger(); begin(l,'a'); operation(l,'a','o1');
  l.responseEnded('a','failed'); l.seal('a'); l.disconnected('w1','s1');
  assert.equal(l.get('a').operations[0].state,'uncertain');
  assert.equal(l.get('a').releasable,false);
  assert.throws(() => confirm(l,'a','o1','new-session'));
  assert.equal(confirm(l,'a','o1'),true);
  assert.equal(confirm(l,'a','o1'),false);
  assert.equal(l.get('a').releasable,true);
});
test('identity conflicts, capacity and external mutations cannot erase live work', () => {
  const l = new ExecutionLedger({limit:1}); begin(l,'a'); operation(l,'a','o1');
  assert.throws(() => begin(l,'b'));
  assert.throws(() => l.begin({requestId:'different',attemptId:'a',slot:'A',account:4,workerEpoch:'w1'}));
  l.get('a').operations[0].state='settled';
  assert.equal(l.get('a').operations[0].state,'running');
  assert.throws(() => l.forget('a'));
  l.responseEnded('a','cancelled'); l.seal('a'); confirm(l,'a','o1'); l.forget('a');
  begin(l,'b');
});
