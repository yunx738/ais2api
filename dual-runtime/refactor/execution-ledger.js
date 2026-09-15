'use strict';
function id(value) {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new Error('Invalid identity');
  }
  return value;
}
// Worker-local records. Transport adapters must authenticate all evidence.
// An absent operation in a reconnect snapshot is NOT completion evidence.
class ExecutionLedger {
  #records = new Map();
  #operations = new Map();
  constructor({limit = 10000} = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid record limit');
    this.limit = limit;
  }
  begin({requestId, attemptId, slot, account, workerEpoch}) {
    for (const value of [requestId, attemptId, slot, workerEpoch]) id(value);
    if (!Number.isSafeInteger(account) || account < 1) throw new Error('Invalid account');
    const prior = this.#records.get(attemptId);
    if (prior) {
      if (['requestId','slot','account','workerEpoch'].some(k =>
        prior[k] !== ({requestId,slot,account,workerEpoch})[k])) {
        throw new Error('Attempt identity conflict');
      }
      return this.get(attemptId);
    }
    if (this.#records.size >= this.limit) throw new Error('Execution ledger full');
    this.#records.set(attemptId, {
      requestId, attemptId, slot, account, workerEpoch,
      response: null, sealed: false, operations: new Map()
    });
    return this.get(attemptId);
  }
  #require(attemptId) {
    const r = this.#records.get(attemptId);
    if (!r) throw new Error('Unknown execution attempt');
    return r;
  }
  register(attemptId, {operationId, sessionId}) {
    id(operationId); id(sessionId);
    const r = this.#require(attemptId);
    const old = r.operations.get(operationId);
    if (old) {
      if (old.sessionId !== sessionId) throw new Error('Operation identity conflict');
      return this.get(attemptId);
    }
    if (r.sealed) throw new Error('Execution already sealed');
    if (this.#operations.has(operationId)) throw new Error('Operation ID reused');
    r.operations.set(operationId, {operationId, sessionId, state: 'running'});
    this.#operations.set(operationId, attemptId);
    return this.get(attemptId);
  }
  responseEnded(attemptId, outcome) {
    if (!['success','failed','cancelled'].includes(outcome)) throw new Error('Invalid response outcome');
    const r = this.#require(attemptId);
    if (r.response !== null && r.response !== outcome) throw new Error('Response outcome conflict');
    r.response = outcome;
    return this.get(attemptId);
  }
  // Seal ONLY after the handler can no longer create continuation operations.
  seal(attemptId) {
    this.#require(attemptId).sealed = true;
    return this.get(attemptId);
  }
  disconnected(workerEpoch, sessionId) {
    id(workerEpoch); id(sessionId);
    const affected = [];
    for (const r of this.#records.values()) {
      let changed = false;
      if (r.workerEpoch !== workerEpoch) continue;
      for (const op of r.operations.values()) {
        if (op.sessionId === sessionId && op.state === 'running') {
          op.state = 'uncertain'; changed = true;
        }
      }
      if (changed) affected.push(r.attemptId);
    }
    return affected;
  }
  confirm({attemptId, workerEpoch, sessionId, operationId}) {
    const r = this.#require(attemptId);
    const op = r.operations.get(operationId);
    if (!op || r.workerEpoch !== workerEpoch || op.sessionId !== sessionId) {
      throw new Error('Completion identity mismatch');
    }
    if (op.state === 'settled') return false;
    op.state = 'settled';
    return true;
  }
  get(attemptId) {
    const r = this.#require(attemptId);
    const operations = [...r.operations.values()].map(op => ({...op}));
    return {
      requestId:r.requestId, attemptId:r.attemptId, slot:r.slot,
      account:r.account, workerEpoch:r.workerEpoch,
      response:r.response, sealed:r.sealed, operations,
      releasable:r.sealed && r.response !== null && operations.every(op => op.state === 'settled')
    };
  }
  // Call only after the coordinator has durably acknowledged settlement.
  forget(attemptId) {
    const state = this.get(attemptId);
    if (!state.releasable || state.response === null) throw new Error('Execution not settled');
    for (const op of state.operations) this.#operations.delete(op.operationId);
    this.#records.delete(attemptId);
  }
}
module.exports = {ExecutionLedger};
