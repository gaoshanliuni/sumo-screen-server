/* eslint-disable no-console */
const assert = require("assert");
const http = require("http");

process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "1";
process.env.DB_CONNECT_TIMEOUT_MS = process.env.DB_CONNECT_TIMEOUT_MS || "200";
process.env.DB_OP_TIMEOUT_MS = process.env.DB_OP_TIMEOUT_MS || "1000";
process.env.DB_INIT_RETRY_MAX = process.env.DB_INIT_RETRY_MAX || "1";
process.env.DB_RETRY_COOLDOWN_MS = process.env.DB_RETRY_COOLDOWN_MS || "60000";
process.env.DEEPSEEK_API_KEY = "";

const app = require("../src/app");
const { signToken } = require("../src/utils/jwt");
const { closeMongoClient } = require("../src/utils/mongo");
const { createAiGateway } = require("../src/services/ai/ai_gateway.service");

function parseSse(text) {
  return text
    .split(/\n\n+/)
    .map((chunk) => {
      const eventLine = chunk.split(/\n/).find((line) => line.startsWith("event:"));
      const dataLine = chunk.split(/\n/).find((line) => line.startsWith("data:"));
      if (!eventLine || !dataLine) return null;
      return {
        event: eventLine.slice("event:".length).trim(),
        data: JSON.parse(dataLine.slice("data:".length).trim()),
      };
    })
    .filter(Boolean);
}

async function runGatewayContract() {
  const state = { aiMessages: [] };
  const gateway = createAiGateway({
    readState: async () => state,
    updateState: async (mutator) => mutator(state),
    deepSeekStream: async function* () {
      yield { type: "thinking_delta", content: "先判断需求" };
      yield { type: "text_delta", content: "这是正文" };
    },
    isDeepSeekConfigured: () => true,
  });

  assert.strictEqual(typeof gateway.chatStream, "function");
  const events = [];
  for await (const event of gateway.chatStream({
    actor: { role: "admin", userId: "u_admin" },
    message: "请回答",
    thinkingEnabled: false,
  })) {
    events.push(event);
  }
  assert.ok(events.some((item) => item.type === "thinking_delta" && item.content === "先判断需求"));
  assert.ok(events.some((item) => item.type === "text_delta" && item.content === "这是正文"));
  assert.ok(events.some((item) => item.type === "done"));
  assert.ok(state.aiMessages.some((item) => item.role === "assistant" && item.content === "这是正文"));
}

async function runRouteContract() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = signToken({ role: "admin", userId: "u_admin", username: "admin" });
  try {
    const response = await fetch(`${baseUrl}/api/ai/chat/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ message: "你好", thinkingEnabled: false }),
    });
    assert.strictEqual(response.status, 200);
    assert.ok(String(response.headers.get("content-type") || "").includes("text/event-stream"));
    const body = await response.text();
    const events = parseSse(body);
    assert.ok(events.some((item) => item.event === "session"));
    assert.ok(events.some((item) => item.event === "text_delta"));
    assert.ok(events.some((item) => item.event === "done"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeMongoClient();
  }
}

async function main() {
  await runGatewayContract();
  await runRouteContract();
  console.log("[ok] ai stream SSE contract passed");
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
