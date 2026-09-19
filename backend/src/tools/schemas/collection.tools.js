const createId = require("../../utils/id");
const { findDeviceFromState, getVisibleDevices, listDevicesFromState } = require("../../repositories/device.repository");
const { createPendingAck } = require("../../utils/remoteAck");
const { publishDeviceEvent } = require("../../utils/realtime.hub");
const {
  DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC,
  createPlayCollectionService,
} = require("../../services/play_collection.service");
const { createNvsService } = require("../../services/nvs/nvs.service");

const collectionService = createPlayCollectionService();
const nvsService = createNvsService();
const DISPLAY_MODES = new Set(["homepage", "album", "single", "sleep"]);
const DISPLAY_MODE_ALIASES = {
  home: "homepage",
  homepage: "homepage",
  album: "album",
  single: "single",
  single_image: "single",
  sleep: "sleep",
};
const HARDWARE_DISPLAY_MODE = {
  homepage: "home",
  album: "album",
  single: "single_image",
  sleep: "sleep",
};

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value || "").trim();
}

function norm(value) {
  return text(value).toLowerCase();
}

function normalizeLimit(value, fallback, max) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function ensureArrayContainer(state, key) {
  state[key] = Array.isArray(state[key]) ? state[key] : [];
  return state[key];
}

function displayDeviceName(device = {}) {
  return text(device.displayName || device.name || device.remark || device.id);
}

function compactDevice(device = {}) {
  return {
    id: text(device.id || device.deviceId),
    name: displayDeviceName(device),
    displayName: text(device.displayName),
    remark: text(device.remark),
    type: text(device.type || "ink-screen"),
    online: Boolean(device.online || device.isOnline),
  };
}

function compactCollection(collection = {}) {
  const itemCount = Number(collection.itemCount ?? collection.imageCount ?? 0);
  return {
    id: text(collection.id),
    name: text(collection.name),
    description: text(collection.description),
    status: text(collection.status || "enabled"),
    playMode: text(collection.playMode || "slideshow"),
    slideIntervalSec: Number(collection.slideIntervalSec || DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC),
    itemCount,
    imageCount: itemCount,
    updatedAt: text(collection.updatedAt),
  };
}

function throwToolError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  throw error;
}

function scoreName(candidate = "", query = "") {
  const c = norm(candidate);
  const q = norm(query);
  if (!c || !q) return 0;
  if (c === q) return 1;
  if (c.startsWith(q) || q.startsWith(c)) return 0.9;
  if (c.includes(q) || q.includes(c)) return 0.75;
  return 0;
}

function resolveSingleDevice(state, actor, params = {}) {
  const deviceId = text(params.deviceId);
  if (deviceId) {
    const device = findDeviceFromState(state, actor, deviceId);
    if (!device) throwToolError("DEVICE_NOT_FOUND", "设备不存在或无权限");
    return device;
  }

  const deviceName = text(params.deviceName);
  if (!deviceName) throwToolError("BAD_PARAMS", "请提供 deviceName 或 deviceId");

  const visible = getVisibleDevices(state, actor);
  const exact = visible.filter((device) =>
    [device.displayName, device.name, device.remark, device.id, device.deviceId, device.mac].some((value) => norm(value) === norm(deviceName))
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throwToolError("DEVICE_AMBIGUOUS", "找到多个同名设备，请使用 deviceId 精确指定", {
      candidates: exact.map(compactDevice),
    });
  }

  const page = listDevicesFromState(state, { auth: actor, keyword: deviceName, page: 1, pageSize: 10 });
  const matches = page.rows || [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throwToolError("DEVICE_AMBIGUOUS", "找到多个匹配设备，请使用 deviceId 精确指定", {
      candidates: matches.map(compactDevice),
    });
  }
  throwToolError("DEVICE_NOT_FOUND", "设备不存在或无权限");
}

function visibleCollections(state, actor, options = {}) {
  const includeDisabled = Boolean(options.includeDisabled);
  const keyword = norm(options.keyword);
  return collectionService
    .listCollections(state, actor)
    .filter((collection) => includeDisabled || text(collection.status || "enabled") !== "disabled")
    .filter((collection) => {
      if (!keyword) return true;
      return [collection.name, collection.description, collection.id].some((value) => norm(value).includes(keyword));
    });
}

