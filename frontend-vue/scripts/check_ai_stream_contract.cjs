const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const service = fs.readFileSync(path.join(root, "src", "services", "aiChat.ts"), "utf8");
const panel = fs.readFileSync(path.join(root, "src", "components", "AiChatPanel.vue"), "utf8");

const forbiddenService = [
  "onThinking",
  "thinkingDelta",
  "reasoningDelta",
  "reasoning_content",
  "reasoning_delta",
  "state.thinking",
  "resultPatch.thinking",
];

const forbiddenPanel = [
  "ai-thinking-box",
  ">Thinking<",
  "独立思考",
  "onThinking",
  "assistantMessage.text += delta",
];

const checks = [
  [
    "stream parser strips reasoning/thinking fields before rendering",
    forbiddenService.every((needle) => !service.includes(needle)) && forbiddenPanel.every((needle) => !panel.includes(needle)),
  ],
  ["stream parser logs raw chunks", service.includes("[ai-stream] raw chunk")],
  ["stream parser logs parsed event type and update mode", service.includes("[ai-stream] event") && service.includes("updateMode")],
  ["stream parser distinguishes append delta from replace full text", service.includes('event.updateMode === "append"') && service.includes('event.updateMode === "replace"')],
  ["delta mode appends only delta", service.includes("state.text += event.textDelta")],
  ["fullText mode replaces text", service.includes("state.text = event.fullText")],
  ["final streamed result does not append a duplicate full answer", panel.includes("if (!result.streamed)") && !panel.includes("if (!assistantMessage.text && result.reply) assistantMessage.text = result.reply")],
  ["assistant messages are updated by stable id", panel.includes("currentAssistantMessageId") && panel.includes("updateMessageById")],
  ["Vue message updates use functional-style replacement", panel.includes("messages.value = messages.value.map")],
  ["new send cleans previous streaming state", panel.includes("resetStreamingMessages")],
  ["old captured assistant ref is gone", !/currentAssistantMessage\s*=\s*ref/.test(panel) && !/currentAssistantMessage\.value/.test(panel)],
];

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  throw new Error(`AI stream contract failed:\n- ${failed.join("\n- ")}`);
}

console.log("[ok] AI stream contract satisfied");
