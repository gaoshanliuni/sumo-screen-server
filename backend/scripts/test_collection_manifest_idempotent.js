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
const { closeMongoClient } = require("../src/utils/mongo");

async function requestRaw(baseUrl, path, { method = "GET", token = "", body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_) {
    payload = { raw: text };
  }
  return { status: response.status, payload, text };
}

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const userToken = signToken({ role: "user", userId: "u_manifest", username: "manifest-user" });
  const deviceToken = signToken({ role: "device", deviceId: "dev_manifest", mac: "AA:BB:CC:DD:66:01" });

  try {
    await updateDB((draft) => {
      draft.users = [{ id: "u_manifest", username: "manifest-user", role: "user", status: "active" }];
      draft.devices = [
        {
          id: "dev_manifest",
          mac: "AA:BB:CC:DD:66:01",
          type: "e6-color-frame",
          ownerId: "u_manifest",
          bindState: "bound",
          status: "enabled",
          currentPlayMode: "",
          currentCollectionId: "",
          lastDisplayCollectionId: "",
        },
      ];
      draft.playCollections = [
        {
          id: "col_empty_manifest",
          ownerId: "u_manifest",
          name: "empty manifest",
          targetDeviceType: "e6-color-frame",
          slideIntervalSec: 120,
          version: 4,
          status: "enabled",
        },
        {
          id: "col_not_ready",
          ownerId: "u_manifest",
          name: "not ready",
          targetDeviceType: "e6-color-frame",
          slideIntervalSec: 120,
          version: 1,
          status: "enabled",
        },
      ];
      draft.playCollectionItems = [
        {
          id: "coli_not_ready",
          collectionId: "col_not_ready",
          imageId: "img_not_ready",
          sortOrder: 1,
          enabled: true,
          createdAt: "2026-06-07T00:00:00.000Z",
        },
      ];
      draft.imageAssets = [
        {
          id: "img_not_ready",
          ownerId: "u_manifest",
          status: "ready",
          mime: "image/png",
          originalName: "not-ready.png",
          tfFileId: "tf_original",
          originalTfFileId: "tf_original",
          e6ConvertStatus: "queued",
        },
      ];
      draft.e6RenderedAssets = [];
      draft.tfFiles = [
        {
          id: "tf_original",
          ownerId: "u_manifest",
          category: "photo",
          originalName: "not-ready.png",
          mime: "image/png",
          size: 100,
          url: "/api/tf/tf_original/download",
        },
      ];
      draft.remoteCommandAcks = [];
    });

    const manifest = await requestRaw(
      baseUrl,
      "/api/hardware/collections/col_empty_manifest/manifest?deviceId=dev_manifest",
      { token: deviceToken }
    );
    assert.strictEqual(manifest.status, 200, manifest.text);
    assert.strictEqual(manifest.payload.code, 200);
    assert.strictEqual(manifest.payload.data.collectionId, "col_empty_manifest");
    assert.strictEqual(manifest.payload.data.version, 4);
    assert.deepStrictEqual(manifest.payload.data.items, []);
    assert.strictEqual(manifest.payload.data.ok, true);

    const push = await requestRaw(baseUrl, "/api/play-collections/col_not_ready/push", {
      method: "POST",
      token: userToken,
      body: { deviceIds: ["dev_manifest"], ackTimeoutMs: 0 },
    });
    assert.strictEqual(push.status, 409, "push should reject before command is queued when manifest is not ready");
    assert.match(push.payload.msg, /manifest|E6|图片/);
    const dbAfterPush = await readDB();
    assert.strictEqual(dbAfterPush.remoteCommandAcks.length, 0, "failed manifest validation must not create pending commands");
    assert.strictEqual(dbAfterPush.devices[0].currentCollectionId || "", "", "failed push must not switch current collection");

    const report = await requestRaw(baseUrl, "/api/device/report", {
      method: "POST",
      token: deviceToken,
      body: { status: "displayed", collectionId: "col_empty_manifest", rssi: -54 },
    });
    assert.strictEqual(report.status, 200, report.text);
    assert.strictEqual(report.payload.code, 200);

    console.log("[ok] collection manifest is idempotent and push validates manifest before queueing commands");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeMongoClient();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
