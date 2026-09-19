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
const { sanitizeDeviceEventForRealtime } = require("../src/services/hardware_command_bridge.service");
const { createNvsService } = require("../src/services/nvs/nvs.service");
const { signToken } = require("../src/utils/jwt");
const { getDeviceHistory, publishDeviceEvent } = require("../src/utils/realtime.hub");

async function request(baseUrl, path, { token = "" } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const payload = await response.json();
  if (!response.ok || Number(payload.code || 0) >= 400) {
    throw new Error(`GET ${path} -> ${response.status}: ${payload.msg || "failed"}`);
  }
  return payload.data;
}

async function poll(baseUrl, deviceId, after = "") {
  const token = signToken({ role: "device", deviceId, mac: "AA:BB:CC:66:00:01" });
  const suffix = after ? `&after=${encodeURIComponent(after)}` : "";
  return request(baseUrl, `/api/hardware/events/poll?limit=1${suffix}`, { token });
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[failed] ${name}: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}

function makeNvsState(deviceId) {
  const now = "2026-06-06T00:00:00.000Z";
  return {
    users: [{ id: "u_bridge", username: "bridge", role: "user", status: "enabled" }],
    devices: [
      {
        id: deviceId,
        ownerId: "u_bridge",
        displayName: "桥接测试 E6",
        type: "e6-color-frame",
        bindState: "bound",
        status: "enabled",
        createdAt: now,
        updatedAt: now,
      },
    ],
    nvsShadows: [],
    nvsBackups: [],
    remoteCommandAcks: [],
  };
}

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run("E6 homepage image event is bridged to push_images command", async () => {
      const deviceId = "dev_bridge_homepage";
      publishDeviceEvent({
        type: "homepage.image.updated",
        deviceId,
        payload: {
          imageId: "tf_home_e6",
          imageUrl: "/api/hardware/tf/download/tf_home_e6",
          format: "e6p4",
          width: 800,
          height: 480,
          etag: "etag-home",
        },
      });

      const data = await poll(baseUrl, deviceId);
      assert.strictEqual(data.command.type, "push_images");
      assert.strictEqual(data.command.payload.image.image_id, "tf_home_e6");
      assert.strictEqual(data.command.payload.image.url, "/api/hardware/tf/download/tf_home_e6");
      assert.strictEqual(data.command.payload.image.size, 192000);
      assert.strictEqual(data.command.payload.sourceEventType, "homepage.image.updated");
    });

    await run("display.set keeps pending ack command id for firmware ACK", async () => {
      const deviceId = "dev_bridge_display";
      publishDeviceEvent({
        type: "display.set",
        deviceId,
        payload: {
          commandId: "cmd_display_bridge",
          mode: "home",
          displayMode: "homepage",
          setAsBootDefault: true,
        },
      });

      const data = await poll(baseUrl, deviceId);
      assert.strictEqual(data.command.type, "display.set");
      assert.strictEqual(data.command.command_id, "cmd_display_bridge");
      assert.strictEqual(data.command.payload.displayMode, "homepage");
      assert.strictEqual(data.command.payload.setAsBootDefault, true);

      const next = await poll(baseUrl, deviceId, data.command.command_id);
      assert.strictEqual(next.command, null);
      assert.deepStrictEqual(next.commands, []);

      publishDeviceEvent({
        type: "remote.ack",
        deviceId,
        payload: {
          commandId: "cmd_display_bridge",
          status: "success",
        },
      });
      const afterAck = await poll(baseUrl, deviceId, data.command.command_id);
      assert.strictEqual(afterAck.command, null);
      assert.deepStrictEqual(afterAck.commands, []);
    });

    await run("display.set_boot_mode is exposed as a hardware command", async () => {
      const deviceId = "dev_bridge_boot_mode";
      publishDeviceEvent({
        type: "display.set_boot_mode",
        deviceId,
        payload: {
          commandId: "cmd_boot_mode_bridge",
          bootMode: "album",
        },
      });

      const data = await poll(baseUrl, deviceId);
      assert.strictEqual(data.command.type, "display.set_boot_mode");
      assert.strictEqual(data.command.command_id, "cmd_boot_mode_bridge");
      assert.strictEqual(data.command.payload.bootMode, "album");
    });

    await run("pending collection push ACK rows are available through hardware poll", async () => {
      const deviceId = "dev_bridge_collection_pending";
      await updateDB((draft) => {
        draft.devices = Array.isArray(draft.devices) ? draft.devices : [];
        draft.remoteCommandAcks = Array.isArray(draft.remoteCommandAcks) ? draft.remoteCommandAcks : [];
        draft.devices.push({
          id: deviceId,
          mac: "AA:BB:CC:66:00:02",
          ownerId: "u_bridge",
          type: "e6-color-frame",
          bindState: "bound",
          status: "enabled",
        });
        draft.remoteCommandAcks.unshift({
          id: "cmd_collection_pending",
          commandId: "cmd_collection_pending",
          deviceId,
          eventType: "collection.push",
          source: "play_collection.push",
          status: "pending",
          ackStatus: "",
          ackMessage: "",
          ackPayload: {},
          meta: {
            commandPayload: {
              commandId: "cmd_collection_pending",
              deviceType: "e6-color-frame",
              collectionId: "col_pending",
              manifestUrl: "/api/hardware/collections/col_pending/manifest?deviceId=dev_bridge_collection_pending",
              version: 3,
            },
          },
          createdAt: "2026-06-06T00:00:00.000Z",
          updatedAt: "2026-06-06T00:00:00.000Z",
          ackedAt: "",
        });
      });

      const data = await poll(baseUrl, deviceId);
      assert.strictEqual(data.poll_interval_seconds, 5);
      assert.strictEqual(data.command.type, "collection.push");
      assert.strictEqual(data.command.command_id, "cmd_collection_pending");
      assert.strictEqual(data.command.payload.collectionId, "col_pending");
      assert.strictEqual(data.command.payload.manifestUrl, "/api/hardware/collections/col_pending/manifest?deviceId=dev_bridge_collection_pending");

      const next = await poll(baseUrl, deviceId, data.command.command_id);
      assert.strictEqual(next.command, null);
      assert.deepStrictEqual(next.commands, []);
    });

    await run("NVS writes are bridged to update_config with secret values for the device only", async () => {
      const deviceId = "dev_bridge_nvs";
      const state = makeNvsState(deviceId);
      const service = createNvsService({
        now: () => "2026-06-06T00:00:00.000Z",
        idFactory: (prefix) => `${prefix}_bridge`,
      });
      await service.importDeviceConfig(
        state,
        { role: "user", userId: "u_bridge", username: "bridge" },
        deviceId,
        {
          items: [
            { key: "wifi_ssid", value: "Xiaomi 13 Ultra" },
            { key: "wifi_password", value: "secret-pass" },
            { key: "server_url", value: "http://192.168.1.8:8890" },
          ],
          reboot: true,
        }
      );

      const history = getDeviceHistory(deviceId);
      assert.strictEqual(JSON.stringify(history).includes("secret-pass"), false);
      assert.strictEqual(JSON.stringify(history).includes("encryptedValue"), true);

      const realtimeEvent = sanitizeDeviceEventForRealtime(history.find((event) => event.type === "nvs.write"));
      const realtimeText = JSON.stringify(realtimeEvent);
      assert.strictEqual(realtimeText.includes("secret-pass"), false);
      assert.strictEqual(realtimeText.includes("encryptedValue"), false);
      assert.ok(realtimeText.includes("********"));

      const data = await poll(baseUrl, deviceId);
      assert.strictEqual(data.command.type, "update_config");
      assert.strictEqual(data.command.payload.wifi_ssid, "Xiaomi 13 Ultra");
      assert.strictEqual(data.command.payload.wifi_password, "secret-pass");
      assert.strictEqual(data.command.payload.server_url, "http://192.168.1.8:8890");
      assert.strictEqual(data.command.payload.sourceEventType, "nvs.write");
      assert.strictEqual(JSON.stringify(state).includes("secret-pass"), false);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  if (process.exitCode) {
    throw new Error("hardware E6 command bridge test failed");
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
