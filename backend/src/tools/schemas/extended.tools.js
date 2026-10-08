const createId = require("../../utils/id");
const { findDeviceFromState } = require("../../repositories/device.repository");
const { createNvsService } = require("../../services/nvs/nvs.service");
const { createPlayCollectionService } = require("../../services/play_collection.service");
const { normalizeTaskPlan } = require("../../services/task_plan.service");
const { publishDeviceEvent } = require("../../utils/realtime.hub");

const nvsService = createNvsService();
const collectionService = createPlayCollectionService();

function text(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeLimit(value, fallback = 20, max = 100) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function ensureArray(state, key) {
  state[key] = Array.isArray(state[key]) ? state[key] : [];
  return state[key];
}

function ensureDevice(state, actor, deviceId) {
  const device = findDeviceFromState(state, actor, deviceId);
  if (!device) {
    const error = new Error("设备不存在或无权限");
    error.code = "DEVICE_NOT_FOUND";
    throw error;
  }
  return device;
}

function compactDevice(device = {}) {
  return {
    id: text(device.id || device.deviceId),
    name: text(device.displayName || device.name || device.remark || device.id),
    type: text(device.type || device.deviceType || "ink-screen"),
    online: Boolean(device.online || device.isOnline),
  };
}

function getLooseNvsValue(state, device, key) {
  const shadow = nvsService.getShadow(state, { role: "admin" }, device.id);
  if (key && shadow.values[key] !== undefined && shadow.values[key] !== "") return shadow.values[key];
  if (key && device.nvs && Object.prototype.hasOwnProperty.call(device.nvs, key)) return device.nvs[key];
  const record = (state.nvsRecords || []).find((item) => text(item.deviceId) === text(device.id) && text(item.key) === text(key));
  return record ? record.value : key ? "" : shadow.values;
}

function listByTime(rows = [], limit = 20) {
  return rows
    .slice()
    .sort((a, b) => text(b.createdAt || b.updatedAt).localeCompare(text(a.createdAt || a.updatedAt)))
    .slice(0, limit);
}

function compactTaskPlan(plan = {}) {
  return {
    id: text(plan.id),
    name: text(plan.name || plan.title),
    title: text(plan.title || plan.name),
    enabled: plan.enabled !== false && text(plan.status || "enabled") !== "disabled",
    status: text(plan.status || (plan.enabled === false ? "disabled" : "enabled")),
    nextRunAt: text(plan.nextRunAt),
    updatedAt: text(plan.updatedAt),
  };
}

function getPageRows(state, pageType = "homepage") {
  const type = text(pageType).toLowerCase();
  if (type === "badgepage" || type === "nameplate") return state.badgepageConfigs || [];
  if (type === "weatherpage") return state.weatherpageConfigs || [];
  return state.homepageConfigs || [];
}

module.exports = [
  {
    name: "ink_nvs_get",
    title: "查询设备 NVS",
    description: "读取设备 NVS shadow/config，可按 key 查询单项，也可返回设备全部可见 NVS 值。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      required: ["deviceId"],
      properties: {
        deviceId: { type: "string" },
        key: { type: "string" },
      },
    },
    handler: async ({ state, actor, params }) => {
      const device = ensureDevice(state, actor, params.deviceId);
      const key = text(params.key);
      const value = getLooseNvsValue(state, device, key);
      return key ? { deviceId: device.id, key, value } : { deviceId: device.id, values: value };
    },
  },
  {
    name: "ink_nvs_set",
    title: "写入设备 NVS",
    description: "写入设备 NVS shadow 并下发 nvs.write 事件，通常用于 Wi-Fi、服务器地址、开机显示模式等配置。",
    riskLevel: "device_write",
    inputSchema: {
      type: "object",
      required: ["deviceId", "key", "value"],
      properties: {
        deviceId: { type: "string" },
        key: { type: "string" },
        value: {},
        reboot: { type: "boolean", default: false },
        confirm: { type: "boolean" },
      },
    },
    handler: async ({ state, actor, params, updateState }) => {
      ensureDevice(state, actor, params.deviceId);
      let output = null;
      await updateState(async (draft) => {
        output = await nvsService.setValue(draft, actor, params.deviceId, {
          key: params.key,
          value: params.value,
          reboot: params.reboot === true,
        });
      });
      return output;
    },
  },
  {
    name: "ink_task_plan_list",
    title: "查询计划任务",
    description: "列出计划任务、下次运行时间、启用状态和最近更新时间。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    handler: async ({ state, params }) => {
      const keyword = text(params.keyword).toLowerCase();
      const limit = normalizeLimit(params.limit, 20, 100);
      const rows = (state.taskPlans || [])
        .filter((item) => {
          if (!keyword) return true;
          return [item.name, item.title, item.description, item.id].some((value) => text(value).toLowerCase().includes(keyword));
        })
        .map(compactTaskPlan);
      return { rows: listByTime(rows, limit), total: rows.length };
    },
  },
  {
    name: "ink_task_plan_save",
    title: "新建或修改计划任务",
    description: "保存计划任务定义。涉及真实设备后续自动执行，需用户确认后调用。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        planId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        enabled: { type: "boolean" },
        scheduleMode: { type: "string", enum: ["once", "weekly", "calendar"] },
        scheduleSpec: { type: "object" },
        targetDeviceIds: { type: "array", items: { type: "string" } },
        steps: { type: "array" },
        confirm: { type: "boolean" },
      },
    },
    handler: async ({ params, updateState }) => {
      let saved = null;
      await updateState((draft) => {
        const rows = ensureArray(draft, "taskPlans");
        const now = nowIso();
        const id = text(params.planId || params.id || createId("task"));
        const normalized = normalizeTaskPlan({ ...params, id, updatedAt: now }, now);
        const existing = rows.find((item) => text(item.id) === id);
        if (existing) Object.assign(existing, normalized, { updatedAt: now });
        else rows.unshift(normalized);
        saved = existing || normalized;
      });
      return compactTaskPlan(saved);
    },
  },
  {
    name: "ink_xique_sync_status",
    title: "查询喜鹊同步状态",
    description: "查询喜鹊课程表同步配置、最近状态和同步日志。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
      },
    },
    handler: async ({ state, params }) => {
      const deviceId = text(params.deviceId);
      const configs = (state.scheduleSyncConfigs || []).filter((item) => !deviceId || text(item.deviceId) === deviceId);
      const logs = (state.syncLogs || []).filter((item) => !deviceId || text(item.deviceId) === deviceId).slice(0, 20);
      return { configs, logs };
    },
  },
  {
    name: "ink_xique_sync_now",
    title: "立即同步喜鹊课表",
    description: "触发喜鹊课表同步。该操作可能访问外部教务系统并更新课程表，需用户确认。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["deviceId"],
      properties: {
        deviceId: { type: "string" },
        reason: { type: "string" },
        confirm: { type: "boolean" },
      },
    },
    handler: async ({ params, updateState }) => {
      let output = null;
      await updateState((draft) => {
        const rows = ensureArray(draft, "scheduleSyncConfigs");
        const cfg = rows.find((item) => text(item.deviceId) === text(params.deviceId));
        if (!cfg) {
          const error = new Error("喜鹊同步配置不存在");
          error.code = "XIQUE_CONFIG_NOT_FOUND";
          throw error;
        }
        cfg.lastAttemptAt = nowIso();
        cfg.lastSyncStatus = "queued";
        cfg.updatedAt = cfg.lastAttemptAt;
        ensureArray(draft, "syncLogs").unshift({
          id: createId("xslog"),
          configId: text(cfg.id),
          deviceId: text(cfg.deviceId),
          action: "mcp_sync_now",
          status: "queued",
          detail: { reason: text(params.reason || "mcp") },
          createdAt: nowIso(),
        });
        output = { deviceId: cfg.deviceId, configId: cfg.id, status: "queued" };
      });
      return output;
    },
  },
  {
    name: "ink_collection_push_to_device",
    title: "推送相册集合到设备",
    description: "将播放集合 manifest 推送给指定设备，设备会拉取相册资源并切换/更新相册显示。",
    riskLevel: "device_action",
    inputSchema: {
      type: "object",
      required: ["deviceId", "collectionId"],
      properties: {
        deviceId: { type: "string" },
        collectionId: { type: "string" },
        confirm: { type: "boolean" },
      },
    },
    handler: async ({ state, actor, params, updateState }) => {
      const event = collectionService.buildPushEvent(state, actor, {
        collectionId: params.collectionId,
        deviceId: params.deviceId,
      });
      await updateState((draft) => {
        const device = (draft.devices || []).find((item) => text(item.id) === text(params.deviceId));
        if (device) {
          device.currentPlayMode = "album";
          device.currentCollectionId = text(params.collectionId);
          device.lastDisplayCollectionId = text(params.collectionId);
          device.currentCollectionPushedAt = nowIso();
          device.updatedAt = nowIso();
        }
      });
      return publishDeviceEvent(event);
    },
  },
  {
    name: "ink_remote_command_list",
    title: "查询远控命令",
    description: "查询远控/设备命令队列和 ACK 状态。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    handler: async ({ state, params }) => {
      const deviceId = text(params.deviceId);
      const limit = normalizeLimit(params.limit, 20, 100);
      const rows = [...(state.remoteCommandAcks || []), ...(state.remoteCommands || [])]
        .filter((item) => !deviceId || text(item.deviceId) === deviceId);
      return { rows: listByTime(rows, limit), total: rows.length };
    },
  },
  {
    name: "ink_homepage_config_get",
    title: "查询主页/桌牌配置",
    description: "按 pageType 查询主页、桌牌或天气页配置。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        pageType: { type: "string", default: "homepage" },
      },
    },
    handler: async ({ state, params }) => {
      const deviceId = text(params.deviceId);
      const rows = getPageRows(state, params.pageType).filter((item) => !deviceId || text(item.deviceId) === deviceId);
      return deviceId ? rows[0] || null : rows;
    },
  },
  {
    name: "ink_nameplate_history_list",
    title: "查询桌牌历史",
    description: "查询桌牌/nameplate 渲染或批量生成历史。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    handler: async ({ state, params }) => {
      const deviceId = text(params.deviceId);
      const limit = normalizeLimit(params.limit, 20, 100);
      const rows = (state.nameplateHistory || []).filter((item) => !deviceId || text(item.deviceId) === deviceId);
      return { rows: listByTime(rows, limit), total: rows.length };
    },
  },
  {
    name: "ink_log_list",
    title: "查询系统日志",
    description: "查询 operation/api/sync 三类后端日志。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["operation", "api", "sync"], default: "operation" },
        keyword: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    handler: async ({ state, params }) => {
      const type = text(params.type || "operation");
      const source = type === "api" ? "apiLogs" : type === "sync" ? "syncLogs" : "operationLogs";
      const keyword = text(params.keyword).toLowerCase();
      const limit = normalizeLimit(params.limit, 20, 100);
      const rows = (state[source] || []).filter((item) => {
        if (!keyword) return true;
        return JSON.stringify(item).toLowerCase().includes(keyword);
      });
      return { rows: listByTime(rows, limit), total: rows.length, type };
    },
  },
];
