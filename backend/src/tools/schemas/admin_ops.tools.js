const createId = require("../../utils/id");
const { findDeviceFromState, getVisibleDevices } = require("../../repositories/device.repository");
const { resolveTargetDeviceIds } = require("../../utils/access");
const { publishDeviceEvent } = require("../../utils/realtime.hub");
const { createPendingAck } = require("../../utils/remoteAck");
const { upsertBaseVariableOnDevice } = require("../../services/device_variable.service");
const { createNvsService } = require("../../services/nvs/nvs.service");
const {
  DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC,
  createPlayCollectionService,
} = require("../../services/play_collection.service");
const { normalizeTaskPlan, computeNextRunAt } = require("../../services/task_plan.service");
const { createAiConfigService } = require("../../services/ai/ai_config.service");

const nvsService = createNvsService();
const collectionService = createPlayCollectionService();
const aiConfigService = createAiConfigService();

function text(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeIdList(input) {
  if (Array.isArray(input)) return [...new Set(input.map((item) => text(item)).filter(Boolean))];
  const raw = text(input);
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeIdList(parsed);
    } catch (_) {
      // Fall through to comma splitting.
    }
  }
  return [...new Set(raw.split(",").map((item) => text(item)).filter(Boolean))];
}

function throwToolError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertAdmin(actor) {
  if (actor?.role !== "admin") throwToolError("FORBIDDEN", "仅管理员可执行该工具");
}

function ensureShape(state) {
  state.devices = Array.isArray(state.devices) ? state.devices : [];
  state.users = Array.isArray(state.users) ? state.users : [];
  state.clusters = Array.isArray(state.clusters) ? state.clusters : [];
  state.bindingPins = Array.isArray(state.bindingPins) ? state.bindingPins : [];
  state.remoteCommandAcks = Array.isArray(state.remoteCommandAcks) ? state.remoteCommandAcks : [];
  state.operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
  state.todos = Array.isArray(state.todos) ? state.todos : [];
  state.taskPlans = Array.isArray(state.taskPlans) ? state.taskPlans : [];
  state.taskRuns = Array.isArray(state.taskRuns) ? state.taskRuns : [];
  state.scheduleSyncConfigs = Array.isArray(state.scheduleSyncConfigs) ? state.scheduleSyncConfigs : [];
  state.syncLogs = Array.isArray(state.syncLogs) ? state.syncLogs : [];
  state.apiTemplates = Array.isArray(state.apiTemplates) ? state.apiTemplates : [];
  state.nameplateHistory = Array.isArray(state.nameplateHistory) ? state.nameplateHistory : [];
}

function compactDevice(device = {}) {
  return {
    id: text(device.id || device.deviceId),
    mac: text(device.mac),
    displayName: text(device.displayName || device.name || device.remark),
    remark: text(device.remark),
    ownerId: text(device.ownerId),
    status: text(device.status || "enabled"),
    online: Boolean(device.online || device.isOnline),
    bindState: text(device.bindState || (device.ownerId ? "bound" : "pending")),
  };
}

function resolveTargets(state, actor, params = {}) {
  ensureShape(state);
  const directIds = normalizeIdList(params.deviceIds);
  if (params.deviceId) directIds.push(text(params.deviceId));
  const clusterIds = normalizeIdList(params.clusterIds);
  const targetIds = [...new Set(resolveTargetDeviceIds(state, directIds, clusterIds))];
  if (!targetIds.length) throwToolError("BAD_PARAMS", "至少提供 deviceId/deviceIds 或 clusterIds");
  const visible = new Set(getVisibleDevices(state, actor).map((item) => text(item.id || item.deviceId)));
  const allowed = [];
  const denied = [];
  targetIds.forEach((id) => {
    if (visible.has(id)) allowed.push(id);
    else denied.push({ deviceId: id, reason: "设备不存在或无权限" });
  });
  return { targetIds: allowed, denied, requestedCount: targetIds.length };
}

