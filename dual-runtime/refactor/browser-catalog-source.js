 'use strict';
const {randomUUID} = require('crypto');

// Bridge to the EXISTING worker runtime. Install after worker-operations.
// Caller supplies the same tracker and requestScope used by that worker.
// This is a candidate adapter; no production entry point imports it yet.
function createBrowserCatalogSource({system, tracker, requestScope, account,
  timeoutMs = 15000, maxBytes = 2097152}) {
  const h = system.requestHandler, r = system.connectionRegistry;
  if (!Number.isSafeInteger(account) || account < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !h.stabilityGate || !tracker || !requestScope) {
    throw Error('Invalid catalog worker dependencies');
  }
  return async function fetchPage({account: expected, pageToken, signal} = {}) {
    if (expected !== account) throw Error('Catalog account mismatch');
    if (pageToken !== undefined &&
        (typeof pageToken !== 'string' || pageToken.length > 4096)) {
      throw Error('Invalid catalog page token');
    }
    const deadline = Date.now() + timeoutMs;
    const valid = () => !signal?.aborted && Date.now() < deadline;
    if (!valid()) throw Error('Catalog request cancelled');
    // Gate owns admission even while a caller aborts its wait. Do not release
    // its slot until browser completion has been acknowledged or quarantined.
    const result = await requestScope.run(new Set(), () =>
      h.stabilityGate.run(async () => {
        if (!valid()) throw Error('Catalog request cancelled');
        const cooldown = Math.max(h.globalCooldownUntil || 0,
          h.accountCooldowns?.get(account)?.until || 0);
        if (cooldown > Date.now()) throw Error('Catalog account cooling');
        if (tracker.quarantined || tracker.active.size >= 2 ||
            system.browserManager.currentAuthIndex !== account) {
          throw Error('Catalog worker unavailable');
        }
        const socket = r.getFirstConnection();
        if (!socket || socket.readyState !== 1) throw Error('Catalog browser unavailable');
        const operationId = 'catalog-' + randomUUID();
        const queue = r.createMessageQueue(operationId);
        let timer, status, body = '', size = 0, failed = false;
        const cancel = () => {
          try { h._cancelBrowserRequest(operationId); }
          catch {
            if (tracker.active.has(operationId)) tracker.unconfirmed.add(operationId);
          }
        };
        const abort = () => {
          failed = true;
          // Closing this queue unblocks dequeue; the tracker retains occupancy.
          r.removeMessageQueue(operationId);
          cancel();
        };
        const disconnected = owner => { if (owner === socket) abort(); };
        try {
          signal?.addEventListener('abort', abort, {once:true});
          r.on('connectionRemoved', disconnected);
          timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
          if (!valid()) throw Error('Catalog request cancelled');
          h._forwardRequest({
            request_id:operationId, method:'GET', path:'/v1beta/models',
            headers:{Accept:'application/json'},
            query_params:pageToken === undefined ? {pageSize:100} : {pageSize:100,pageToken},
            body:'', is_generative:false, streaming_mode:'fake'
          });
          while (true) {
            const message = await queue.dequeue(Math.max(1, deadline - Date.now()));
            if (failed || !valid()) throw Error('Catalog request interrupted');
            if (message.event_type === 'error') {
              const code = Number(message.status);
              if ([401,403,429].includes(code)) {
                await h._handleRequestFailureAndSwitch({
                  status:code, retry_after:message.retry_after,
                  message:'Catalog upstream rejected request'
                });
              }
              throw Error('Catalog upstream rejected request');
            }
            if (message.event_type === 'response_headers') {
              if (status !== undefined || message.status !== 200) {
                throw Error('Invalid catalog response status');
              }
              status = message.status;
            } else if (message.event_type === 'chunk') {
              if (status !== 200 || typeof message.data !== 'string') {
                throw Error('Invalid catalog response sequence');
              }
              size += Buffer.byteLength(message.data);
              if (size > maxBytes) throw Error('Catalog response too large');
              body += message.data;
            } else if (message.type === 'STREAM_END') {
              if (status !== 200) throw Error('Catalog response missing headers');
              const data = JSON.parse(body);
              if (!data || !Array.isArray(data.models)) throw Error('Invalid catalog response');
              return data;
            } else {
              throw Error('Unexpected catalog response event');
            }
          }
        } catch {
          throw Error('Browser catalog fetch failed');
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          r.removeListener('connectionRemoved', disconnected);
          r.removeMessageQueue(operationId);
          if (tracker.active.has(operationId)) {
            // JSON received is not sufficient completion evidence.
            const ended = await tracker.finishOrCancel(operationId, cancel, 250, 10000);
            if (!ended) throw Error('Catalog operation completion unconfirmed');
          }
        }
      }, valid)
    );
    if (!valid()) throw Error('Catalog request cancelled');
    if (!result) throw Error('Catalog request not executed');
    return result;
  };
}
module.exports = {createBrowserCatalogSource};
