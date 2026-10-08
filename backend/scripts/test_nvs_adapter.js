const assert = require("assert");

const { createNvsService } = require("../src/services/nvs/nvs.service");
const { getDeviceHistory } = require("../src/utils/realtime.hub");

const auth = { role: "user", userId: "u_user", username: "demo" };

function makeState() {
  const now = new Date().toISOString();
  return {
    users: [{ id: "u_user", username: "demo", role: "user", status: "enabled" }],
    devices: [
      {
        id: "dev_e6",
        ownerId: "u_user",
        displayName: "客厅 E6 相框",
        type: "e6-color-frame",
        bindState: "bound",
        status: "enabled",
        online: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    nvsShadows: [],
    nvsBackups: [],
    remoteCommandAcks: [],
  };
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

async function main() {
  await run("E6 schema exposes editable Wi-Fi server and display keys", async () => {
    const service = createNvsService({ now: () => "2026-06-06T00:00:00.000Z" });
    const schema = service.getSchema(makeState(), auth, "dev_e6");
    const keys = schema.items.map((item) => item.key);
    assert.ok(keys.includes("wifi_ssid"));
    assert.ok(keys.includes("wifi_password"));
    assert.ok(keys.includes("server_url"));
    assert.ok(keys.includes("display_mode"));
    assert.ok(keys.includes("boot_mode"));
    assert.ok(keys.includes("album_collection_id"));
    assert.ok(keys.includes("homepage_id"));
    assert.ok(schema.items.find((item) => item.key === "wifi_password").secret);
    assert.ok(schema.items.find((item) => item.key === "boot_mode").rebootRequired);
  });

  await run("secret values are stored but redacted from reads and exports", async () => {
    const state = makeState();
    const service = createNvsService({ now: () => "2026-06-06T00:00:00.000Z", idFactory: (prefix) => `${prefix}_fixed` });
    const write = await service.setValue(state, auth, "dev_e6", {
      key: "wifi_password",
      value: "bai277199",
    });
    assert.strictEqual(write.key, "wifi_password");
    assert.strictEqual(write.value, "********");
    assert.ok(!JSON.stringify(state.nvsShadows).includes("bai277199"));

    const shadow = service.getShadow(state, auth, "dev_e6");
    const password = shadow.items.find((item) => item.key === "wifi_password");
    assert.strictEqual(password.value, "********");
    assert.strictEqual(password.hasValue, true);

    const exported = service.exportDeviceConfig(state, auth, "dev_e6");
    assert.strictEqual(exported.items.find((item) => item.key === "wifi_password").value, "********");
  });

  await run("bulk import updates shadow and queues nvs.write event", async () => {
    const state = makeState();
    const service = createNvsService({ now: () => "2026-06-06T00:00:00.000Z" });
    const result = await service.importDeviceConfig(state, auth, "dev_e6", {
      items: [
        { key: "wifi_ssid", value: "Xiaomi 13 Ultra" },
        { key: "server_url", value: "http://192.168.1.8:8890" },
        { key: "display_mode", value: "album" },
        { key: "boot_mode", value: "homepage" },
      ],
      reboot: true,
    });
    assert.strictEqual(result.updated, 4);
    assert.ok(result.commandId);
    assert.strictEqual(state.nvsBackups.length, 1);
    assert.ok(state.remoteCommandAcks.some((row) => row.eventType === "nvs.write"));

    const events = getDeviceHistory("dev_e6");
    assert.ok(events.some((event) => event.type === "nvs.write"));

    const shadow = service.getShadow(state, auth, "dev_e6");
    assert.strictEqual(shadow.values.wifi_ssid, "Xiaomi 13 Ultra");
    assert.strictEqual(shadow.values.display_mode, "album");
  });

  await run("backups can be listed and restored", async () => {
    const state = makeState();
    const service = createNvsService({
      now: (() => {
        let index = 0;
        return () => `2026-06-06T00:00:0${index++}.000Z`;
      })(),
      idFactory: (prefix) => `${prefix}_${Math.random().toString(16).slice(2, 8)}`,
    });

    await service.importDeviceConfig(state, auth, "dev_e6", {
      items: [
        { key: "wifi_ssid", value: "old-ssid" },
        { key: "display_mode", value: "homepage" },
      ],
    });
    await service.importDeviceConfig(state, auth, "dev_e6", {
      items: [
        { key: "wifi_ssid", value: "new-ssid" },
        { key: "display_mode", value: "album" },
      ],
    });

    const backups = service.listBackups(state, auth, "dev_e6");
    assert.ok(backups.length >= 2);
    const restoreTarget = backups.find((backup) =>
      backup.rows.some((row) => row.key === "wifi_ssid" && row.value === "old-ssid")
    );
    assert.ok(restoreTarget);

    const restored = await service.restoreBackup(state, auth, "dev_e6", restoreTarget.id);
    assert.strictEqual(restored.restored, true);
    const shadow = service.getShadow(state, auth, "dev_e6");
    assert.strictEqual(shadow.values.wifi_ssid, "old-ssid");
    assert.strictEqual(shadow.values.display_mode, "homepage");
    assert.ok(state.remoteCommandAcks.some((row) => row.eventType === "nvs.write"));
  });

  if (process.exitCode) {
    throw new Error("NVS adapter self-test failed");
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
