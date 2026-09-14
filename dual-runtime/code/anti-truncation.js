"use strict";
// Anti-truncation module: inject emit_answer tool (UPPERCASE schema) and
// extract full answer from functionCall args. Isolated on purpose.
const AT_PREFIX = "anti-truncation/";
const AT_TOOL_NAME = "emit_answer";
const AT_MAX_ATTEMPTS = 3;
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
module.exports = {
  AT_PREFIX, AT_TOOL_NAME, AT_MAX_ATTEMPTS,
  atIsEnabled, atRealModel, atInjectTools, atExtractAnswer, atBuildContinuationBody,
};
