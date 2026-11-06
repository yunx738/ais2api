'use strict';
// Anti-truncation helpers shared with the browser runtime (copied verbatim from code/unified-server.runtime.js:
// atDecodeJsonString / atCleanPlainAnswer). Used by the headless executor; keep in sync.
function atDecodeJsonString(src, i) {
  // src[i] is the opening quote. Returns { text, end } (end = index after closing quote, -1 if unterminated).
  let out = '', j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '"') return { text: out, end: j + 1 };
    if (ch === '\\' && j + 1 < src.length) {
      const e = src[j + 1];
      if (e === 'n') out += '\n'; else if (e === 't') out += '\t'; else if (e === 'r') out += '\r';
      else if (e === 'b') out += '\b'; else if (e === 'f') out += '\f';
      else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
      else out += e;
      j += 2; continue;
    }
    out += ch; j++;
  }
  return { text: out, end: -1 };
}
function atCleanPlainAnswer(plain) {
  const info = { plainLen: plain.length, literalNl: (plain.match(/\\n/g) || []).length, how: 'as-is' };
  const re = /(?:◁[^▷\n]{0,24}▷\s*)?(?:`{3}[a-z]*\s*)?(?:\[\s*)?(?:\{\s*"name"\s*:\s*"(?:seal_final_reply|final_answer|emit_answer)"\s*,\s*"(?:arguments|args|parameters)"\s*:\s*)?(?:\b(?:(?:seal_final_reply|final_answer|emit_answer)|print\(default_api\.(?:seal_final_reply|final_answer|emit_answer)|default_api\.(?:seal_final_reply|final_answer|emit_answer))\s*\(?\s*)?\{\s*"answer"\s*:\s*"|\b(?:seal_final_reply|final_answer|emit_answer)\s*\(\s*answer\s*=\s*"/;
  const m = re.exec(plain);
  if (m) {
    const q = m.index + m[0].length - 1;
    const dec = atDecodeJsonString(plain, q);
    const before = plain.slice(0, m.index).replace(/\s+$/, '');
    info.marker = m.index; info.decodedLen = dec.text.length; info.terminated = dec.end > 0;
    if (dec.end < 0 && before.trim().length > dec.text.trim().length) { info.how = 'cut-before-call'; return { answer: before, info }; }
    if (dec.text.trim().length >= Math.max(200, before.trim().length * 0.5)) { info.how = 'decoded-call'; return { answer: dec.text, info }; }
    if (before.trim().length) { info.how = 'cut-before-call'; return { answer: before, info }; }
  }
  // No call marker: an escaped copy with no real line breaks appended after a normal answer.
  if (info.literalNl >= 10) {
    const k = plain.indexOf('\\n');
    let st = plain.lastIndexOf('\n', k); st = st < 0 ? 0 : st + 1;
    const head = plain.slice(0, st).replace(/\s+$/, ''), tail = plain.slice(st);
    const tailNl = (tail.match(/\\n/g) || []).length;
    if (head.trim().length >= 1000 && tailNl >= 10 && tail.split('\n').length <= 3 + tailNl / 50) { info.how = 'cut-escaped-tail'; info.marker = st; return { answer: head, info }; }
  }
  return { answer: plain, info };
}
module.exports={atDecodeJsonString,atCleanPlainAnswer};
