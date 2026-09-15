'use strict';
const {parseRequestModel} = require('./request-model');
const copy = value => structuredClone(value);
function accountId(account) {
  if (!Number.isSafeInteger(account) || account < 1) throw Error('Invalid account');
}
function normalize(model) {
  if (!model || typeof model.name !== 'string' || !model.name.startsWith('models/')) {
    throw Error('Invalid upstream model');
  }
  const id = model.name.slice(7);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw Error('Invalid upstream model ID');
  const methods = model.supportedGenerationMethods;
  if (!Array.isArray(methods) || methods.some(x => typeof x !== 'string')) {
    throw Error('Missing model capabilities');
  }
  return {id, methods:[...new Set(methods)].sort()};
}
// fetchPage is an authenticated transport adapter, NOT arbitrary client input.
// It must return a decoded Google ListModels page and obey AbortSignal.
class ModelCatalog {
  #snapshots = new Map();
  #inflight = new Map();
  #failures = new Set();
  #policies;
  constructor({fetchPage, policies = {}, now = Date.now, maxPages = 100,
    maxModels = 10000, timeoutMs = 15000, staleAfterMs = 3600000} = {}) {
    if (typeof fetchPage !== 'function' || typeof now !== 'function') throw Error('Catalog adapters required');
    for (const n of [maxPages,maxModels,timeoutMs,staleAfterMs]) {
      if (!Number.isSafeInteger(n) || n < 1) throw Error('Invalid catalog limit');
    }
    this.fetchPage = fetchPage; this.now = now;
    this.maxPages = maxPages; this.maxModels = maxModels;
    this.timeoutMs = timeoutMs; this.staleAfterMs = staleAfterMs;
    this.#policies = new Map();
    for (const [id, policy] of Object.entries(policies)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) ||
          !policy || typeof policy.quotaBucket !== 'string' || !policy.quotaBucket ||
          typeof policy.antiTruncation !== 'boolean') throw Error('Invalid model policy');
      this.#policies.set(id,copy(policy));
    }
  }
  refresh(account) {
    accountId(account);
    if (this.#inflight.has(account)) return this.#inflight.get(account);
    const job = this.#refresh(account).finally(() => this.#inflight.delete(account));
    this.#inflight.set(account,job);
    return job;
  }
  async #refresh(account) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_,reject) => {
      timer = setTimeout(() => {
        controller.abort(); reject(Error('Catalog refresh deadline exceeded'));
      },this.timeoutMs);
    });
    try {
      const collect = async () => {
        const models = new Map(), tokens = new Set();
        let pageToken;
        for (let page = 0; page < this.maxPages; page++) {
          const result = await this.fetchPage({account,pageToken,signal:controller.signal});
          if (controller.signal.aborted) throw Error('Catalog refresh aborted');
          if (!result || !Array.isArray(result.models)) throw Error('Invalid catalog page');
          for (const item of result.models) {
            const model = normalize(item), prior = models.get(model.id);
            if (prior && JSON.stringify(prior) !== JSON.stringify(model)) throw Error('Conflicting model entries');
            models.set(model.id,model);
            if (models.size > this.maxModels) throw Error('Catalog too large');
          }
          const next = result.nextPageToken;
          if (next === undefined || next === '') return [...models.values()].sort((a,b) => a.id.localeCompare(b.id));
          if (typeof next !== 'string' || next.length > 4096 || tokens.has(next)) throw Error('Invalid pagination token');
          tokens.add(next); pageToken = next;
        }
        throw Error('Catalog page limit exceeded');
      };
      const models = await Promise.race([collect(),deadline]);
      this.#snapshots.set(account,{account,updatedAt:this.now(),models});
      this.#failures.delete(account);
      return this.snapshot(account);
    } catch {
      // Do not expose adapter errors containing credentials, URLs or response bodies.
      this.#failures.add(account);
      throw Error('Catalog refresh failed');
    } finally {
      clearTimeout(timer); controller.abort();
    }
  }
  snapshot(account) {
    accountId(account);
    const value = this.#snapshots.get(account);
    return value ? {...copy(value),stale:this.#failures.has(account) ||
      this.now()-value.updatedAt >= this.staleAfterMs} : null;
  }
  resolve(account,route,body) {
    const request = parseRequestModel(route,body);
    const snapshot = this.snapshot(account);
    if (!snapshot) throw Error('Catalog unavailable');
    const model = snapshot.models.find(m => m.id === request.upstreamId);
    if (!model) throw Error('Model not in account catalog');
    if (!model.methods.includes('generateContent')) throw Error('Generation unsupported');
    const policy = this.#policies.get(model.id);
    if (!policy) throw Error('Model quota policy required');
    if (request.antiTruncation && !policy.antiTruncation) throw Error('Proxy capability unsupported');
    return {...request,account,quotaBucket:policy.quotaBucket,catalogStale:snapshot.stale};
  }
}
module.exports = {ModelCatalog};
