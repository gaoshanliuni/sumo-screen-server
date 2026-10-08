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
const { readDB, updateDB } = require("../src/db/store");
const { signToken } = require("../src/utils/jwt");
const { getDeviceHistory } = require("../src/utils/realtime.hub");
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

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const userToken = signToken({ role: "user", userId: "u_push", username: "push-user" });

  try {
    await updateDB((draft) => {
      draft.users = Array.isArray(draft.users) ? draft.users : [];
      if (!draft.users.some((item) => item.id === "u_push")) {
        draft.users.push({ id: "u_push", username: "push-user", role: "user", status: "active" });
      }
      draft.devices = Array.isArray(draft.devices) ? draft.devices : [];
      draft.devices.push({
        id: "dev_push_persist",
        mac: "AA:BB:CC:DD:12:34",
        type: "e6-color-frame",
        ownerId: "u_push",
        bindState: "bound",
        status: "enabled",
        currentPlayMode: "",
        currentCollectionId: "",
        lastDisplayCollectionId: "",
        updatedAt: new Date().toISOString(),
      });
    });

    const collection = await request(baseUrl, "/api/play-collections", {
      method: "POST",
      token: userToken,
      body: {
        name: "push-persist-collection",
        slideIntervalSec: 180,
        targetDeviceType: "e6-color-frame",
      },
    });

    const result = await request(baseUrl, `/api/play-collections/${collection.id}/push`, {
      method: "POST",
      token: userToken,
      body: { deviceIds: ["dev_push_persist"] },
    });
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.events[0].type, "collection.push");
    assert.ok(result.events[0].payload.commandId, "push event should carry a command id for hardware ACK");
    assert.strictEqual(result.sentCount, 1);
    assert.strictEqual(result.ackedPendingCount, 1);

    const db = await readDB();
    const device = db.devices.find((item) => item.id === "dev_push_persist");
    assert.ok(device, "device should exist");
    assert.strictEqual(device.currentPlayMode, "album");
    assert.strictEqual(device.currentCollectionId, collection.id);
    assert.strictEqual(device.lastDisplayCollectionId, collection.id);
    assert.ok(device.currentCollectionPushedAt, "push timestamp should be recorded");
    const ack = db.remoteCommandAcks.find((item) => item.commandId === result.events[0].payload.commandId);
    assert.ok(ack, "collection push should create a persistent pending ACK row");
    assert.strictEqual(ack.eventType, "collection.push");
    assert.strictEqual(ack.deviceId, "dev_push_persist");
    assert.strictEqual(ack.meta.commandPayload.collectionId, collection.id);
    assert.strictEqual(ack.meta.commandPayload.manifestUrl, result.events[0].payload.manifestUrl);
    const history = getDeviceHistory("dev_push_persist");
    assert.ok(history.some((event) => event.payload?.commandId === ack.commandId), "push event should still be published to realtime history");

    console.log("[ok] collection push persists current device collection");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeMongoClient();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
