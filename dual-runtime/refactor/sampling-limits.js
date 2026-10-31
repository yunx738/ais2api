'use strict';
// Sampling parameters Google rejects with 400 INVALID_ARGUMENT (each limit verified live).
// Out-of-range numbers are clamped, junk values dropped, so the request still goes through.
const LIMITS = {
  temperature: {min: 0, max: 2},
  topP: {min: 0, max: 1},
  topK: {min: 1, int: true, dropBelow: true}, // 0 / negative usually means "off" in clients
  thinkingBudget: {min: -1, max: 65535, int: true},
};
const MAX_STOP = 5;
function clampField(holder, key, rule, label, notes) {
  if (!holder || typeof holder !== 'object' || !Object.hasOwn(holder, key)) return;
  const raw = holder[key];
  if (raw === null || raw === undefined) return;
  let n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) { delete holder[key]; notes.push(label + ' 无效已忽略'); return; }
  if (rule.int) n = Math.round(n);
  if (rule.dropBelow && n < rule.min) { delete holder[key]; notes.push(label + '=' + raw + ' 已忽略'); return; }
  if (n < rule.min) n = rule.min;
  if (rule.max !== undefined && n > rule.max) n = rule.max;
  if (n !== raw) { holder[key] = n; notes.push(label + ' ' + JSON.stringify(raw) + '→' + n); }
}
function fixStop(holder, key, notes) {
  if (!holder || typeof holder !== 'object' || !Object.hasOwn(holder, key)) return;
  const raw = holder[key];
  if (raw === null || raw === undefined) return;
  if (typeof raw === 'string') { if (raw === '') { delete holder[key]; notes.push(key + ' 为空已忽略'); } return; }
  if (!Array.isArray(raw)) { delete holder[key]; notes.push(key + ' 无效已忽略'); return; }
  let list = [...new Set(raw.filter(x => typeof x === 'string' && x !== ''))];
  if (list.length > MAX_STOP) { notes.push(key + ' ' + list.length + '个→前' + MAX_STOP + '个'); list = list.slice(0, MAX_STOP); }
  else if (list.length !== raw.length) notes.push(key + ' 去掉了空值或重复');
  if (!list.length) { delete holder[key]; return; }
  if (list.length !== raw.length) holder[key] = list;
}
// Mutates parsed; returns human-readable notes of what was changed.
function fixSampling(route, parsed) {
  const notes = [];
  if (!parsed || typeof parsed !== 'object') return notes;
  if (route === '/v1/chat/completions') {
    clampField(parsed, 'temperature', LIMITS.temperature, 'temperature', notes);
    clampField(parsed, 'top_p', LIMITS.topP, 'top_p', notes);
    clampField(parsed, 'top_k', LIMITS.topK, 'top_k', notes);
    fixStop(parsed, 'stop', notes);
    return notes;
  }
  for (const gk of ['generationConfig', 'generation_config']) {
    const gc = parsed[gk];
    if (!gc || typeof gc !== 'object' || Array.isArray(gc)) continue;
    clampField(gc, 'temperature', LIMITS.temperature, 'temperature', notes);
    for (const k of ['topP', 'top_p']) clampField(gc, k, LIMITS.topP, k, notes);
    for (const k of ['topK', 'top_k']) clampField(gc, k, LIMITS.topK, k, notes);
    for (const k of ['stopSequences', 'stop_sequences']) fixStop(gc, k, notes);
    for (const tk of ['thinkingConfig', 'thinking_config']) {
      const tc = gc[tk];
      if (tc && typeof tc === 'object') for (const k of ['thinkingBudget', 'thinking_budget']) clampField(tc, k, LIMITS.thinkingBudget, k, notes);
    }
  }
  return notes;
}
module.exports = {fixSampling, LIMITS, MAX_STOP};