function findCollectionMatches(state, actor, name, options = {}) {
  const query = text(name);
  const limit = normalizeLimit(options.limit, 5, 20);
  return visibleCollections(state, actor, { includeDisabled: options.includeDisabled })
    .map((collection) => ({
      ...collection,
      score: Math.max(scoreName(collection.name, query), scoreName(collection.description, query), scoreName(collection.id, query)),
    }))
    .filter((collection) => collection.score > 0)
    .sort((a, b) => b.score - a.score || text(b.updatedAt).localeCompare(text(a.updatedAt)))
    .slice(0, limit);
}

function resolveSingleCollection(state, actor, params = {}) {
  const collectionId = text(params.collectionId);
  if (collectionId) {
    const collection = collectionService.getCollection(state, actor, collectionId);
    if (text(collection.status || "enabled") === "disabled") {
      throwToolError("COLLECTION_DISABLED", "播放集合已停用，不能切换到该集合");
    }
    return collection;
  }

  const collectionName = text(params.collectionName || params.name);
  if (!collectionName) throwToolError("BAD_PARAMS", "请提供 collectionName 或 collectionId");

  const matches = findCollectionMatches(state, actor, collectionName, { limit: 10 });
  const exact = matches.filter((collection) => norm(collection.name) === norm(collectionName));
  const candidates = exact.length ? exact : matches;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throwToolError("COLLECTION_AMBIGUOUS", "找到多个匹配播放集合，请使用 collectionId 精确指定", {
      candidates: candidates.map(compactCollection),
    });
  }
  throwToolError("COLLECTION_NOT_FOUND", "播放集合不存在或无权限");
}

function normalizeDisplayMode(mode) {
  const normalized = DISPLAY_MODE_ALIASES[norm(mode)] || "";
  if (!DISPLAY_MODES.has(normalized)) {
    throwToolError("BAD_PARAMS", "mode不支持，允许: homepage/album/single/sleep");
  }
  return normalized;
}

function currentDisplayMode(device = {}) {
  const raw = text(device.currentDisplayMode || device.displayMode || device.defaultView || "homepage");
  return DISPLAY_MODE_ALIASES[norm(raw)] || (norm(raw) === "home" ? "homepage" : raw || "homepage");
}

function currentBootDisplayMode(device = {}) {
  const raw = text(device.bootDisplayMode || device.defaultDisplayMode || device.defaultView || "homepage");
  return DISPLAY_MODE_ALIASES[norm(raw)] || raw || "homepage";
}

function normalizeBootDisplayMode(mode) {
  const normalized = normalizeDisplayMode(mode);
  if (!["homepage", "album"].includes(normalized)) {
    throwToolError("BAD_PARAMS", "开机默认显示模式仅支持 homepage/album");
  }
  return normalized;
}

function getDisplayState(state, actor, params = {}) {
  const device = resolveSingleDevice(state, actor, params);
  const collectionId = text(device.currentCollectionId || device.lastDisplayCollectionId);
  const collection = collectionId
    ? visibleCollections(state, actor, { includeDisabled: true }).find((item) => text(item.id) === collectionId)
    : null;
  return {
    device: compactDevice(device),
    display: {
      currentDisplayMode: currentDisplayMode(device),
      bootDisplayMode: currentBootDisplayMode(device),
      currentCollectionId: collectionId,
      currentCollectionName: collection ? text(collection.name) : "",
      currentHomeAssetId: text(device.currentHomeAssetId || device.lastDisplayImageId),
    },
  };
}

function appendOperationLog(draft, actor, action, targetId, detail) {
  const logs = ensureArrayContainer(draft, "operationLogs");
  logs.unshift({
    id: createId("oplog"),
    actorId: text(actor?.userId || "mcp"),
    actorRole: text(actor?.role || "mcp"),
    action,
    targetType: "device",
    targetId,
    detail,
    status: "success",
    createdAt: nowIso(),
  });
  if (logs.length > 5000) logs.splice(5000);
}