function appendOperationLog(state, actor, action, targetType, targetId, detail = {}) {
  ensureShape(state);
  state.operationLogs.unshift({
    id: createId("oplog"),
    actorId: text(actor?.userId || "mcp"),
    actorRole: text(actor?.role || "mcp"),
    action,
    targetType,
    targetId: text(targetId),
    detail,
    status: "success",
    createdAt: nowIso(),
  });
  if (state.operationLogs.length > 5000) state.operationLogs.splice(5000);
}

function queueDeviceCommand(state, actor, deviceId, eventType, payload = {}, source = "mcp") {
  const ack = createPendingAck(state, {
    deviceId,
    eventType,
    source,
    operatorId: text(actor?.userId || "mcp"),
    operatorRole: text(actor?.role || "mcp"),
    meta: payload,
  });
  publishDeviceEvent({
    type: eventType,
    deviceId,
    payload: {
      ...payload,
      commandId: ack.commandId,
      requestedAt: nowIso(),
    },
  });
  return ack;
}

function visibleTaskPlans(state, actor) {
  ensureShape(state);
  if (actor.role === "admin") return state.taskPlans;
  return state.taskPlans.filter((item) => text(item.ownerId) === text(actor.userId));
}

function compactCollection(collection = {}) {
  return {
    id: text(collection.id),
    name: text(collection.name),
    itemCount: Number(collection.itemCount || 0),
    slideIntervalSec: Number(collection.slideIntervalSec || DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC),
    updatedAt: text(collection.updatedAt),
  };
}

