"use strict";
// Anti-truncation module: inject emit_answer tool (UPPERCASE schema) and
// extract full answer from functionCall args. Isolated on purpose.
const AT_PREFIX = "anti-truncation/";
const AT_TOOL_NAME = "emit_answer";
const AT_MAX_ATTEMPTS = 3;
// After this much time since the request arrived, an unfinished round fails instead of continuing.
const AT_CONTINUE_DEADLINE_MS = 960000;
const AT_SYSTEM_HINT =
  "\n\n[SYSTEM CONSTRAINT] You have a tool named emit_answer. " +
  "When you are ready to output your final complete answer, you MUST call " +
  "emit_answer with the full answer text as the value of the key \"answer\". " +
  "Do not output the answer as plain text. Do not stop early. " +
  "If the answer is long, call emit_answer once with the complete content.";

function atIsEnabled(modelName) {
  return typeof modelName === "string" && modelName.startsWith(AT_PREFIX);
}
function atRealModel(modelName) {
  return atIsEnabled(modelName) ? modelName.slice(AT_PREFIX.length) : modelName;
}
function atInjectTools(googleBody) {
  if (!googleBody || !Array.isArray(googleBody.contents)) return googleBody;
  const alreadyInjected = (googleBody.tools || []).some((t) =>
    (t.functionDeclarations || []).some((d) => d.name === AT_TOOL_NAME),
  );
  if (alreadyInjected) return googleBody;
  const decl = {
    name: AT_TOOL_NAME,
    description: "Emit your final complete answer.",
    parameters: {
      type: "OBJECT",
      properties: { answer: { type: "STRING" } },
      required: ["answer"],
    },
  };
  googleBody.tools = [...(googleBody.tools || []), { functionDeclarations: [decl] }];
  const sys = googleBody.systemInstruction;
  let sysText = "";
  if (sys && sys.parts && sys.parts.length > 0) {
    sysText = sys.parts.map((p) => p.text || "").join("\n");
  }
  googleBody.systemInstruction = {
    role: "system",
    parts: [{ text: sysText + AT_SYSTEM_HINT }],
  };
  return googleBody;
}
function atExtractAnswer(googleResponse) {
  // Returns { found: true, answer, finishReason } or { found: false }.
  const candidate = googleResponse && googleResponse.candidates && googleResponse.candidates[0];
  if (!candidate || !candidate.content || !Array.isArray(candidate.content.parts)) {
    return { found: false };
  }
  let answer = null;
  let finishReason = candidate.finishReason || null;
  for (const part of candidate.content.parts) {
    const fc = part.functionCall;
    if (fc && fc.name === AT_TOOL_NAME && fc.args && typeof fc.args.answer === "string") {
      answer = fc.args.answer;
      finishReason = candidate.finishReason || "STOP";
    }
  }
  if (answer !== null) return { found: true, answer, finishReason };
  return { found: false, finishReason };
}
function atBuildContinuationBody(googleBody, googleResponse, prevAnswer) {
  // Append the model function-call + a user "continue" request to contents.
  const candidate = googleResponse.candidates && googleResponse.candidates[0];
  const newContents = Array.isArray(googleBody.contents) ? [...googleBody.contents] : [];
  if (candidate && candidate.content) {
    newContents.push({ role: "model", parts: candidate.content.parts });
  }
  const contText =
    "Your previous emit_answer call was incomplete or missing. " +
    (prevAnswer ? "Previous partial answer: " + prevAnswer + "\n\n" : "") +
    "Call emit_answer again with the COMPLETE final answer (key \"answer\").";
  newContents.push({ role: "user", parts: [{ text: contText }] });
  const body = Object.assign({}, googleBody, { contents: newContents });
  return body;
}
// Upstream content-safety refusals. Retrying the same request may succeed
// (these are sometimes false positives), but continuing the conversation never helps.
const AT_BLOCK_REASONS = /^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY|OTHER_SAFETY)$/;
function atBlockInfo(googleResponse) {
  if (!googleResponse || typeof googleResponse !== 'object') return null;
  const candidate = Array.isArray(googleResponse.candidates) ? googleResponse.candidates[0] : null;
  const finish = candidate && typeof candidate.finishReason === 'string' ? candidate.finishReason : null;
  const promptBlock = googleResponse.promptFeedback && typeof googleResponse.promptFeedback.blockReason === 'string'
    ? googleResponse.promptFeedback.blockReason : null;
  let reason = null, stage = null;
  if (promptBlock && /^[A-Z_]{1,40}$/.test(promptBlock) && promptBlock !== 'BLOCK_REASON_UNSPECIFIED') { reason = promptBlock; stage = 'prompt'; }
  else if (finish && AT_BLOCK_REASONS.test(finish)) { reason = finish; stage = 'response'; }
  if (!reason) return null;
  const u = googleResponse.usageMetadata;
  const promptTokens = u && Number.isSafeInteger(u.promptTokenCount) && u.promptTokenCount >= 0 ? u.promptTokenCount : null;
  return { reason, stage, promptTokens };
}
function atBlockMessage(info) {
  return '上游内容安全拦截（' + info.reason + '）：模型拒绝生成，本次没有输出。' +
    '这类拦截有时是误判，可以直接重试；多次被拦请调整内容。';
}
// Upstream ended the generation early (finish=OTHER etc.) without emit_answer. Nothing is returned
// to the client; the error carries the finish reason and token counts so the request record shows why.
function atFinishPayload(info, httpStatus) {
  const payload = info.timeLimit
    ? { error: { code: httpStatus, type: 'upstream_incomplete', status: 'AT_TIME_LIMIT',
      message: '已用时约 ' + Math.round(info.elapsedMs / 60000) + ' 分钟仍未得到完整答案（finish=' + info.reason + '），超过 6 分钟不再续写，直接返回失败。已生成约 ' + info.chars + ' 字被丢弃，可重试。' } }
    : { error: { code: httpStatus, type: 'upstream_incomplete', status: 'FINISH_' + info.reason,
    message: '上游中途结束（finish=' + info.reason + '），未返回内容。已生成约 ' + info.chars + ' 字被丢弃，可重试。' } };
  if (info.promptTokens !== null || info.outputTokens !== null) payload.usage = { prompt_tokens: info.promptTokens, completion_tokens: info.outputTokens };
  return payload;
}
function atBlockPayload(info, httpStatus) {
  const payload = { error: { code: httpStatus, type: 'content_blocked', status: info.reason, message: atBlockMessage(info), block_stage: info.stage } };
  if (info.promptTokens !== null) payload.usage = { prompt_tokens: info.promptTokens };
  return payload;
}
module.exports = {
  AT_PREFIX, AT_TOOL_NAME, AT_MAX_ATTEMPTS, AT_CONTINUE_DEADLINE_MS,
  atIsEnabled, atRealModel, atInjectTools, atExtractAnswer, atBuildContinuationBody,
  atBlockInfo, atBlockMessage, atBlockPayload, atFinishPayload,
};
