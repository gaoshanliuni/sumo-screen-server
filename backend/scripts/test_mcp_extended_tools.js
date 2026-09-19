/* eslint-disable no-console */
const assert = require("assert");

const { listTools } = require("../src/tools/registry");
const { executeTool } = require("../src/tools/executor");

const authAdmin = { role: "admin", userId: "u_admin", username: "admin" };

function makeState() {
  const now = new Date().toISOString();
  return {
    devices: [
      {
        id: "dev_1",
        deviceId: "dev_1",
        ownerId: "u_admin",
        displayName: "客厅 E6",
        type: "e6-color-frame",
        online: true,
        nvs: { boot_mode: "homepage" },
        updatedAt: now,
      },
    ],
    nvsRecords: [{ id: "nvs_1", deviceId: "dev_1", key: "boot_mode", value: "homepage", updatedAt: now }],
    taskPlans: [{ id: "plan_1", title: "每日刷新", status: "enabled", ownerId: "u_admin", createdAt: now, updatedAt: now }],
    todos: [{ id: "todo_1", content: "换墨水屏电池", done: false, ownerId: "u_admin", createdAt: now }],
    scheduleSyncConfigs: [{ id: "xsync_1", deviceId: "dev_1", enabled: true, lastSyncStatus: "success", updatedAt: now }],
    schedules: [{ id: "sch_1", deviceId: "dev_1", title: "课程", weekday: 1, orderIndex: 1, createdAt: now }],
    playCollections: [{ id: "col_1", ownerId: "u_admin", name: "家庭相册", status: "enabled", version: 3, updatedAt: now }],
    playCollectionItems: [],
    imageAssets: [],
    e6RenderedAssets: [],
    tfFiles: [],
    homepageConfigs: [{ id: "home_1", deviceId: "dev_1", title: "主页", updatedAt: now }],
    badgepageConfigs: [{ id: "badge_1", deviceId: "dev_1", title: "桌牌", updatedAt: now }],
    apiTemplates: [{ id: "tpl_1", name: "天气", slug: "weather", enabled: true, updatedAt: now }],
    operationLogs: [{ id: "op_1", action: "device.update", status: "success", createdAt: now }],
    apiLogs: [{ id: "api_1", path: "/api/health", status: 200, createdAt: now }],
    remoteCommands: [{ id: "cmd_1", deviceId: "dev_1", command: "refresh", status: "queued", createdAt: now }],
    nameplateHistory: [{ id: "np_1", deviceId: "dev_1", title: "访客桌牌", createdAt: now }],
  };
}

async function main() {
  const tools = listTools();
  const names = new Set(tools.map((item) => item.name));
  [
    "ink_nvs_get",
    "ink_nvs_set",
    "ink_task_plan_list",
    "ink_task_plan_save",
    "ink_xique_sync_status",
    "ink_xique_sync_now",
    "ink_collection_push_to_device",
    "ink_remote_command_list",
    "ink_homepage_config_get",
    "ink_nameplate_history_list",
    "ink_log_list",
  ].forEach((name) => assert.ok(names.has(name), `missing MCP tool ${name}`));

  const nvsRead = await executeTool({
    state: makeState(),
    actor: authAdmin,
    name: "ink_nvs_get",
    params: { deviceId: "dev_1", key: "boot_mode" },
  });
  assert.strictEqual(nvsRead.ok, true);
  assert.strictEqual(nvsRead.data.value, "homepage");

  const pushGuard = await executeTool({
    state: makeState(),
    actor: authAdmin,
    name: "ink_collection_push_to_device",
    params: { deviceId: "dev_1", collectionId: "col_1" },
  });
  assert.strictEqual(pushGuard.ok, false);
  assert.strictEqual(pushGuard.needConfirm, true);

  const logs = await executeTool({
    state: makeState(),
    actor: authAdmin,
    name: "ink_log_list",
    params: { type: "operation", limit: 10 },
  });
  assert.strictEqual(logs.ok, true);
  assert.strictEqual(logs.data.rows.length, 1);

  console.log("[ok] extended MCP tools contract passed");
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
