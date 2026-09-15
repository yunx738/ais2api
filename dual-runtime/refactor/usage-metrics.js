'use strict';
// No request/response text is returned or persisted by this module.
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
function normalizeUsage(payload, provenance = 'response-reported-unverified') {
 if (!payload || typeof payload !== 'object') return null;
 const native = payload.usageMetadata;
 const openai = payload.usage;
 const u = native || openai;
 if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
 const input = count(native ? u.promptTokenCount : u.prompt_tokens);
 const output = count(native ? u.candidatesTokenCount : u.completion_tokens);
 const cached = count(native ? u.cachedContentTokenCount : u.prompt_tokens_details?.cached_tokens);
 const reasoning = count(native ? u.thoughtsTokenCount : u.completion_tokens_details?.reasoning_tokens);
 const total = count(native ? u.totalTokenCount : u.total_tokens);
 if ([input,output,cached,reasoning,total].every(v => v === null)) return null;
 return {
  input,output,cached,reasoning,total,
  format:native?'gemini':'openai',source:provenance,
  reasoningIncludedInOutput:!native,
  validCache:cached === null || input === null || cached <= input
 };
}
function validatePrice(p) {
 if (!p || p.currency !== 'USD' || typeof p.revision !== 'string' || !p.revision ||
     !['included','separate','unknown'].includes(p.reasoningMode)) throw Error('Invalid price metadata');
 for (const k of ['inputPerMillion','outputPerMillion','cachedPerMillion','reasoningPerMillion']) {
  if (p[k] !== null && (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0)) throw Error('Invalid price rate');
 }
 return {...p};
}
function estimateCost(usage, price) {
 const unknown = reason => ({amount:null,currency:'USD',estimated:true,reason});
 if (!usage) return unknown('usage_missing');
 if (!price) return unknown('price_missing');
 try { validatePrice(price); } catch { return unknown('price_invalid'); }
 if (usage.input === null || usage.output === null) return unknown('token_breakdown_missing');
 if (!usage.validCache) return unknown('cache_count_invalid');
 if (price.inputPerMillion === null || price.outputPerMillion === null) return unknown('rate_missing');
 let cached = usage.cached;
 if (cached === null) {
  if (price.cachedPerMillion !== price.inputPerMillion) return unknown('cache_breakdown_missing');
  cached = 0; // Equal rates: unknown cache split cannot affect the price.
 }
 if (cached > 0 && price.cachedPerMillion === null) return unknown('cache_rate_missing');
 let value = (usage.input-cached)*price.inputPerMillion + cached*(price.cachedPerMillion ?? 0);
 value += usage.output*price.outputPerMillion;
 if (!usage.reasoningIncludedInOutput) {
  if (price.reasoningMode === 'unknown') return unknown('reasoning_price_unknown');
  if (price.reasoningMode === 'separate') {
   if (usage.reasoning === null) return unknown('reasoning_count_missing');
   if (usage.reasoning > 0 && price.reasoningPerMillion === null) return unknown('reasoning_rate_missing');
   value += usage.reasoning*(price.reasoningPerMillion ?? 0);
  }
 }
 const amount = value / 1e6;
 if (!Number.isFinite(amount)) return unknown('cost_overflow');
 return {amount,currency:price.currency,estimated:true,reason:null,priceRevision:price.revision,usageSource:usage.source};
}
module.exports={normalizeUsage,validatePrice,estimateCost};