async function updateDeviceDisplayState({ updateState, actor, device, mode, collection, setAsBootDefault, action }) {
  if (typeof updateState !== "function") return { commandRows: [] };

  const commandRows = [];
  await updateState((draft) => {
    const devices = ensureArrayContainer(draft, "devices");
    const row = devices.find((item) => text(item.id || item.deviceId) === text(device.id || device.deviceId));
    if (!row) throwToolError("DEVICE_NOT_FOUND", "设备不存在或无权限");

    row.currentDisplayMode = mode;
    if (collection) {
      row.currentCollectionId = collection.id;
      row.currentPlayMode = collection.playMode || row.currentPlayMode || "";
      row.lastDisplayCollectionId = collection.id;
    }
    if (setAsBootDefault) {
      row.bootDisplayMode = mode === "album" ? "album" : mode;
    }
    row.updatedAt = nowIso();

    const displayAck = createPendingAck(draft, {
      deviceId: row.id,
      eventType: "display.set",
      source: action,
      operatorId: actor?.userId || "",
      operatorRole: actor?.role || "",
      meta: {
        displayMode: mode,
        collectionId: collection?.id || row.currentCollectionId || "",
        setAsBootDefault: Boolean(setAsBootDefault),
      },
    });
    commandRows.push(displayAck);

    if (collection) {
      const collectionAck = createPendingAck(draft, {
        deviceId: row.id,
        eventType: "collection.push",
        source: action,
        operatorId: actor?.userId || "",
        operatorRole: actor?.role || "",
        meta: {
          collectionId: collection.id,
          collectionName: collection.name,
        },
      });
      commandRows.push(collectionAck);
    }

    appendOperationLog(draft, actor, action, row.id, {
      displayMode: mode,
      collectionId: collection?.id || row.currentCollectionId || "",
      collectionName: collection?.name || "",
      setAsBootDefault: Boolean(setAsBootDefault),
    });
  });

  return { commandRows };
}

function publishDisplayEvent({ device, mode, collection, commandId, setAsBootDefault, renderHomeNow }) {
  return publishDeviceEvent({
    type: "display.set",
    deviceId: text(device.id || device.deviceId),
    payload: {
      commandId,
      mode: HARDWARE_DISPLAY_MODE[mode] || mode,
      displayMode: mode,
      collectionId: collection?.id || "",
      collectionName: collection?.name || "",
      setAsBootDefault: Boolean(setAsBootDefault),
      renderHomeNow: Boolean(renderHomeNow),
      requestedAt: nowIso(),
    },
  });
}

function publishBootDisplayEvent({ device, mode, commandId }) {
  return publishDeviceEvent({
    type: "display.set_boot_mode",
    deviceId: text(device.id || device.deviceId),
    payload: {
      commandId,
      mode: HARDWARE_DISPLAY_MODE[mode] || mode,
      bootMode: mode,
      requestedAt: nowIso(),
    },
  });
}

function publishCollectionPushEvent({ state, actor, device, collection, commandId, baseUrl }) {
  const event = collectionService.buildPushEvent(state, actor, {
    collectionId: collection.id,
    deviceId: device.id,
    baseUrl: baseUrl || "",
  });
  return publishDeviceEvent({
    ...event,
    payload: {
      ...event.payload,
      commandId,
      collectionName: collection.name,
      requestedAt: nowIso(),
    },
  });
}

