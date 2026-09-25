 'use strict';
// Coordinator-local exclusion. Restart reconciliation must restore safety
// before admission; this in-memory lock is not restart-completion evidence.
class SlotOperations {
  #held = new Map();
  acquire(slot, kind) {
    if (!['A','B'].includes(slot) ||
        !['rotation','recovery','catalog','cleanup','proxy','auth'].includes(kind)) {
      throw Error('Invalid slot operation');
    }
    if (this.#held.has(slot)) return undefined;
    const token = Object.freeze({slot,kind});
    this.#held.set(slot,token);
    return token;
  }
  has(slot) { return this.#held.has(slot); }
  status(slot) {
    const token = this.#held.get(slot);
    return token ? {kind:token.kind} : undefined;
  }
  release(token) {
    if (!token || this.#held.get(token.slot) !== token) {
      throw Error('Stale slot operation release');
    }
    this.#held.delete(token.slot);
  }
}
module.exports = {SlotOperations};