module.exports = [
  {
    name: "ink_pin_bind_device",
    title: "PIN 码绑定设备",
    description: "通过硬件屏幕显示的 PIN 码绑定设备并可指定归属用户。调用建议：用户说 PIN 绑定时使用；ownerId 可空，默认当前用户，管理员可传 ownerId。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["pin"],
      properties: {
        pin: { type: "string", description: "硬件屏幕显示的 PIN 码。" },
        ownerId: { type: "string", description: "管理员可指定归属用户；普通用户会绑定到自己。" },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      if (typeof updateState !== "function") throw new Error("updateState unavailable");
      let output = null;
      await updateState((draft) => {
        ensureShape(draft);
        const pin = text(params.pin);
        const row = draft.bindingPins.find((item) => text(item.pin) === pin && text(item.status || "pending") === "pending");
        if (!row) throwToolError("PIN_NOT_FOUND", "PIN不存在或已失效");
        if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) throwToolError("PIN_EXPIRED", "PIN已过期");
        const device = draft.devices.find((item) => text(item.id || item.deviceId) === text(row.deviceId));
        if (!device) throwToolError("DEVICE_NOT_FOUND", "PIN对应设备不存在");
        const ownerId = actor.role === "admin" && params.ownerId !== undefined ? text(params.ownerId) : text(actor.userId);
        device.ownerId = ownerId;
        device.bindState = ownerId ? "bound" : "pending";
        device.boundAt = ownerId ? nowIso() : "";
        device.boundBy = text(actor.userId);
        device.updatedAt = nowIso();
        row.status = "used";
        row.usedBy = ownerId;
        row.usedAt = nowIso();
        const ack = queueDeviceCommand(draft, actor, device.id, "binding.success", { ownerId }, "mcp.pin_bind");
        output = { device: compactDevice(device), pinId: row.id || "", commandId: ack.commandId };
      });
      return output;
    },
  },
  {
    name: "ink_device_pool_list",
    title: "查询设备池",
    description: "查询设备池名称、描述和设备成员。调用建议：用户说设备池/设备分组/批量设备时，先用它拿 poolId/clusterId。",
    riskLevel: "read",
    inputSchema: { type: "object", properties: { keyword: { type: "string" } } },
    handler: async ({ state, params, actor }) => {
      ensureShape(state);
      const visible = new Set(getVisibleDevices(state, actor).map((item) => text(item.id || item.deviceId)));
      const keyword = text(params.keyword).toLowerCase();
      const rows = state.clusters
        .map((cluster) => ({
          id: text(cluster.id),
          name: text(cluster.name),
          description: text(cluster.description),
          rule: text(cluster.rule),
          deviceIds: actor.role === "admin" ? normalizeIdList(cluster.deviceIds) : normalizeIdList(cluster.deviceIds).filter((id) => visible.has(id)),
          updatedAt: text(cluster.updatedAt),
        }))
        .filter((cluster) => actor.role === "admin" || cluster.deviceIds.length)
        .filter((cluster) => !keyword || [cluster.name, cluster.description, cluster.id].join(" ").toLowerCase().includes(keyword));
      return { pools: rows, total: rows.length };
    },
  },
  {
    name: "ink_device_pool_save",
    title: "新建或修改设备池",
    description: "新建或修改设备池名称、描述、规则和设备成员。调用建议：只有管理员可用；新建不传 poolId，修改传 poolId。",
    riskLevel: "admin",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        poolId: { type: "string", description: "设备池 ID；不填则新建。" },
        name: { type: "string" },
        description: { type: "string" },
        rule: { type: "string" },
        deviceIds: { type: "array", items: { type: "string" } },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      assertAdmin(actor);
      if (typeof updateState !== "function") throw new Error("updateState unavailable");
      let saved = null;
      await updateState((draft) => {
        ensureShape(draft);
        const validIds = normalizeIdList(params.deviceIds).filter((id) => draft.devices.some((device) => text(device.id) === id));
        if (params.poolId) {
          saved = draft.clusters.find((item) => text(item.id) === text(params.poolId));
          if (!saved) throwToolError("POOL_NOT_FOUND", "设备池不存在");
          if (params.name !== undefined) saved.name = text(params.name);
          if (params.description !== undefined) saved.description = text(params.description);
          if (params.rule !== undefined) saved.rule = text(params.rule);
          if (params.deviceIds !== undefined) saved.deviceIds = validIds;
          saved.updatedAt = nowIso();
        } else {
          saved = {
            id: createId("cluster"),
            name: text(params.name),
            description: text(params.description),
            rule: text(params.rule),
            deviceIds: validIds,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          draft.clusters.unshift(saved);
        }
        appendOperationLog(draft, actor, "mcp.device_pool.save", "cluster", saved.id, { name: saved.name });
      });
      return saved;
    },
  },
  {
    name: "ink_device_pool_delete",
    title: "删除设备池",
    description: "删除设备池，不删除设备本身。调用建议：执行前确认设备池名称和 ID。",
    riskLevel: "admin",
    inputSchema: {
      type: "object",
      required: ["poolId"],
      properties: {
        poolId: { type: "string" },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ params, actor, updateState }) => {
      assertAdmin(actor);
      let removed = null;
      await updateState((draft) => {
        ensureShape(draft);
        const index = draft.clusters.findIndex((item) => text(item.id) === text(params.poolId));
        if (index < 0) throwToolError("POOL_NOT_FOUND", "设备池不存在");
        removed = draft.clusters.splice(index, 1)[0];
        appendOperationLog(draft, actor, "mcp.device_pool.delete", "cluster", params.poolId, { name: removed.name });
      });
      return { id: text(params.poolId), name: text(removed?.name) };
    },
  },
  {
    name: "ink_nvs_get",
    title: "读取设备 NVS 影子值",
    description: "查看后端保存的设备 NVS 影子值。调用建议：用户问硬件当前服务器地址/Wi-Fi/开机模式时先用它；USB 直读不走本工具。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      required: ["deviceId"],
      properties: {
        deviceId: { type: "string" },
        key: { type: "string", description: "可选；不传返回全部影子值。" },
      },
    },
    handler: async ({ state, params, actor }) => {
      const shadow = nvsService.getShadow(state, actor, params.deviceId);
      if (!params.key) return shadow;
      const item = shadow.items.find((row) => row.key === params.key) || null;
      return { deviceId: shadow.deviceId, key: params.key, value: item ? item.value : "" };
    },
  },
  {
    name: "ink_nvs_set",
    title: "写入单个设备 NVS",
    description: "写入单个 NVS key/value 并可要求重启。调用建议：真实影响硬件，先确认 key/value/deviceId。",
    riskLevel: "device_write",
    inputSchema: {
      type: "object",
      required: ["deviceId", "key", "value"],
      properties: {
        deviceId: { type: "string" },
        key: { type: "string" },
        value: {},
        reboot: { type: "boolean", default: true },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ params, actor, updateState }) => {
      let result = null;
      await updateState(async (draft) => {
        result = await nvsService.setValue(draft, actor, params.deviceId, {
          key: params.key,
          value: params.value,
          reboot: params.reboot !== false,
        });
      });
      return result;
    },
  },
  {
    name: "ink_nvs_dispatch_server_addresses",
    title: "下发 NVS 内外网后端地址",
    description: "向单台或多台设备写入 lan_server_url、wan_server_url，可同时写 active server_url。调用建议：优先填内网地址和公网地址；真实影响硬件，需确认。",
    riskLevel: "device_write",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        deviceIds: { type: "array", items: { type: "string" } },
        clusterIds: { type: "array", items: { type: "string" } },
        lanServerUrl: { type: "string" },
        wanServerUrl: { type: "string" },
        activeServerUrl: { type: "string", description: "可选；写入 server_url。" },
        activeProfile: { type: "string", enum: ["lan", "wan"] },
        reboot: { type: "boolean", default: true },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const target = resolveTargets(state, actor, params);
      const results = [];
      await updateState(async (draft) => {
        for (const deviceId of target.targetIds) {
          const items = [];
          if (params.lanServerUrl !== undefined) items.push({ key: "lan_server_url", value: params.lanServerUrl });
          if (params.wanServerUrl !== undefined) items.push({ key: "wan_server_url", value: params.wanServerUrl });
          if (params.activeServerUrl !== undefined) items.push({ key: "server_url", value: params.activeServerUrl });
          if (params.activeProfile !== undefined) items.push({ key: "active_server_profile", value: params.activeProfile });
          const result = await nvsService.importDeviceConfig(draft, actor, deviceId, { items, reboot: params.reboot !== false });
          results.push(result);
        }
      });
      return { requestedCount: target.requestedCount, successCount: results.length, failed: target.denied, results };
    },
  },
  {
    name: "ink_device_variable_batch_set",
    title: "批量设置设备变量",
    description: "对单个、多个或设备池内设备批量设置基础变量。调用建议：支持 deviceIds 和 clusterIds；变量可用于模板渲染。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["name", "value"],
      properties: {
        deviceId: { type: "string" },
        deviceIds: { type: "array", items: { type: "string" } },
        clusterIds: { type: "array", items: { type: "string" } },
        name: { type: "string" },
        value: {},
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const target = resolveTargets(state, actor, params);
      const results = [];
      await updateState((draft) => {
        ensureShape(draft);
        target.targetIds.forEach((deviceId) => {
          const device = draft.devices.find((item) => text(item.id || item.deviceId) === deviceId);
          if (!device) return;
          const row = upsertBaseVariableOnDevice(device, { name: params.name, value: params.value });
          results.push({ deviceId, ...row });
          publishDeviceEvent({ type: "device.variables.updated", deviceId, payload: { source: "mcp", name: row.name } });
        });
        appendOperationLog(draft, actor, "mcp.device_variable.batch_set", "device_batch", `count:${target.targetIds.length}`, { name: params.name });
      });
      return { requestedCount: target.requestedCount, successCount: results.length, failed: target.denied, results };
    },
  },
  {
    name: "ink_task_plan_list",
    title: "查看计划任务和执行状态",
    description: "查看计划任务列表和最近运行状态。调用建议：用户问自动任务、定时刷新、任务是否执行时使用。",
    riskLevel: "read",
    inputSchema: { type: "object", properties: { planId: { type: "string" }, limit: { type: "integer", default: 50 } } },
    handler: async ({ state, params, actor }) => {
      const rows = visibleTaskPlans(state, actor).filter((item) => !params.planId || text(item.id) === text(params.planId));
      const ids = new Set(rows.map((item) => text(item.id)));
      const runs = (state.taskRuns || []).filter((run) => ids.has(text(run.planId))).slice(0, Number(params.limit || 50));
      return { plans: rows.map((item) => normalizeTaskPlan(item)), runs };
    },
  },
  {
    name: "ink_task_plan_save",
    title: "新建或修改计划任务",
    description: "新建或修改计划任务、步骤和调度规则。调用建议：steps.actionType 支持 device.variable.upsert/api_template.refresh/remote.update_backend_url/remote.switch_view。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        planId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        enabled: { type: "boolean" },
        targetDeviceIds: { type: "array", items: { type: "string" } },
        targetClusterIds: { type: "array", items: { type: "string" } },
        scheduleMode: { type: "string", enum: ["once", "weekly", "calendar"] },
        scheduleSpec: { type: "object" },
        steps: { type: "array", items: { type: "object" } },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ params, actor, updateState }) => {
      let saved = null;
      await updateState((draft) => {
        ensureShape(draft);
        const now = nowIso();
        if (params.planId) {
          const index = draft.taskPlans.findIndex((item) => text(item.id) === text(params.planId));
          if (index < 0) throwToolError("PLAN_NOT_FOUND", "计划任务不存在");
          const existing = draft.taskPlans[index];
          if (actor.role !== "admin" && text(existing.ownerId) !== text(actor.userId)) throwToolError("FORBIDDEN", "无权限修改该计划任务");
          saved = normalizeTaskPlan({ ...existing, ...params, id: existing.id, ownerId: existing.ownerId, updatedAt: now }, now);
          saved.nextRunAt = computeNextRunAt(saved, new Date(now));
          draft.taskPlans[index] = saved;
        } else {
          saved = normalizeTaskPlan({ ...params, ownerId: text(actor.userId), createdBy: text(actor.userId) }, now);
          saved.nextRunAt = computeNextRunAt(saved, new Date(now));
          draft.taskPlans.unshift(saved);
        }
      });
      return saved;
    },
  },
  {
    name: "ink_task_plan_delete",
    title: "删除计划任务",
    description: "删除计划任务。调用建议：删除前向用户确认计划名称和 planId。",
    riskLevel: "destructive",
    inputSchema: { type: "object", required: ["planId"], properties: { planId: { type: "string" }, confirm: { type: "boolean" } } },
    handler: async ({ params, actor, updateState }) => {
      let removed = null;
      await updateState((draft) => {
        ensureShape(draft);
        const index = draft.taskPlans.findIndex((item) => text(item.id) === text(params.planId));
        if (index < 0) throwToolError("PLAN_NOT_FOUND", "计划任务不存在");
        const row = draft.taskPlans[index];
        if (actor.role !== "admin" && text(row.ownerId) !== text(actor.userId)) throwToolError("FORBIDDEN", "无权限删除该计划任务");
        removed = draft.taskPlans.splice(index, 1)[0];
      });
      return { id: text(params.planId), name: text(removed?.name) };
    },
  },
  {
    name: "ink_task_plan_run_status",
    title: "查看任务执行状态",
    description: "按 runId 或 planId 查看任务执行状态。调用建议：用户问任务是否完成/失败原因时使用。",
    riskLevel: "read",
    inputSchema: { type: "object", properties: { planId: { type: "string" }, runId: { type: "string" }, limit: { type: "integer", default: 20 } } },
    handler: async ({ state, params, actor }) => {
      const visibleIds = new Set(visibleTaskPlans(state, actor).map((item) => text(item.id)));
      let runs = state.taskRuns || [];
      if (params.runId) runs = runs.filter((item) => text(item.id) === text(params.runId));
      if (params.planId) runs = runs.filter((item) => text(item.planId) === text(params.planId));
      runs = runs.filter((item) => visibleIds.has(text(item.planId))).slice(0, Number(params.limit || 20));
      return { runs, total: runs.length };
    },
  },
  {
    name: "ink_todo_delete",
    title: "删除 TODO",
    description: "删除单条或多条 TODO。调用建议：先用 ink_todo_list 找到 todoId，再确认删除。",
    riskLevel: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        todoId: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const ids = normalizeIdList(params.ids);
      if (params.todoId) ids.push(text(params.todoId));
      const visibleDevices = new Set(getVisibleDevices(state, actor).map((item) => text(item.id || item.deviceId)));
      const deleted = [];
      await updateState((draft) => {
        ensureShape(draft);
        draft.todos = draft.todos.filter((todo) => {
          if (!ids.includes(text(todo.id)) || !visibleDevices.has(text(todo.deviceId))) return true;
          deleted.push(text(todo.id));
          publishDeviceEvent({ type: "todo.changed", deviceId: text(todo.deviceId), payload: { action: "delete", todoId: todo.id } });
          return false;
        });
      });
      return { deletedIds: deleted };
    },
  },
  {
    name: "ink_xique_import",
    title: "导入喜鹊课程表",
    description: "导入喜鹊课程表。调用建议：MCP 调用前必须要求用户给出喜鹊账号密码，并确认目标 deviceId；本工具不会猜测账号密码。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["deviceId", "username", "password"],
      properties: {
        deviceId: { type: "string" },
        username: { type: "string", description: "用户提供的喜鹊账号。" },
        password: { type: "string", description: "用户提供的喜鹊密码。" },
        termStartDate: { type: "string" },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const device = findDeviceFromState(state, actor, params.deviceId);
      if (!device) throwToolError("DEVICE_NOT_FOUND", "设备不存在或无权限");
      let saved = null;
      await updateState((draft) => {
        ensureShape(draft);
        saved = {
          id: createId("xsync"),
          deviceId: device.id,
          ownerId: text(device.ownerId || actor.userId),
          source: "xique",
          enabled: true,
          adapterMode: "real",
          loginUsername: text(params.username),
          loginDisplayName: text(params.username),
          termStartDate: text(params.termStartDate),
          lastSyncStatus: "queued",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        draft.scheduleSyncConfigs.unshift(saved);
        draft.syncLogs.unshift({
          id: createId("xslog"),
          configId: saved.id,
          deviceId: device.id,
          action: "xique.import.requested",
          status: "queued",
          detail: { username: saved.loginUsername, passwordProvided: Boolean(params.password) },
          createdAt: nowIso(),
        });
      });
      return { config: saved, message: "喜鹊导入任务已记录，后续由同步器执行登录和导入" };
    },
  },
  {
    name: "ink_collection_push_to_device",
    title: "推送播放集合到设备",
    description: "把播放集合推送给单台、多台或设备池中的设备。调用建议：先用 ink_collection_list 获取 collectionId，再确认目标设备。",
    riskLevel: "device_action",
    inputSchema: {
      type: "object",
      required: ["collectionId"],
      properties: {
        collectionId: { type: "string" },
        deviceId: { type: "string" },
        deviceIds: { type: "array", items: { type: "string" } },
        clusterIds: { type: "array", items: { type: "string" } },
        baseUrl: { type: "string" },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const collection = collectionService.getCollection(state, actor, params.collectionId);
      const target = resolveTargets(state, actor, params);
      const results = [];
      await updateState((draft) => {
        ensureShape(draft);
        target.targetIds.forEach((deviceId) => {
          const device = draft.devices.find((item) => text(item.id || item.deviceId) === deviceId);
          if (device) {
            device.currentCollectionId = collection.id;
            device.currentDisplayMode = "album";
            device.lastDisplayCollectionId = collection.id;
            device.updatedAt = nowIso();
          }
          const event = collectionService.buildPushEvent(draft, actor, { collectionId: collection.id, deviceId, baseUrl: params.baseUrl || "" });
          const ack = queueDeviceCommand(draft, actor, deviceId, "collection.push", event.payload, "mcp.collection_push");
          results.push({ deviceId, commandId: ack.commandId, collection: compactCollection(collection) });
        });
      });
      return { requestedCount: target.requestedCount, successCount: results.length, failed: target.denied, results };
    },
  },
  {
    name: "ink_collection_push_image_to_device",
    title: "推送单张图片到设备",
    description: "把已导入图片直接投送到单台、多台或设备池设备。调用建议：需要 imageId；若用户只给图片名称，先查集合详情或来源导入。",
    riskLevel: "device_action",
    inputSchema: {
      type: "object",
      required: ["imageId"],
      properties: {
        imageId: { type: "string" },
        deviceId: { type: "string" },
        deviceIds: { type: "array", items: { type: "string" } },
        clusterIds: { type: "array", items: { type: "string" } },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const target = resolveTargets(state, actor, params);
      const image = (state.imageAssets || []).find((item) => text(item.id) === text(params.imageId));
      if (!image) throwToolError("IMAGE_NOT_FOUND", "图片不存在");
      const results = [];
      await updateState((draft) => {
        ensureShape(draft);
        target.targetIds.forEach((deviceId) => {
          const ack = queueDeviceCommand(
            draft,
            actor,
            deviceId,
            "remote.show_image_asset",
            { imageId: image.id, fileId: image.tfFileId || image.originalTfFileId || "", previewUrl: image.previewUrl || image.thumbnailUrl || "" },
            "mcp.image_push"
          );
          results.push({ deviceId, commandId: ack.commandId, imageId: image.id });
        });
      });
      return { requestedCount: target.requestedCount, successCount: results.length, failed: target.denied, results };
    },
  },
  {
    name: "ink_remote_publish_announcement",
    title: "发布远程公告",
    description: "向单台、多台或设备池发布文字公告。调用建议：需要 text 和持续时间 durationSec；真实影响屏幕显示，需确认。",
    riskLevel: "device_action",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        durationSec: { type: "integer", default: 600 },
        deviceId: { type: "string" },
        deviceIds: { type: "array", items: { type: "string" } },
        clusterIds: { type: "array", items: { type: "string" } },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const target = resolveTargets(state, actor, params);
      const results = [];
      await updateState((draft) => {
        ensureShape(draft);
        target.targetIds.forEach((deviceId) => {
          const ack = queueDeviceCommand(draft, actor, deviceId, "remote.show_text", {
            text: text(params.text),
            durationSec: Math.max(10, Number(params.durationSec || 600)),
            announcementMode: "fullscreen",
          }, "mcp.announcement");
          results.push({ deviceId, commandId: ack.commandId });
        });
      });
      return { requestedCount: target.requestedCount, successCount: results.length, failed: target.denied, results };
    },
  },
  {
    name: "ink_remote_project_image",
    title: "远程图片投屏",
    description: "向设备投屏已存在的图片或文件。调用建议：使用 imageId 或 tfFileId；上传新图片请先走相册上传/导入。",
    riskLevel: "device_action",
    inputSchema: {
      type: "object",
      properties: {
        imageId: { type: "string" },
        tfFileId: { type: "string" },
        deviceId: { type: "string" },
        deviceIds: { type: "array", items: { type: "string" } },
        clusterIds: { type: "array", items: { type: "string" } },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const target = resolveTargets(state, actor, params);
      const image = params.imageId ? (state.imageAssets || []).find((item) => text(item.id) === text(params.imageId)) : null;
      const tfFileId = text(params.tfFileId || image?.tfFileId || image?.originalTfFileId);
      if (!tfFileId && !image) throwToolError("IMAGE_REQUIRED", "请提供 imageId 或 tfFileId");
      const results = [];
      await updateState((draft) => {
        ensureShape(draft);
        target.targetIds.forEach((deviceId) => {
          const ack = queueDeviceCommand(draft, actor, deviceId, "remote.show_image_asset", {
            imageId: text(image?.id),
            fileId: tfFileId,
            downloadUrl: tfFileId ? `/api/hardware/tf/download/${tfFileId}` : "",
          }, "mcp.project_image");
          results.push({ deviceId, commandId: ack.commandId, imageId: text(image?.id), tfFileId });
        });
      });
      return { requestedCount: target.requestedCount, successCount: results.length, failed: target.denied, results };
    },
  },
  {
    name: "ink_nameplate_push",
    title: "修改并推送桌牌",
    description: "推送桌牌姓名/标题到单台、多台或设备池。调用建议：需要 name，可选 title/layoutId；真实影响屏幕，需确认。",
    riskLevel: "device_action",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        layoutId: { type: "string" },
        deviceId: { type: "string" },
        deviceIds: { type: "array", items: { type: "string" } },
        clusterIds: { type: "array", items: { type: "string" } },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const target = resolveTargets(state, actor, params);
      const results = [];
      await updateState((draft) => {
        ensureShape(draft);
        target.targetIds.forEach((deviceId) => {
          const history = {
            id: createId("nph"),
            ownerId: text(actor.userId),
            deviceType: "ink-screen",
            layoutId: text(params.layoutId),
            name: text(params.name),
            title: text(params.title),
            targetDeviceIds: [deviceId],
            createdAt: nowIso(),
          };
          draft.nameplateHistory.unshift(history);
          const ack = queueDeviceCommand(draft, actor, deviceId, "nameplate.push", history, "mcp.nameplate_push");
          results.push({ deviceId, commandId: ack.commandId, historyId: history.id });
        });
      });
      return { requestedCount: target.requestedCount, successCount: results.length, failed: target.denied, results };
    },
  },
  {
    name: "ink_template_save",
    title: "新建或修改 API 模板",
    description: "查看/修改/新建 API 模板。调用建议：管理员使用；templateId 为空则新建，已有模板传 templateId。",
    riskLevel: "admin",
    inputSchema: {
      type: "object",
      required: ["name", "slug"],
      properties: {
        templateId: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
        method: { type: "string" },
        url: { type: "string" },
        enabled: { type: "boolean" },
        defaultParams: { type: "object" },
        advancedConfig: { type: "object" },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ params, actor, updateState }) => {
      assertAdmin(actor);
      let saved = null;
      await updateState((draft) => {
        ensureShape(draft);
        if (params.templateId) {
          saved = draft.apiTemplates.find((item) => text(item.id) === text(params.templateId));
          if (!saved) throwToolError("TEMPLATE_NOT_FOUND", "API模板不存在");
          ["name", "slug", "method", "url", "enabled", "defaultParams", "advancedConfig"].forEach((key) => {
            if (params[key] !== undefined) saved[key] = key === "method" ? text(params[key]).toUpperCase() : params[key];
          });
          saved.updatedAt = nowIso();
        } else {
          saved = {
            id: createId("tpl"),
            name: text(params.name),
            slug: text(params.slug),
            method: text(params.method || "GET").toUpperCase(),
            url: text(params.url),
            enabled: params.enabled !== false,
            defaultParams: params.defaultParams && typeof params.defaultParams === "object" ? params.defaultParams : {},
            advancedConfig: params.advancedConfig && typeof params.advancedConfig === "object" ? params.advancedConfig : {},
            builtin: false,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          draft.apiTemplates.unshift(saved);
        }
      });
      return saved;
    },
  },
  {
    name: "ink_log_list",
    title: "查询日志",
    description: "查询操作日志或 API 日志。调用建议：排查推送、模板刷新、AI 操作失败时使用；管理员可用。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["operation", "api"], default: "operation" },
        keyword: { type: "string" },
        limit: { type: "integer", default: 100 },
      },
    },
    handler: async ({ state, params, actor }) => {
      assertAdmin(actor);
      ensureShape(state);
      const source = params.type === "api" ? state.apiLogs : state.operationLogs;
      const keyword = text(params.keyword).toLowerCase();
      const rows = source
        .filter((item) => !keyword || JSON.stringify(item).toLowerCase().includes(keyword))
        .slice(0, Math.min(500, Number(params.limit || 100)));
      return { type: params.type === "api" ? "api" : "operation", rows, total: rows.length };
    },
  },
];