async function switchDisplayMode({ state, actor, params, updateState, action }) {
  const mode = normalizeDisplayMode(params.mode);
  const device = resolveSingleDevice(state, actor, params);
  const collection =
    mode === "album" && (text(params.collectionId) || text(params.collectionName))
      ? resolveSingleCollection(state, actor, params)
      : null;

  const { commandRows } = await updateDeviceDisplayState({
    updateState,
    actor,
    device,
    mode,
    collection,
    setAsBootDefault: params.setAsBootDefault === true,
    action,
  });
  const displayCommand = commandRows.find((row) => row.eventType === "display.set");
  const collectionCommand = commandRows.find((row) => row.eventType === "collection.push");
  const events = [];
  if (collection) {
    events.push(
      publishCollectionPushEvent({
        state,
        actor,
        device,
        collection,
        commandId: collectionCommand?.commandId || displayCommand?.commandId || "",
        baseUrl: params.baseUrl,
      })
    );
  }
  events.push(
    publishDisplayEvent({
      device,
      mode,
      collection,
      commandId: displayCommand?.commandId || "",
      setAsBootDefault: params.setAsBootDefault === true,
      renderHomeNow: params.renderHomeNow === true,
    })
  );

  return {
    taskId: displayCommand?.commandId || createId("display_task"),
    status: "queued",
    device: compactDevice(device),
    displayMode: mode,
    collection: collection ? compactCollection(collection) : null,
    events: events.map((event) => ({ eventId: event.eventId, type: event.type, deviceId: event.deviceId })),
  };
}

async function setBootDisplayMode({ state, actor, params, updateState }) {
  const mode = normalizeBootDisplayMode(params.mode);
  const device = resolveSingleDevice(state, actor, params);
  const syncNvs = params.syncNvs !== false;
  let displayCommand = null;
  let nvsResult = null;

  if (typeof updateState === "function") {
    await updateState(async (draft) => {
      const devices = ensureArrayContainer(draft, "devices");
      const row = devices.find((item) => text(item.id || item.deviceId) === text(device.id || device.deviceId));
      if (!row) throwToolError("DEVICE_NOT_FOUND", "设备不存在或无权限");

      row.bootDisplayMode = mode;
      row.defaultDisplayMode = mode;
      row.updatedAt = nowIso();
      displayCommand = createPendingAck(draft, {
        deviceId: row.id,
        eventType: "display.set_boot_mode",
        source: "mcp.device.set_boot_display_mode",
        operatorId: actor?.userId || "",
        operatorRole: actor?.role || "",
        meta: { bootMode: mode },
      });

      appendOperationLog(draft, actor, "mcp.device.set_boot_display_mode", row.id, {
        bootDisplayMode: mode,
        syncNvs,
      });

      if (syncNvs) {
        nvsResult = await nvsService.setValue(draft, actor, row.id, {
          key: "boot_mode",
          value: mode,
          reboot: true,
        });
      }
    });
  }

  const bootEvent = publishBootDisplayEvent({
    device,
    mode,
    commandId: displayCommand?.commandId || "",
  });

  return {
    taskId: displayCommand?.commandId || createId("boot_display_task"),
    status: "queued",
    device: compactDevice(device),
    bootDisplayMode: mode,
    syncNvs,
    nvsCommandId: nvsResult?.commandId || "",
    events: [{ eventId: bootEvent.eventId, type: bootEvent.type, deviceId: bootEvent.deviceId }],
  };
}

