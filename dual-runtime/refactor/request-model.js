'use strict';
const ANTI_PREFIX = 'anti-truncation/';
function parseRequestModel(route, body) {
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    body = JSON.parse(body.toString());
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('JSON object required');
  }
  let requested;
  if (route === '/v1/chat/completions') {
    requested = body.model;
  } else {
    const match = /^\/v1beta\/models\/([a-zA-Z0-9._-]+):(generateContent|streamGenerateContent)$/.exec(route);
    if (!match) throw new Error('Unsupported generation route');
    requested = match[1];
    if (body.model !== undefined && body.model !== requested) {
      throw new Error('Model in body conflicts with route');
    }
  }
  if (typeof requested !== 'string' || !requested) throw new Error('Model required');
  const antiTruncation = requested.startsWith(ANTI_PREFIX);
  const upstreamId = antiTruncation ? requested.slice(ANTI_PREFIX.length) : requested;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(upstreamId)) {
    throw new Error('Invalid model identifier');
  }
  return Object.freeze({requested, upstreamId, antiTruncation});
}
module.exports = {parseRequestModel};
