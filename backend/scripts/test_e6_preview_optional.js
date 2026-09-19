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
  return { status: response.status, payload };
}

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const userToken = signToken({ role: "user", userId: "u_preview", username: "preview-user" });

  try {
    await updateDB((draft) => {
      draft.users = [{ id: "u_preview", username: "preview-user", role: "user", status: "active" }];
      draft.devices = [
        {
          id: "dev_preview",
          mac: "AA:BB:CC:DD:88:01",
          type: "e6-color-frame",
          ownerId: "u_preview",
          bindState: "bound",
          status: "enabled",
          currentPlayMode: "",
          currentCollectionId: "",
          lastDisplayCollectionId: "",
          lastDisplayItemIndex: 9,
        },
      ];
      draft.playCollections = [
        {
          id: "col_preview",
          ownerId: "u_preview",
          name: "preview optional",
          targetDeviceType: "e6-color-frame",
          slideIntervalSec: 120,
          version: 2,
          status: "enabled",
        },
      ];
      draft.playCollectionItems = [
        { id: "coli_preview", collectionId: "col_preview", imageId: "img_preview", sortOrder: 1, enabled: true }
      ];
      draft.imageAssets = [
        {
          id: "img_preview",
          ownerId: "u_preview",
          originalName: "preview-optional.png",
          mime: "image/png",
          status: "ready",
          tfFileId: "tf_original_preview",
          originalTfFileId: "tf_original_preview",
          e6AssetId: "e6_preview_current",
          e6DitherMode: "waveshare_floyd",
          e6ImageTransform: { rotateDeg: 0, crop: { x: 0, y: 0, width: 1, height: 1 } },
          e6TransformKey: "r0_x0_y0_w1_h1",
          e6ConvertStatus: "ready",
        },
      ];
      draft.e6RenderedAssets = [
        {
          id: "e6_preview_current",
          imageId: "img_preview",
          deviceType: "e6-color-frame",
          width: 800,
          height: 480,
          colorMode: "e6_6color",
          previewGridId: "",
          previewTfFileId: "",
          binaryGridId: "grid_e6_preview",
          binaryTfFileId: "tf_e6_binary_preview",
          binarySha256: "sha_e6_preview",
          binarySize: 1024,
          ditherMode: "waveshare_floyd",
          converterVersion: "e6-waveshare-v1",
          converterEngine: "waveshare",
          imageTransform: { rotateDeg: 0, crop: { x: 0, y: 0, width: 1, height: 1 } },
          transformKey: "r0_x0_y0_w1_h1",
          convertStatus: "ready",
        },
      ];
      draft.tfFiles = [
        {
          id: "tf_original_preview",
          ownerId: "u_preview",
          category: "photo",
          originalName: "preview-optional.png",
          mime: "image/png",
          size: 12,
          url: "/api/tf/tf_original_preview/download",
        },
        {
          id: "tf_e6_binary_preview",
          ownerId: "u_preview",
          category: "photo",
          originalName: "preview-optional.e6p4",
          mime: "application/octet-stream",
          size: 1024,
          url: "/api/tf/tf_e6_binary_preview/download",
          gridId: "grid_e6_preview",
          sha256: "sha_e6_preview",
        },
      ];
      draft.remoteCommandAcks = [];
    });

    const manifest = await request(baseUrl, "/api/play-collections/col_preview/manifest?deviceId=dev_preview", {
      token: userToken,
    });
    assert.strictEqual(manifest.status, 200, manifest.payload.msg);
    assert.strictEqual(manifest.payload.code, 200);
    assert.strictEqual(manifest.payload.data.items.length, 1);
    assert.strictEqual(manifest.payload.data.items[0].imageId, "img_preview");

    const push = await request(baseUrl, "/api/play-collections/col_preview/push", {
      method: "POST",
      token: userToken,
      body: { deviceIds: ["dev_preview"], ackTimeoutMs: 0 },
    });
    assert.strictEqual(push.status, 200, push.payload.msg);
    assert.strictEqual(push.payload.code, 200);
    assert.strictEqual(push.payload.data.count, 1);

    const db = await readDB();
    const device = db.devices.find((item) => item.id === "dev_preview");
    assert.ok(device, "device should exist");
    assert.strictEqual(device.currentCollectionId, "col_preview");
    assert.strictEqual(device.lastDisplayCollectionId, "col_preview");

    console.log("[ok] old E6 binary assets remain playable without previewTfFileId");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeMongoClient();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
