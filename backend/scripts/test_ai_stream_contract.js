/* eslint-disable no-console */
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "1";
process.env.DB_CONNECT_TIMEOUT_MS = process.env.DB_CONNECT_TIMEOUT_MS || "200";
process.env.DB_OP_TIMEOUT_MS = process.env.DB_OP_TIMEOUT_MS || "1000";
process.env.DB_INIT_RETRY_MAX = process.env.DB_INIT_RETRY_MAX || "1";
process.env.DB_RETRY_COOLDOWN_MS = process.env.DB_RETRY_COOLDOWN_MS || "60000";

const assert = require("assert");
const http = require("http");
const app = require("../src/app");
const { signToken } = require("../src/utils/jwt");
const { splitThinkingFromContent } = require("../src/services/ai/deepseek_client.service");

async function readSse(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event:\s*(.+)$/m)?.[1] || "";
      const data = block.match(/^data:\s*(.+)$/m)?.[1] || "{}";
      return { event, data: JSON.parse(data) };
    });
}

async function main() {
  const split = splitThinkingFromContent("<think>先查看设备</think>正文回复");
  assert.strictEqual(split.thinking, "先查看设备");
  assert.strictEqual(split.content, "正文回复");

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = signToken({ role: "admin", userId: "u_stream", username: "stream-admin" });
  try {
    const response = await fetch(`${baseUrl}/api/ai/chat/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        message: "有哪些设备？",
        thinkingEnabled: true,
      }),
    });
    assert.strictEqual(response.status, 200);
    assert.ok(String(response.headers.get("content-type") || "").includes("text/event-stream"));
    const events = await readSse(response);
    assert.ok(events.some((item) => item.event === "typing" && item.data.typing === true), "typing event should be emitted first");
    assert.ok(events.some((item) => item.event === "delta" && item.data.text), "delta text should be streamed");
    assert.ok(events.some((item) => item.event === "done" && item.data.sessionId), "done event should include session id");
    console.log("[ok] AI stream contract emits typing/delta/done and splits thinking");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
