'use strict';
// Bound control-plane waits. Expiry is uncertainty, never proof of completion.
function withDeadline(operation, timeoutMs = 6000, message = 'Control request deadline exceeded') {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}
module.exports = {withDeadline};
