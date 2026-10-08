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
  if (!response.ok || Number(payload.code || 0) >= 400) {
    throw new Error(`${method} ${path} -> ${response.status}: ${payload.msg || "failed"}`);
  }
  return payload.data;
}

async function requestRaw(baseUrl, path, { method = "GET", token = "", body } = {}) {
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

function seedMergedPushState(draft) {
  draft.users = [{ id: "u_merged", username: "merged-user", role: "user", status: "active" }];
  draft.devices = [
    {
      id: "dev_merged_1",
      mac: "AA:BB:CC:DD:77:01",
      type: "ink-screen",
      ownerId: "u_merged",
      bindState: "bound",
      status: "enabled",
      currentPlayMode: "",
      currentCollectionId: "",
      lastDisplayCollectionId: "",
      lastDisplayItemIndex: 7,
    },
    {
      id: "dev_merged_2",
      mac: "AA:BB:CC:DD:77:02",
      type: "ink-screen",
      ownerId: "u_merged",
      bindState: "bound",
      status: "enabled",
      currentPlayMode: "",
      currentCollectionId: "",
      lastDisplayCollectionId: "",
      lastDisplayItemIndex: 3,
    },
  ];
  draft.playCollections = [
    {
      id: "col_merge_a",
      ownerId: "u_merged",
      name: "集合A",
      targetDeviceType: "ink-screen",
      slideIntervalSec: 60,
      loopEnabled: true,
      offlineSyncEnabled: true,
      version: 1,
      status: "enabled",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
    },
    {
      id: "col_merge_b",
      ownerId: "u_merged",
      name: "集合B",
      targetDeviceType: "ink-screen",
      slideIntervalSec: 90,
      loopEnabled: true,
      offlineSyncEnabled: true,
      version: 1,
      status: "enabled",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
    },
    {
      id: "col_merge_empty",
      ownerId: "u_merged",
      name: "空集合",
      targetDeviceType: "ink-screen",
      slideIntervalSec: 90,
      loopEnabled: true,
      offlineSyncEnabled: true,
      version: 1,
      status: "enabled",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
    },
  ];
  draft.playCollectionItems = [
    { id: "item_a_1", collectionId: "col_merge_a", imageId: "img_merge_1", sortOrder: 1, enabled: true },
    { id: "item_a_2", collectionId: "col_merge_a", imageId: "img_merge_2", sortOrder: 2, enabled: true },
    { id: "item_b_1", collectionId: "col_merge_b", imageId: "img_merge_2", sortOrder: 1, enabled: true },
    { id: "item_b_2", collectionId: "col_merge_b", imageId: "img_merge_3", sortOrder: 2, enabled: true },
  ];
  draft.imageAssets = [
    { id: "img_merge_1", ownerId: "u_merged", originalName: "one.png", mime: "image/png", tfFileId: "tf_merge_1", status: "ready" },
    { id: "img_merge_2", ownerId: "u_merged", originalName: "two.png", mime: "image/png", tfFileId: "tf_merge_2", status: "ready" },
    { id: "img_merge_3", ownerId: "u_merged", originalName: "three.png", mime: "image/png", tfFileId: "tf_merge_3", status: "ready" },
  ];
  draft.tfFiles = [
    { id: "tf_merge_1", ownerId: "u_merged", originalName: "one.png", mime: "image/png", size: 11, sha256: "sha_1" },
    { id: "tf_merge_2", ownerId: "u_merged", originalName: "two.png", mime: "image/png", size: 22, sha256: "sha_2" },
    { id: "tf_merge_3", ownerId: "u_merged", originalName: "three.png", mime: "image/png", size: 33, sha256: "sha_3" },
  ];
  draft.e6RenderedAssets = [];
  draft.remoteCommandAcks = [];
}

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const userToken = signToken({ role: "user", userId: "u_merged", username: "merged-user" });

  try {
    await updateDB(seedMergedPushState);

    const result = await request(baseUrl, "/api/play-collections/merged-push", {
      method: "POST",
      token: userToken,
      body: {
        collectionIds: ["col_merge_a", "col_merge_empty", "col_merge_b"],
        deviceIds: ["dev_merged_1", "dev_merged_2"],
        slideIntervalSec: 120,
        loopEnabled: true,
        offlineSyncEnabled: true,
        dedupe: true,
        ackTimeoutMs: 0,
      },
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.mergedCollectionId, "mergedCollectionId should be returned");
    assert.deepStrictEqual(result.sourceCollectionIds, ["col_merge_a", "col_merge_empty", "col_merge_b"]);
    assert.strictEqual(result.itemCount, 3, "duplicate images should be deduped by default");
    assert.strictEqual(result.sentCount, 2, "one command should be sent per device");
    assert.strictEqual(result.devices.length, 2);
    assert.strictEqual(new Set(result.devices.map((item) => item.deviceId)).size, 2, "ACK/device rows should be unique by device");

    const db = await readDB();
    const merged = db.playCollections.find((item) => item.id === result.mergedCollectionId);
    assert.ok(merged, "hidden merged collection should be persisted");
    assert.strictEqual(merged.hidden, true);
    assert.strictEqual(merged.isSystemMerged, true);
    assert.strictEqual(merged.type, "merged");
    assert.deepStrictEqual(merged.sourceCollectionIds, ["col_merge_a", "col_merge_empty", "col_merge_b"]);
    assert.strictEqual(merged.slideIntervalSec, 120);

    const mergedItems = db.playCollectionItems
      .filter((item) => item.collectionId === result.mergedCollectionId)
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
    assert.deepStrictEqual(
      mergedItems.map((item) => item.imageId),
      ["img_merge_1", "img_merge_2", "img_merge_3"]
    );
    assert.deepStrictEqual(
      mergedItems.map((item) => item.sourceCollectionId),
      ["col_merge_a", "col_merge_a", "col_merge_b"]
    );

    db.devices
      .filter((item) => ["dev_merged_1", "dev_merged_2"].includes(item.id))
      .forEach((device) => {
        assert.strictEqual(device.currentPlayMode, "album");
        assert.strictEqual(device.currentCollectionId, result.mergedCollectionId);
        assert.strictEqual(device.lastDisplayCollectionId, result.mergedCollectionId);
        assert.strictEqual(device.lastDisplayItemIndex, 0);
      });

    const manifest = await request(
      baseUrl,
      `/api/hardware/collections/${encodeURIComponent(result.mergedCollectionId)}/manifest?deviceId=dev_merged_1`,
      { token: userToken }
    );
    assert.strictEqual(manifest.collectionId, result.mergedCollectionId);
    assert.deepStrictEqual(
      manifest.items.map((item) => item.imageId),
      ["img_merge_1", "img_merge_2", "img_merge_3"]
    );

    const listedCollections = await request(baseUrl, "/api/play-collections", { token: userToken });
    assert.ok(!listedCollections.some((item) => item.id === result.mergedCollectionId), "hidden merged collection should not appear in normal list");

    const keepDuplicates = await request(baseUrl, "/api/play-collections/merged-push", {
      method: "POST",
      token: userToken,
      body: {
        collectionIds: ["col_merge_a", "col_merge_b"],
        deviceIds: ["dev_merged_1"],
        dedupe: false,
        ackTimeoutMs: 0,
      },
    });
    assert.strictEqual(keepDuplicates.itemCount, 4, "dedupe:false should keep duplicate images");
    const dbAfterDefaultMerged = await readDB();
    const defaultIntervalMerged = dbAfterDefaultMerged.playCollections.find((item) => item.id === keepDuplicates.mergedCollectionId);
    assert.ok(defaultIntervalMerged, "default interval merged collection should be persisted");
    assert.strictEqual(defaultIntervalMerged.slideIntervalSec, 600, "merged-push omitted slideIntervalSec should default to 10 minutes");

    const emptyOnly = await requestRaw(baseUrl, "/api/play-collections/merged-push", {
      method: "POST",
      token: userToken,
      body: {
        collectionIds: ["col_merge_empty"],
        deviceIds: ["dev_merged_1"],
        ackTimeoutMs: 0,
      },
    });
    assert.strictEqual(emptyOnly.status, 400);
    assert.match(emptyOnly.payload.msg, /所选集合中没有可播放图片/);

    console.log("[ok] merged collection push creates one hidden playlist and one command per device");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeMongoClient();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
