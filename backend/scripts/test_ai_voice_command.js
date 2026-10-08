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
const { closeMongoClient } = require("../src/utils/mongo");

async function request(baseUrl, path, { method = "GET", token = "", body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok || Number(payload.code || 0) >= 400) {
    throw new Error(`${method} ${path} -> ${response.status}: ${payload.msg || "failed"}`);
  }
  return payload.data;
}

async function multipartRequest(baseUrl, path, { token = "", form }) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: form,
  });
  const payload = await response.json();
  if (!response.ok || Number(payload.code || 0) >= 400) {
    throw new Error(`POST ${path} -> ${response.status}: ${payload.msg || "failed"}`);
  }
  return payload.data;
}

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = signToken({ role: "user", userId: "u_voice", username: "voice-user" });

  try {
    await updateDB((draft) => {
      draft.users = [{ id: "u_voice", username: "voice-user", role: "user", status: "active" }];
      draft.devices = [
        {
          id: "dev_voice",
          mac: "AA:BB:CC:DD:99:01",
          ownerId: "u_voice",
          bindState: "bound",
          status: "enabled",
          displayName: "会议室屏幕",
          type: "ink-screen",
        },
      ];
      draft.aiMessages = [];
    });

    const result = await request(baseUrl, "/api/ai/voice", {
      method: "POST",
      token,
      body: {
        transcript: "刷新会议室屏幕",
        sessionId: "",
        thinkingEnabled: false,
      },
    });

    assert.strictEqual(result.transcript, "刷新会议室屏幕");
    assert.ok(result.chat, "voice endpoint should return chat command result");
    assert.strictEqual(result.chat.needConfirm, true);
    assert.ok(result.chat.confirmToken, "voice command should expose confirm token");
    assert.match(result.chat.reply, /刷新设备页面|需要你确认/);

    const form = new FormData();
    form.set("transcript", "刷新会议室屏幕");
    form.set("sessionId", result.chat.sessionId || "");
    form.set("thinkingEnabled", "false");
    form.append("file", new Blob([Buffer.from("fake voice bytes")], { type: "audio/mpeg" }), "voice.mp3");
    const multipartResult = await multipartRequest(baseUrl, "/api/ai/voice", { token, form });
    assert.strictEqual(multipartResult.transcript, "刷新会议室屏幕");
    assert.ok(multipartResult.chat, "multipart voice upload should return chat command result");
    assert.strictEqual(multipartResult.chat.needConfirm, true);
    assert.ok(multipartResult.chat.confirmToken, "multipart voice command should expose confirm token");

    const asrStatus = await request(baseUrl, "/api/ai/asr/status", { token });
    assert.strictEqual(typeof asrStatus.configured, "boolean");
    assert.ok(asrStatus.provider, "ASR status should expose provider");
    assert.ok(asrStatus.message, "ASR status should expose diagnostic message");

    console.log("[ok] AI voice endpoint turns JSON and multipart voice input into confirmable commands");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeMongoClient();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
