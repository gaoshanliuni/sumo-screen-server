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
  const mac = `AA:BB:CC:${String(Date.now()).slice(-2)}:E6:01`;
  const adminToken = signToken({ role: "admin", userId: "u_admin", username: "admin" });

  try {
    const first = await request(baseUrl, "/api/hardware/auto-register", {
      method: "POST",
      body: { mac, type: "e6-color-frame", remark: "auto-register test" },
    });
    const second = await request(baseUrl, "/api/hardware/auto-register", {
      method: "POST",
      body: { mac, type: "e6-color-frame", remark: "retry should keep pin" },
    });

    assert.strictEqual(first.mode, "pending_bind");
    assert.strictEqual(second.mode, "pending_bind");
    assert.strictEqual(second.device.id, first.device.id);
    assert.strictEqual(second.bind.pin, first.bind.pin);
    assert.ok(second.bootstrap.token);
    console.log("[ok] repeated pending auto-register reuses current PIN/bootstrap without replacing");

    let slowWriteStarted;
    const slowWriteReady = new Promise((resolve) => {
      slowWriteStarted = resolve;
    });
    const slowWrite = updateDB(async (draft) => {
      draft.meta = draft.meta || {};
      draft.meta.hardwareAutoRegisterSlowWriteTestAt = new Date().toISOString();
      slowWriteStarted();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
    await slowWriteReady;

    const fastMac = `AA:BB:CC:${String(Date.now()).slice(-2)}:E6:02`;
    const startedAt = Date.now();
    const fast = await request(baseUrl, "/api/hardware/auto-register", {
      method: "POST",
      body: { mac: fastMac, type: "e6-color-frame", remark: "must not wait for db queue" },
    });
    const elapsedMs = Date.now() - startedAt;
    assert.strictEqual(fast.mode, "pending_bind");
    assert.ok(fast.bind.pin);
    assert.ok(
      elapsedMs < 1000,
      `auto-register should return before slow write queue drains, elapsed=${elapsedMs}ms`
    );
    await slowWrite;
    console.log("[ok] first pending auto-register returns quickly even when persistent writes are queued");

    const bindMac = `AA:BB:CC:${String(Date.now()).slice(-2)}:E6:03`;
    const pending = await request(baseUrl, "/api/hardware/auto-register", {
      method: "POST",
      body: { mac: bindMac, type: "e6-color-frame", remark: "bind should not wait for db queue" },
    });
    let bindSlowWriteStarted;
    const bindSlowWriteReady = new Promise((resolve) => {
      bindSlowWriteStarted = resolve;
    });
    const bindSlowWrite = updateDB(async (draft) => {
      draft.meta = draft.meta || {};
      draft.meta.hardwareBindSlowWriteTestAt = new Date().toISOString();
      bindSlowWriteStarted();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
    await bindSlowWriteReady;

    const bindStartedAt = Date.now();
    const bound = await request(baseUrl, "/api/devices/bind-pin", {
      method: "POST",
      token: adminToken,
      body: { pin: pending.bind.pin, ownerId: "u_demo" },
    });
    const bindElapsedMs = Date.now() - bindStartedAt;
    assert.strictEqual(bound.bindState, "bound");
    assert.strictEqual(bound.ownerId, "u_demo");
    assert.ok(bindElapsedMs < 1000, `bind-pin should return before slow write queue drains, elapsed=${bindElapsedMs}ms`);
    await bindSlowWrite;
    console.log("[ok] PIN bind returns quickly even when persistent writes are queued");

    let statusSlowWriteStarted;
    const statusSlowWriteReady = new Promise((resolve) => {
      statusSlowWriteStarted = resolve;
    });
    const statusSlowWrite = updateDB(async (draft) => {
      draft.meta = draft.meta || {};
      draft.meta.hardwareBindStatusSlowWriteTestAt = new Date().toISOString();
      statusSlowWriteStarted();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
    await statusSlowWriteReady;

    const statusStartedAt = Date.now();
    const status = await request(
      baseUrl,
      `/api/hardware/bind/status?bootstrapToken=${encodeURIComponent(pending.bootstrap.token)}`
    );
    const statusElapsedMs = Date.now() - statusStartedAt;
    assert.strictEqual(status.bound, true);
    assert.ok(status.hardwareAuth && status.hardwareAuth.token);
    assert.ok(
      statusElapsedMs < 1000,
      `hardware bind/status should return before slow write queue drains, elapsed=${statusElapsedMs}ms`
    );
    await statusSlowWrite;
    console.log("[ok] hardware bind/status returns quickly after PIN binding");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
