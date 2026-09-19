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
const { updateDB } = require("../src/db/store");
const { signToken } = require("../src/utils/jwt");

async function request(baseUrl, path, { method = "GET", token = "", body } = {}) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || Number(payload.code || 0) >= 400) {
    throw new Error(`${method} ${path} -> ${response.status}: ${payload.msg || "failed"}`);
  }
  return payload.data;
}

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const adminToken = signToken({ role: "admin", userId: "u_admin", username: "admin" });

  try {
    let slowWriteStarted;
    const slowWriteReady = new Promise((resolve) => {
      slowWriteStarted = resolve;
    });
    const slowWrite = updateDB(async (draft) => {
      draft.meta = draft.meta || {};
      draft.meta.aiLatencySlowWriteTestAt = new Date().toISOString();
      slowWriteStarted();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
    await slowWriteReady;

    const startedAt = Date.now();
    const result = await request(baseUrl, "/api/ai/chat", {
      method: "POST",
      token: adminToken,
      body: {
        message: "有哪些设备？",
        pageContext: { source: "test", page: "ai" },
      },
    });
    const elapsedMs = Date.now() - startedAt;
    assert.strictEqual(result.needConfirm, false);
    assert.ok(result.reply);
    assert.ok(elapsedMs < 1000, `local AI tool chat should not wait for DB write queue, elapsed=${elapsedMs}ms`);
    await slowWrite;
    console.log("[ok] AI local tool chat is not blocked by slow DB writes");

    let slowConfigWriteStarted;
    const slowConfigWriteReady = new Promise((resolve) => {
      slowConfigWriteStarted = resolve;
    });
    const slowConfigWrite = updateDB(async (draft) => {
      draft.meta = draft.meta || {};
      draft.meta.aiConfigLatencySlowWriteTestAt = new Date().toISOString();
      slowConfigWriteStarted();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
    await slowConfigWriteReady;

    const configStartedAt = Date.now();
    const configResult = await request(baseUrl, "/api/ai/config/me", {
      method: "PUT",
      token: adminToken,
      body: {
        name: "快速保存 DeepSeek",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.test",
        model: "deepseek-chat",
        enabled: true,
        thinkingEnabled: true,
      },
    });
    const configElapsedMs = Date.now() - configStartedAt;
    assert.strictEqual(configResult.config.name, "快速保存 DeepSeek");
    assert.strictEqual(configResult.config.thinkingEnabled, true);
    assert.ok(
      configElapsedMs < 1000,
      `AI config save should update memory optimistically and not wait for DB write queue, elapsed=${configElapsedMs}ms`
    );
    await slowConfigWrite;
    console.log("[ok] AI config save is not blocked by slow DB writes");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
