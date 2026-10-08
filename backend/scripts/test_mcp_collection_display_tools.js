const assert = require("assert");

const storePath = require.resolve("../src/db/store");
let state = null;

function makeState() {
  const now = new Date().toISOString();
  return {
    users: [{ id: "u_user", username: "demo", nickname: "演示用户", role: "user", status: "enabled" }],
    devices: [
      {
        id: "dev_e6_1",
        mac: "AA:BB:CC:00:00:01",
        ownerId: "u_user",
        displayName: "客厅 E6 相框",
        remark: "客厅",
        bindState: "bound",
        status: "enabled",
        online: true,
        type: "e6-color-frame",
        currentDisplayMode: "homepage",
        currentCollectionId: "",
        bootDisplayMode: "homepage",
        updatedAt: now,
        createdAt: now,
      },
    ],
    playCollections: [
      {
        id: "col_family",
        ownerId: "u_user",
        name: "家庭相册",
        description: "客厅相框照片",
        playMode: "slideshow",
        slideIntervalSec: 120,
        loopEnabled: true,
        shuffleEnabled: false,
        offlineSyncEnabled: true,
        status: "enabled",
        version: 3,
        createdAt: now,
        updatedAt: now,
      },
    ],
    playCollectionItems: [
      { id: "coli_1", collectionId: "col_family", imageId: "img_1", sortOrder: 1, enabled: true, createdAt: now },
    ],
    imageAssets: [{ id: "img_1", ownerId: "u_user", originalName: "family.png", mime: "image/png" }],
    nvsShadows: [],
    nvsBackups: [],
    remoteCommandAcks: [],
    operationLogs: [],
  };
}

require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: {
    readDB: async () => state,
    updateDB: async (mutator) => mutator(state),
  },
};

process.env.MCP_ROLE = "user";
process.env.MCP_USER_ID = "u_user";

const { handleJsonRpc } = require("../src/mcp/server");
const { getDeviceHistory } = require("../src/utils/realtime.hub");

function parseToolResult(response) {
  assert.ifError(response.error);
  const text = response.result.content[0].text;
  return JSON.parse(text);
}

