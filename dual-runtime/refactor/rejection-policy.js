'use strict';

const DAY = 86400000;
const REGION = /region not supported|not available in your (?:country|region)|unsupported[_\s-]*(?:country|region|location)|user location is not supported|available-regions/i;
function isRegionBlock(result) {
  if (result?.status !== 403 && result?.status !== 400) return false;
  const body = result.rejection?.body;
  const text = Buffer.isBuffer(body) ? body.toString('utf8', 0, Math.min(body.length, 8192)) : String(body || '');
  return REGION.test(text);
}

// A rate limit belongs to the account/model that received it. An HTTP 429 is
// never evidence that other accounts, models or the whole service are blocked.
function rejectionCooldown(result, now = Date.now()) {
  if (isRegionBlock(result)) return { scope: 'egress', until: 0 };
  if (![401, 403, 429].includes(result?.status)) return;
  if (result.status === 401) return { scope: 'account', until: now + DAY };
  if (result.status === 403) return { scope: 'model', until: now + DAY };

  const raw = Array.isArray(result.retryAfter) ? result.retryAfter[0] : result.retryAfter;
  let delay;
  if (typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim())) {
    delay = Number(raw) * 1000;
  } else if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) delay = parsed - now;
  }
  if (!Number.isFinite(delay)) {
    const body = result.rejection?.body;
    const message = Buffer.isBuffer(body) ? body.toString('utf8') : '';
    // Generic RESOURCE_EXHAUSTED can be RPM/TPM. Only explicit daily/balance
    // evidence gets a day-long default; a provider Retry-After takes priority.
    const exhausted = /insufficient[_\s-]*quota|daily[^\n]{0,80}(?:quota|limit)|(?:quota|limit)[^\n]{0,80}daily|per[\s_-]*day|requests?\s*\/\s*day|\brpd\b|额度不足|余额不足|每日|每天/i.test(message);
    delay = exhausted ? DAY : 60000;
  }
  return { scope: 'model', until: now + Math.ceil(Math.max(1000, Math.min(DAY, delay))) };
}

function deadline(task, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(message)), timeoutMs);
    Promise.resolve().then(task).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

module.exports = { rejectionCooldown, deadline, isRegionBlock };
