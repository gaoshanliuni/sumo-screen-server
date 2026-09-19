const assert = require("assert");

const { listDevicesFromState } = require("../src/repositories/device.repository");
const { buildMobileBootstrap, buildMobileOverview } = require("../src/services/mobile.service");
const { listTools } = require("../src/tools/registry");
const { executeTool } = require("../src/tools/executor");
const { createAiGateway } = require("../src/services/ai/ai_gateway.service");
const { createMemoryCache, createCacheService } = require("../src/cache/cache.service");
const { createTaskService } = require("../src/tasks/task.service");

const authAdmin = { role: "admin", userId: "u_admin", username: "admin" };
const authUser = { role: "user", userId: "u_user", username: "demo" };

function makeState() {
  const now = new Date().toISOString();
  return {
    users: [
      { id: "u_admin", username: "admin", nickname: "超级管理员", role: "admin", status: "enabled" },
      { id: "u_user", username: "demo", nickname: "演示用户", role: "user", status: "enabled" },
    ],
    devices: [
      {
        id: "dev_1",
        mac: "AA:00:00:00:00:01",
        ownerId: "u_user",
        displayName: "会议室门口",
        remark: "A栋",
        bindState: "bound",
        status: "enabled",
        online: true,
        updatedAt: now,
      },
      {
        id: "dev_2",
        mac: "AA:00:00:00:00:02",
        ownerId: "u_user",
        displayName: "7.3寸桌牌",
        remark: "离线测试",
        bindState: "bound",
        status: "enabled",
        online: false,
        updatedAt: now,
      },
      {
        id: "dev_3",
        mac: "AA:00:00:00:00:03",
        ownerId: "u_other",
        displayName: "仓库屏",
        remark: "离线",
        bindState: "bound",
        status: "enabled",
        online: false,
        updatedAt: now,
      },
      {
        id: "dev_4",
        mac: "AA:00:00:00:00:04",
        ownerId: "",
        displayName: "待绑定",
        remark: "",
        bindState: "pending",
        status: "enabled",
        online: false,
        updatedAt: now,
      },
    ],
    clusters: [{ id: "cl_1", name: "会议室", deviceIds: ["dev_1", "dev_2"] }],
    apiTemplates: [{ id: "tpl_weather", name: "天气", slug: "weather", enabled: true }],
    todos: [{ id: "todo_1", deviceId: "dev_1", content: "准备会议", done: false, createdAt: now }],
    schedules: [{ id: "sch_1", deviceId: "dev_1", title: "项目评审", weekday: 1, orderIndex: 1, createdAt: now }],
    operationLogs: [{ id: "op_1", action: "device.update", status: "success", createdAt: now }],
    apiLogs: [],
    nameplateHistory: [{ id: "his_1", deviceId: "dev_1", createdAt: now }],
    aiSessions: [],
    aiMessages: [],
    aiToolCalls: [],
    aiConfirmations: [],
    tasks: [],
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
  await run("device repository paginates and filters visible rows", async () => {
    const state = makeState();
    const page = listDevicesFromState(state, {
      auth: authUser,
      online: false,
      page: 1,
      pageSize: 1,
      keyword: "桌牌",
    });
    assert.strictEqual(page.total, 1);
    assert.strictEqual(page.page, 1);
    assert.strictEqual(page.pageSize, 1);
    assert.strictEqual(page.rows.length, 1);
    assert.strictEqual(page.rows[0].id, "dev_2");
  });

  await run("mobile bootstrap returns small summary and menu permissions", async () => {
    const bootstrap = buildMobileBootstrap(makeState(), authAdmin);
    assert.strictEqual(bootstrap.user.name, "超级管理员");
    assert.deepStrictEqual(bootstrap.summary, {
      totalDevices: 4,
      onlineDevices: 1,
      offlineDevices: 2,
      pendingBindDevices: 1,
    });
    assert.ok(bootstrap.menus.some((item) => item.key === "variables"));
    assert.strictEqual(bootstrap.permissions.canUseAI, true);
  });

  await run("mobile overview respects user device visibility", async () => {
    const overview = buildMobileOverview(makeState(), authUser, { status: "offline" });
    assert.strictEqual(overview.summary.totalDevices, 2);
    assert.strictEqual(overview.filteredDevices.total, 1);
    assert.strictEqual(overview.filteredDevices.rows[0].id, "dev_2");
  });

  await run("tool registry exposes read and guarded device-action tools", async () => {
    const tools = listTools();
    assert.ok(tools.some((item) => item.name === "ink_device_list"));
    assert.ok(tools.some((item) => item.name === "ink_remote_refresh_page"));

    const readResult = await executeTool({
      state: makeState(),
      actor: authAdmin,
      name: "ink_device_list",
      params: { online: false, pageSize: 2 },
    });
    assert.strictEqual(readResult.ok, true);
    assert.strictEqual(readResult.data.rows.length, 2);

    const guarded = await executeTool({
      state: makeState(),
      actor: authAdmin,
      name: "ink_remote_refresh_page",
      params: { deviceId: "dev_1" },
    });
    assert.strictEqual(guarded.needConfirm, true);
    assert.strictEqual(guarded.ok, false);
  });

  await run("ai gateway can query devices and returns confirmation for actions", async () => {
    const state = makeState();
    const cache = createMemoryCache();
    const gateway = createAiGateway({
      readState: async () => state,
      updateState: async (mutator) => mutator(state),
      cache,
    });

    const query = await gateway.chat({
      actor: authAdmin,
      message: "有哪些离线设备？",
      pageContext: { source: "miniapp", page: "ai" },
    });
    assert.strictEqual(query.needConfirm, false);
    assert.ok(query.reply.includes("离线"));
    assert.ok(query.toolCalls.length >= 1);

    const action = await gateway.chat({
      actor: authAdmin,
      message: "刷新会议室门口那块屏",
    });
    assert.strictEqual(action.needConfirm, true);
    assert.ok(action.confirmToken);
    assert.strictEqual(action.plannedActions[0].tool, "ink_remote_refresh_page");

    const denied = await gateway.confirm({
      actor: authAdmin,
      sessionId: action.sessionId,
      confirmToken: action.confirmToken,
      approved: false,
    });
    assert.strictEqual(denied.status, "cancelled");
  });

  await run("cache and task services degrade without Redis", async () => {
    const cache = createCacheService({ enabled: false });
    await cache.set("demo", { ok: true }, 1);
    assert.deepStrictEqual(await cache.get("demo"), { ok: true });

    const taskService = createTaskService({ cache, queueEnabled: false });
    const task = await taskService.enqueue("demo.echo", { text: "hi" }, async ({ payload, updateProgress }) => {
      await updateProgress(60, "running");
      return { echoed: payload.text };
    });
    assert.strictEqual(task.status, "queued");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const latest = await taskService.get(task.id);
    assert.strictEqual(latest.status, "success");
    assert.deepStrictEqual(latest.result, { echoed: "hi" });
  });

  if (process.exitCode) {
    throw new Error("mobile/ai/mcp self-test failed");
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
