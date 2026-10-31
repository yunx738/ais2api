'use strict';
const assert = require('assert');
const {fixSampling} = require('./sampling-limits');
const {sanitizeRequest} = require('./request-sanitizer');
const C = '/v1/chat/completions', N = '/v1beta/models/m:generateContent';
let n = 0; const test = (name, fn) => { fn(); n++; };
test('in-range values untouched', () => {
  const b = {temperature: 2, top_p: 0, top_k: 1000, stop: ['a', 'b', 'c', 'd', 'e']};
  assert.deepEqual(fixSampling(C, b), []);
  assert.deepEqual(b, {temperature: 2, top_p: 0, top_k: 1000, stop: ['a', 'b', 'c', 'd', 'e']});
  assert.deepEqual(fixSampling(C, {stop: 'END', top_p: null}), []);
});
test('openai out-of-range clamped / dropped', () => {
  const b = {temperature: 2.5, top_p: 1.5, top_k: 0, stop: ['1', '2', '3', '4', '5', '6']};
  assert.equal(fixSampling(C, b).length, 4);
  assert.deepEqual(b, {temperature: 2, top_p: 1, stop: ['1', '2', '3', '4', '5']});
  const c = {temperature: -1, top_p: -0.1, top_k: -1};
  fixSampling(C, c); assert.deepEqual(c, {temperature: 0, top_p: 0});
});
test('junk values', () => {
  const b = {temperature: '0.7', top_p: 'abc', top_k: 3.6, stop: ['', 'x', 'x']};
  fixSampling(C, b); assert.deepEqual(b, {temperature: 0.7, top_k: 4, stop: ['x']});
  const c = {stop: ['']}; fixSampling(C, c); assert.deepEqual(c, {});
  const d = {stop: 5}; fixSampling(C, d); assert.deepEqual(d, {});
});
test('native generationConfig and thinking budget', () => {
  const b = {generationConfig: {temperature: 3, topP: -0.1, topK: 0, stopSequences: ['a', 'b', 'c', 'd', 'e', 'f'], thinkingConfig: {thinkingBudget: 1000000}}};
  fixSampling(N, b);
  assert.deepEqual(b.generationConfig, {temperature: 2, topP: 0, stopSequences: ['a', 'b', 'c', 'd', 'e'], thinkingConfig: {thinkingBudget: 65535}});
  const c = {generation_config: {thinking_config: {thinking_budget: -5}}}; fixSampling(N, c);
  assert.equal(c.generation_config.thinking_config.thinking_budget, -1);
  const d = {generationConfig: {thinkingConfig: {thinkingBudget: 1.5}}}; fixSampling(N, d);
  assert.equal(d.generationConfig.thinkingConfig.thinkingBudget, 2);
  const e = {generationConfig: {thinkingConfig: {thinkingBudget: -1}, topK: 64}}; assert.deepEqual(fixSampling(N, e), []);
});
test('wired into sanitizeRequest', () => {
  const r = sanitizeRequest(C, {temperature: 9});
  assert.equal(r.changed, true); assert.equal(r.body.temperature, 2); assert.ok(r.notes.length);
  const s = sanitizeRequest(C, {temperature: 1});
  assert.equal(s.changed, false);
});
console.log('sampling-limits: ' + n + ' tests ok');