module.exports = [
  {
    name: "ink_collection_list",
    title: "查询播放集合列表",
    description: "列出当前用户可访问的播放集合，可按集合名称或描述搜索。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "按集合名称、描述或集合 ID 搜索；不填则返回最近更新的集合。" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "返回数量上限，默认 20，最大 100。" },
        includeDisabled: { type: "boolean", default: false, description: "是否包含已停用集合；默认 false。" },
      },
    },
    handler: async ({ state, params, actor }) => {
      const limit = normalizeLimit(params.limit, 20, 100);
      const collections = visibleCollections(state, actor, params).slice(0, limit).map(compactCollection);
      return { collections, total: collections.length };
    },
  },
  {
    name: "ink_collection_find",
    title: "按名称查找播放集合",
    description: "根据用户说出的集合名称查找候选播放集合，供后续切换集合或相册模式使用。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "用户提到的集合名称，例如：家庭相册、春节照片、公司宣传图。" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "候选集合数量，默认 5，最大 20。" },
      },
    },
    handler: async ({ state, params, actor }) => {
      const matches = findCollectionMatches(state, actor, params.name, { limit: params.limit }).map((collection) => ({
        ...compactCollection(collection),
        score: collection.score,
      }));
      return {
        matches,
        needDisambiguation: matches.length > 1 && matches[0].score === matches[1].score,
        message: matches.length ? "ok" : "没有找到匹配的播放集合",
      };
    },
  },
  {
    name: "ink_device_get_display_state",
    title: "查询设备显示状态",
    description: "按设备 ID 或设备名称查询当前显示模式、当前播放集合和开机默认显示模式。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "目标设备 ID；如果用户只说了设备名称，可改用 deviceName。" },
        deviceName: { type: "string", description: "目标设备名称、备注或位置，例如：客厅 E6 相框、卧室屏幕。" },
      },
    },
    handler: async ({ state, params, actor }) => getDisplayState(state, actor, params),
  },
  {
    name: "ink_device_switch_collection",
    title: "切换设备播放集合",
    description: "按设备名称和集合名称将单台设备切换到指定播放集合，并进入相册显示模式。该操作会影响真实设备，必须确认后执行。",
    riskLevel: "device_write",
    inputSchema: {
      type: "object",
      required: ["deviceName", "collectionName"],
      properties: {
        deviceId: { type: "string", description: "目标设备 ID；可选。若有 deviceName，系统会按设备名称解析单台设备。" },
        deviceName: { type: "string", description: "目标设备名称、备注或位置，例如：客厅 E6 相框。必须能唯一匹配一台设备。" },
        collectionId: { type: "string", description: "播放集合 ID；可选。若有 collectionName，系统会按集合名称解析。" },
        collectionName: { type: "string", description: "播放集合名称，例如：家庭相册、春节照片。必须能唯一匹配一个集合。" },
        setAsCurrent: { type: "boolean", default: true, description: "是否立即切换为当前播放集合；默认 true。" },
        setAsBootDefault: { type: "boolean", default: false, description: "是否同时设置开机默认显示为相册；默认 false。" },
        forceResync: { type: "boolean", default: false, description: "是否强制设备重新同步集合资源；默认 false，本工具会通过 collection.push 事件通知设备拉取 manifest。" },
        baseUrl: { type: "string", description: "可选的后端公开地址，用于生成集合 manifest URL；不填时使用相对路径。" },
        confirm: { type: "boolean", description: "确认执行开关。首次调用不要传；用户确认后再次调用并设为 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const device = resolveSingleDevice(state, actor, params);
      const collection = resolveSingleCollection(state, actor, params);
      const nextParams = {
        ...params,
        deviceId: device.id,
        collectionId: collection.id,
        mode: "album",
      };
      const result = await switchDisplayMode({
        state,
        actor,
        params: nextParams,
        updateState,
        action: "mcp.device.switch_collection",
      });
      return {
        ...result,
        collection: compactCollection(collection),
        displayMode: "album",
        setAsCurrent: params.setAsCurrent !== false,
        forceResync: Boolean(params.forceResync),
      };
    },
  },
  {
    name: "ink_device_switch_display_mode",
    title: "切换设备显示模式",
    description: "将单台设备切换到 homepage、album、single 或 sleep 显示模式，特别适用于 E6 的主页/相册切换。该操作会影响真实设备，必须确认后执行。",
    riskLevel: "device_write",
    inputSchema: {
      type: "object",
      required: ["deviceName", "mode"],
      properties: {
        deviceId: { type: "string", description: "目标设备 ID；可选。若有 deviceName，系统会按设备名称解析单台设备。" },
        deviceName: { type: "string", description: "目标设备名称、备注或位置，例如：客厅 E6 相框。必须能唯一匹配一台设备。" },
        mode: {
          type: "string",
          enum: ["homepage", "album", "single", "sleep", "home", "single_image"],
          description: "目标显示模式：homepage=主页，album=相册，single=单图，sleep=休眠；兼容 home 和 single_image。",
        },
        collectionId: { type: "string", description: "切换到 album 时可指定播放集合 ID；可选。" },
        collectionName: { type: "string", description: "切换到 album 时可指定播放集合名称，例如：家庭相册；可选。" },
        renderHomeNow: { type: "boolean", default: false, description: "切换到 homepage 时是否要求设备/后端立即刷新主页；默认 false。" },
        setAsBootDefault: { type: "boolean", default: false, description: "是否同时设置为开机默认显示模式；默认 false。" },
        baseUrl: { type: "string", description: "可选的后端公开地址，用于 album 集合 manifest URL。" },
        confirm: { type: "boolean", description: "确认执行开关。首次调用不要传；用户确认后再次调用并设为 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) =>
      switchDisplayMode({
        state,
        actor,
        params,
        updateState,
        action: "mcp.device.switch_display_mode",
      }),
  },
  {
    name: "ink_device_set_boot_display_mode",
    title: "设置设备开机默认显示模式",
    description: "设置单台设备开机后的默认显示模式，并可同步写入 E6 NVS boot_mode。该操作会影响真实设备，必须确认后执行。",
    riskLevel: "device_write",
    inputSchema: {
      type: "object",
      required: ["deviceName", "mode"],
      properties: {
        deviceId: { type: "string", description: "目标设备 ID；可选。若有 deviceName，系统会按设备名称解析单台设备。" },
        deviceName: { type: "string", description: "目标设备名称、备注或位置，例如：客厅 E6 相框。必须能唯一匹配一台设备。" },
        mode: {
          type: "string",
          enum: ["homepage", "album", "home"],
          description: "开机默认显示模式：homepage=主页，album=相册；兼容 home。",
        },
        syncNvs: { type: "boolean", default: true, description: "是否同步写入 NVS boot_mode；默认 true。" },
        confirm: { type: "boolean", description: "确认执行开关。首次调用不要传；用户确认后再次调用并设为 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) =>
      setBootDisplayMode({
        state,
        actor,
        params,
        updateState,
      }),
  },
  {
    name: "ink_device_switch_home",
    title: "切换设备到主页",
    description: "将单台设备切换到主页显示模式，可选择立即刷新主页。该操作会影响真实设备，必须确认后执行。",
    riskLevel: "device_write",
    inputSchema: {
      type: "object",
      required: ["deviceName"],
      properties: {
        deviceId: { type: "string", description: "目标设备 ID；可选。若有 deviceName，系统会按设备名称解析单台设备。" },
        deviceName: { type: "string", description: "目标设备名称、备注或位置，例如：客厅 E6 相框。必须能唯一匹配一台设备。" },
        renderHomeNow: { type: "boolean", default: false, description: "是否要求设备/后端立即刷新主页；默认 false。" },
        setAsBootDefault: { type: "boolean", default: false, description: "是否同时设置为开机默认主页；默认 false。" },
        confirm: { type: "boolean", description: "确认执行开关。首次调用不要传；用户确认后再次调用并设为 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) =>
      switchDisplayMode({
        state,
        actor,
        params: { ...params, mode: "homepage" },
        updateState,
        action: "mcp.device.switch_home",
      }),
  },
  {
    name: "ink_device_switch_album",
    title: "切换设备到相册",
    description: "将单台设备切换到相册显示模式，并可指定播放集合。该操作会影响真实设备，必须确认后执行。",
    riskLevel: "device_write",
    inputSchema: {
      type: "object",
      required: ["deviceName", "collectionName"],
      properties: {
        deviceId: { type: "string", description: "目标设备 ID；可选。若有 deviceName，系统会按设备名称解析单台设备。" },
        deviceName: { type: "string", description: "目标设备名称、备注或位置，例如：客厅 E6 相框。必须能唯一匹配一台设备。" },
        collectionId: { type: "string", description: "播放集合 ID；可选。若有 collectionName，系统会按集合名称解析。" },
        collectionName: { type: "string", description: "播放集合名称，例如：家庭相册。必须能唯一匹配一个集合。" },
        setAsBootDefault: { type: "boolean", default: false, description: "是否同时设置为开机默认相册；默认 false。" },
        baseUrl: { type: "string", description: "可选的后端公开地址，用于 album 集合 manifest URL。" },
        confirm: { type: "boolean", description: "确认执行开关。首次调用不要传；用户确认后再次调用并设为 true。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) =>
      switchDisplayMode({
        state,
        actor,
        params: { ...params, mode: "album" },
        updateState,
        action: "mcp.device.switch_album",
      }),
  },
];