async function rpc(method, params = {}) {
  return handleJsonRpc({ jsonrpc: "2.0", id: Math.floor(Math.random() * 100000), method, params });
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
  state = makeState();

  await run("tools/list exposes collection and display tools with described fields", async () => {
    const response = await rpc("tools/list");
    assert.ifError(response.error);
    const names = response.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("ink_collection_find"));
    assert.ok(names.includes("ink_device_switch_collection"));
    assert.ok(names.includes("ink_device_switch_display_mode"));
    assert.ok(names.includes("ink_device_set_boot_display_mode"));
    assert.ok(names.includes("ink_device_switch_home"));
    assert.ok(names.includes("ink_device_switch_album"));
    assert.ok(names.includes("ink_album_source_list"));
    assert.ok(names.includes("ink_album_source_save"));
    assert.ok(names.includes("ink_album_source_delete"));
    assert.ok(names.includes("ink_album_source_browse"));
    assert.ok(names.includes("ink_collection_save"));
    assert.ok(names.includes("ink_collection_delete"));
    assert.ok(names.includes("ink_collection_set_items"));
    assert.ok(names.includes("ink_ai_config_get"));
    assert.ok(names.includes("ink_ai_config_save"));

    response.result.tools.forEach((tool) => {
      assert.match(
        tool.description,
        /使用方法|Use when|调用建议/,
        `${tool.name} should describe how AI should use the tool`
      );
    });

    const switchCollection = response.result.tools.find((tool) => tool.name === "ink_device_switch_collection");
    assert.match(switchCollection.inputSchema.properties.deviceName.description, /设备名称/);
    assert.match(switchCollection.inputSchema.properties.collectionName.description, /集合名称/);
  });

  await run("tools/call returns confirmation requirement before switching collection", async () => {
    const response = await rpc("tools/call", {
      name: "ink_device_switch_collection",
      arguments: {
        deviceName: "客厅 E6 相框",
        collectionName: "家庭相册",
      },
    });
    const result = parseToolResult(response);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.needConfirm, true);
    assert.match(result.confirmToken, /^confirm_/);
    assert.strictEqual(state.devices[0].currentCollectionId, "");
    assert.strictEqual(getDeviceHistory("dev_e6_1").length, 0);
  });

  await run("tools/call switches collection after confirmation and publishes expected events", async () => {
    const response = await rpc("tools/call", {
      name: "ink_device_switch_collection",
      arguments: {
        deviceName: "客厅 E6 相框",
        collectionName: "家庭相册",
        confirm: true,
      },
    });
    const result = parseToolResult(response);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.device.id, "dev_e6_1");
    assert.strictEqual(result.data.collection.id, "col_family");
    assert.strictEqual(result.data.displayMode, "album");
    assert.strictEqual(state.devices[0].currentCollectionId, "col_family");
    assert.strictEqual(state.devices[0].currentDisplayMode, "album");

    const events = getDeviceHistory("dev_e6_1");
    assert.ok(events.some((event) => event.type === "collection.push"));
    assert.ok(events.some((event) => event.type === "display.set" && event.payload.displayMode === "album"));
  });

  await run("tools/call returns confirmation requirement before switching display mode", async () => {
    const response = await rpc("tools/call", {
      name: "ink_device_switch_display_mode",
      arguments: {
        deviceName: "客厅 E6 相框",
        mode: "homepage",
      },
    });
    const result = parseToolResult(response);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.needConfirm, true);
    assert.strictEqual(state.devices[0].currentDisplayMode, "album");
  });

  await run("tools/call switches display mode after confirmation and records state", async () => {
    const response = await rpc("tools/call", {
      name: "ink_device_switch_display_mode",
      arguments: {
        deviceName: "客厅 E6 相框",
        mode: "homepage",
        confirm: true,
      },
    });
    const result = parseToolResult(response);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.displayMode, "homepage");
    assert.strictEqual(state.devices[0].currentDisplayMode, "homepage");
    assert.ok(state.remoteCommandAcks.some((row) => row.eventType === "display.set"));
    assert.ok(state.operationLogs.some((row) => row.action === "mcp.device.switch_display_mode"));

    const events = getDeviceHistory("dev_e6_1");
    assert.ok(events.some((event) => event.type === "display.set" && event.payload.displayMode === "homepage"));
  });

  await run("tools/call sets boot display mode with confirmation and syncs E6 NVS shadow", async () => {
    const dryRun = await rpc("tools/call", {
      name: "ink_device_set_boot_display_mode",
      arguments: {
        deviceName: "客厅 E6 相框",
        mode: "album",
      },
    });
    const planned = parseToolResult(dryRun);
    assert.strictEqual(planned.ok, false);
    assert.strictEqual(planned.needConfirm, true);
    assert.strictEqual(state.devices[0].bootDisplayMode, "homepage");

    const response = await rpc("tools/call", {
      name: "ink_device_set_boot_display_mode",
      arguments: {
        deviceName: "客厅 E6 相框",
        mode: "album",
        confirm: true,
      },
    });
    const result = parseToolResult(response);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.bootDisplayMode, "album");
    assert.strictEqual(state.devices[0].bootDisplayMode, "album");
    assert.ok(state.nvsShadows.some((row) => row.deviceId === "dev_e6_1" && row.key === "boot_mode" && row.value === "album"));
    assert.ok(state.nvsBackups.length > 0);
    assert.ok(state.remoteCommandAcks.some((row) => row.eventType === "display.set_boot_mode"));

    const events = getDeviceHistory("dev_e6_1");
    assert.ok(events.some((event) => event.type === "display.set_boot_mode" && event.payload.bootMode === "album"));
    assert.ok(events.some((event) => event.type === "nvs.write"));
  });

  await run("tools/call switch_home and switch_album are confirmed shortcuts", async () => {
    const home = await rpc("tools/call", {
      name: "ink_device_switch_home",
      arguments: {
        deviceName: "客厅 E6 相框",
        renderHomeNow: true,
        confirm: true,
      },
    });
    const homeResult = parseToolResult(home);
    assert.strictEqual(homeResult.ok, true);
    assert.strictEqual(homeResult.data.displayMode, "homepage");
    assert.strictEqual(state.devices[0].currentDisplayMode, "homepage");

    const album = await rpc("tools/call", {
      name: "ink_device_switch_album",
      arguments: {
        deviceName: "客厅 E6 相框",
        collectionName: "家庭相册",
        confirm: true,
      },
    });
    const albumResult = parseToolResult(album);
    assert.strictEqual(albumResult.ok, true);
    assert.strictEqual(albumResult.data.displayMode, "album");
    assert.strictEqual(albumResult.data.collection.id, "col_family");
    assert.strictEqual(state.devices[0].currentDisplayMode, "album");
    assert.strictEqual(state.devices[0].currentCollectionId, "col_family");
  });

  if (process.exitCode) {
    throw new Error("mcp collection/display tool test failed");
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
