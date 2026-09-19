/* eslint-disable no-console */
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "1";
process.env.DB_CONNECT_TIMEOUT_MS = process.env.DB_CONNECT_TIMEOUT_MS || "200";
process.env.DB_OP_TIMEOUT_MS = process.env.DB_OP_TIMEOUT_MS || "1000";
process.env.DB_INIT_RETRY_MAX = process.env.DB_INIT_RETRY_MAX || "1";
process.env.DB_RETRY_COOLDOWN_MS = process.env.DB_RETRY_COOLDOWN_MS || "60000";

const assert = require("assert");
const http = require("http");
const Jimp = require("jimp");
const app = require("../src/app");
const { signToken } = require("../src/utils/jwt");
const { publishDeviceEvent } = require("../src/utils/realtime.hub");
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
  const adminToken = signToken({ role: "admin", userId: "u_admin", username: "admin" });
  const userToken = signToken({ role: "user", userId: "u_demo", username: "demo" });
  const deviceToken = signToken({ role: "device", deviceId: "dev_smoke", mac: "AA:BB:CC:DD:EE:FF" });

  try {
    const deviceTypes = await request(baseUrl, "/api/device-types", { token: adminToken });
    assert.ok(deviceTypes.some((item) => item.type === "e6-color-frame"));

    const source = await request(baseUrl, "/api/album-sources", {
      method: "POST",
      token: userToken,
      body: {
        providerType: "openlist",
        name: "route-smoke-openlist",
        baseUrl: "https://openlist.example.com",
        rootPath: "/Photos",
        username: "demo",
        password: "route-secret",
      },
    });
    assert.strictEqual(source.password, undefined);
    assert.strictEqual(source.hasPassword, true);

    const runs = await Promise.all(
      Array.from({ length: 100 }, () => request(baseUrl, "/api/album-sources", { token: userToken }))
    );
    assert.strictEqual(runs.length, 100);
    assert.ok(runs.every((rows) => Array.isArray(rows)));

    const uploadCollection = await request(baseUrl, "/api/play-collections", {
      method: "POST",
      token: userToken,
      body: {
        name: `route-smoke-upload-${Date.now()}`,
        slideIntervalSec: 180,
        targetDeviceType: "e6-color-frame",
      },
    });
    const form = new FormData();
    form.set("targetCollectionId", uploadCollection.id);
    form.set("autoConvert", "true");
    const smokeImage = await new Jimp(4, 4, 0xff3366ff);
    const png1x1 = await smokeImage.getBufferAsync(Jimp.MIME_PNG);
    form.append("files", new Blob([png1x1], { type: "image/png" }), "route-smoke.png");
    const upload = await multipartRequest(baseUrl, "/api/album-imports/uploads", { token: userToken, form });
    assert.strictEqual(upload.collectionId, uploadCollection.id);
    assert.strictEqual(upload.files.length, 1);
    assert.ok(upload.files[0].imageId);

    const collectionWithItems = await request(baseUrl, `/api/play-collections/${uploadCollection.id}`, { token: userToken });
    assert.ok(collectionWithItems.items.some((item) => item.imageId === upload.files[0].imageId));
    await new Promise((resolve) => setTimeout(resolve, 1500));

    publishDeviceEvent({
      type: "collection.push",
      deviceId: "dev_smoke",
      payload: {
        deviceType: "e6-color-frame",
        collectionId: "col_smoke",
        manifestUrl: "http://127.0.0.1/manifest.json",
        version: 1,
      },
    });
    const polled = await request(baseUrl, "/api/hardware/events/poll?limit=1", { token: deviceToken });
    assert.strictEqual(polled.command.type, "collection.push");
    assert.strictEqual(polled.command.payload.manifestUrl, "http://127.0.0.1/manifest.json");
    console.log("[ok] album route smoke supports 100 concurrent authenticated reads");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeMongoClient();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
