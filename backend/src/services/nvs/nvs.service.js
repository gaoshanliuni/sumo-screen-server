const HttpError = require("../../utils/httpError");
const createId = require("../../utils/id");
const { findDeviceFromState } = require("../../repositories/device.repository");
const { createPendingAck } = require("../../utils/remoteAck");
const { publishDeviceEvent } = require("../../utils/realtime.hub");
const { encryptSecret, decryptSecret } = require("../ai/credential_crypto.service");

const DEVICE_TYPE_E6 = "e6-color-frame";
const MASK = "********";

const E6_SCHEMA = [
  { namespace: "wifi", key: "wifi_ssid", type: "string", description: "Wi-Fi SSID", required: false, secret: false, rebootRequired: true },
  { namespace: "wifi", key: "wifi_password", type: "string", description: "Wi-Fi password", required: false, secret: true, rebootRequired: true },
  { namespace: "net", key: "server_url", type: "string", description: "Active platform backend URL", required: true, secret: false, rebootRequired: true },
  { namespace: "net", key: "lan_server_url", type: "string", description: "Preferred LAN backend URL", required: false, secret: false, rebootRequired: true },
  { namespace: "net", key: "wan_server_url", type: "string", description: "Fallback public backend URL", required: false, secret: false, rebootRequired: true },
  { namespace: "net", key: "active_server_profile", type: "enum", values: ["lan", "wan"], description: "Currently selected backend profile", required: false, secret: false, rebootRequired: true },
  {
    namespace: "display",
    key: "display_mode",
    type: "enum",
    values: ["homepage", "album", "single", "sleep"],
    description: "Current display mode",
    required: false,
    secret: false,
    rebootRequired: false,
  },
  {
    namespace: "display",
    key: "boot_mode",
    type: "enum",
    values: ["homepage", "album"],
    description: "Boot default display mode",
    required: false,
    secret: false,
    rebootRequired: true,
  },
  { namespace: "album", key: "album_collection_id", type: "string", description: "Default album collection ID", required: false, secret: false, rebootRequired: false },
  { namespace: "homepage", key: "homepage_id", type: "string", description: "Default homepage config ID", required: false, secret: false, rebootRequired: false },
  { namespace: "device", key: "device_type", type: "string", description: "Device type marker", required: true, secret: false, rebootRequired: true, readonly: true },
  { namespace: "firmware", key: "firmware_channel", type: "enum", values: ["stable", "beta", "dev"], description: "Firmware update channel", required: false, secret: false, rebootRequired: false },
];

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value || "").trim();
}

function ensureShape(state) {
  state.nvsShadows = Array.isArray(state.nvsShadows) ? state.nvsShadows : [];
  state.nvsBackups = Array.isArray(state.nvsBackups) ? state.nvsBackups : [];
  state.remoteCommandAcks = Array.isArray(state.remoteCommandAcks) ? state.remoteCommandAcks : [];
  state.operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getDeviceType(device = {}) {
  return text(device.type || device.deviceType || device.deviceTypeId || "ink-screen");
}

function getSchemaForDevice(device = {}) {
  if (getDeviceType(device) === DEVICE_TYPE_E6) return E6_SCHEMA;
  return E6_SCHEMA.map((item) => ({ ...item, description: item.description.replace(/^/, "Generic ESP32 / ") }));
}

function schemaByKey(device = {}) {
  return new Map(getSchemaForDevice(device).map((item) => [item.key, item]));
}

function getDeviceOrThrow(state, auth, deviceId) {
  const device = findDeviceFromState(state, auth, deviceId);
  if (!device) throw new HttpError(404, "设备不存在或无权限");
  return device;
}

function normalizeValue(meta = {}, value) {
  if (value === undefined || value === null) return "";
  if (meta.type === "enum") {
    const raw = text(value);
    if (Array.isArray(meta.values) && !meta.values.includes(raw)) {
      throw new HttpError(400, `${meta.key}仅支持: ${meta.values.join("/")}`);
    }
    return raw;
  }
  if (meta.type === "bool") return Boolean(value);
  if (meta.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new HttpError(400, `${meta.key}必须是数字`);
    return n;
  }
  return String(value);
}

function encodeShadowValue(meta, value) {
  const normalized = normalizeValue(meta, value);
  if (meta.secret) {
    return { value: "", encryptedValue: normalized ? encryptSecret(normalized) : "" };
  }
  return { value: normalized, encryptedValue: "" };
}

function decodeShadowValue(row = {}, meta = {}) {
  if (meta.secret) return row.encryptedValue ? decryptSecret(row.encryptedValue) : "";
  return row.value;
}

function redactValue(row = {}, meta = {}) {
  const value = decodeShadowValue(row, meta);
  if (meta.secret) return value ? MASK : "";
  return value;
}

function findShadowRow(state, deviceId, key) {
  return state.nvsShadows.find((item) => item.deviceId === deviceId && item.key === key) || null;
}

function buildShadowView(state, auth, deviceId) {
  ensureShape(state);
  const device = getDeviceOrThrow(state, auth, deviceId);
  const schema = getSchemaForDevice(device);
  const values = {};
  const items = schema.map((meta) => {
    const row = findShadowRow(state, device.id, meta.key);
    const value = row ? redactValue(row, meta) : "";
    values[meta.key] = value;
    return {
      ...meta,
      value,
      hasValue: row ? Boolean(decodeShadowValue(row, meta) !== "") : false,
      updatedAt: text(row?.updatedAt),
      pendingCommandId: text(row?.pendingCommandId),
    };
  });
  return {
    deviceId: device.id,
    deviceType: getDeviceType(device),
    items,
    values,
  };
}

function backupShadow(state, actor, device, clock, idFactory, reason) {
  const rows = state.nvsShadows.filter((item) => item.deviceId === device.id).map(clone);
  const backup = {
    id: idFactory("nvsbak"),
    deviceId: device.id,
    deviceType: getDeviceType(device),
    reason: text(reason || "write"),
    rows,
    createdBy: text(actor?.userId),
    createdAt: clock(),
  };
  state.nvsBackups.unshift(backup);
  if (state.nvsBackups.length > 1000) state.nvsBackups.splice(1000);
  return backup;
}

function appendOperationLog(state, actor, action, deviceId, detail, clock, idFactory) {
  const logs = state.operationLogs;
  logs.unshift({
    id: idFactory("oplog"),
    actorId: text(actor?.userId),
    actorRole: text(actor?.role),
    action,
    targetType: "device",
    targetId: text(deviceId),
    detail: detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {},
    status: "success",
    createdAt: clock(),
  });
  if (logs.length > 5000) logs.splice(5000);
}

function publishNvsWriteEvent(device, commandId, changedItems, reboot) {
  return publishDeviceEvent({
    type: "nvs.write",
    deviceId: device.id,
    payload: {
      commandId,
      deviceType: getDeviceType(device),
      items: changedItems.map((item) => ({
        namespace: item.namespace,
        key: item.key,
        type: item.type,
        value: item.secret ? undefined : item.value,
        encryptedValue: item.secret ? item.encryptedValue : undefined,
        secret: Boolean(item.secret),
        rebootRequired: Boolean(item.rebootRequired),
      })),
      reboot: Boolean(reboot),
      requestedAt: nowIso(),
    },
  });
}

function createNvsService(options = {}) {
  const clock = options.now || nowIso;
  const idFactory = options.idFactory || createId;

  function getSchema(state, auth, deviceId) {
    ensureShape(state);
    const device = getDeviceOrThrow(state, auth, deviceId);
    return {
      deviceId: device.id,
      deviceType: getDeviceType(device),
      adapter: getDeviceType(device) === DEVICE_TYPE_E6 ? "e6-nvs-shadow" : "esp32-nvs-shadow",
      items: getSchemaForDevice(device),
    };
  }

  function getShadow(state, auth, deviceId) {
    return buildShadowView(state, auth, deviceId);
  }

  async function applyValues(state, auth, deviceId, rawItems, optionsForWrite = {}) {
    ensureShape(state);
    const device = getDeviceOrThrow(state, auth, deviceId);
    const schemaMap = schemaByKey(device);
    const items = Array.isArray(rawItems) ? rawItems : [];
    if (!items.length) throw new HttpError(400, "NVS写入项不能为空");
    backupShadow(state, auth, device, clock, idFactory, optionsForWrite.reason || "write");

    const now = clock();
    const changedItems = [];
    items.forEach((input) => {
      const key = text(input.key);
      const meta = schemaMap.get(key);
      if (!meta) throw new HttpError(400, `不支持的NVS key: ${key}`);
      if (meta.readonly && input.force !== true) throw new HttpError(400, `${key}为只读项`);
      const encoded = encodeShadowValue(meta, input.value);
      let row = findShadowRow(state, device.id, key);
      if (!row) {
        row = {
          id: idFactory("nvs"),
          deviceId: device.id,
          deviceType: getDeviceType(device),
          namespace: meta.namespace,
          key,
          type: meta.type,
          value: "",
          encryptedValue: "",
          pendingCommandId: "",
          createdAt: now,
          updatedAt: now,
        };
        state.nvsShadows.unshift(row);
      }
      row.deviceType = getDeviceType(device);
      row.namespace = meta.namespace;
      row.type = meta.type;
      row.value = encoded.value;
      row.encryptedValue = encoded.encryptedValue;
      row.updatedAt = now;
      changedItems.push({
        ...meta,
        value: normalizeValue(meta, input.value),
        encryptedValue: meta.secret ? encoded.encryptedValue : "",
      });
    });

    const ack = createPendingAck(state, {
      deviceId: device.id,
      eventType: "nvs.write",
      source: "nvs.adapter",
      operatorId: auth?.userId || "",
      operatorRole: auth?.role || "",
      meta: {
        keys: changedItems.map((item) => item.key),
        reboot: Boolean(optionsForWrite.reboot),
      },
    });
    state.nvsShadows
      .filter((item) => item.deviceId === device.id && changedItems.some((changed) => changed.key === item.key))
      .forEach((row) => {
        row.pendingCommandId = ack.commandId;
      });
    appendOperationLog(
      state,
      auth,
      "nvs.write",
      device.id,
      { keys: changedItems.map((item) => item.key), reboot: Boolean(optionsForWrite.reboot), reason: text(optionsForWrite.reason || "write") },
      clock,
      idFactory
    );
    publishNvsWriteEvent(device, ack.commandId, changedItems, optionsForWrite.reboot);
    return { deviceId: device.id, commandId: ack.commandId, updated: changedItems.length, items: buildShadowView(state, auth, device.id).items };
  }

  async function setValue(state, auth, deviceId, payload = {}) {
    const result = await applyValues(state, auth, deviceId, [payload], { reboot: payload.reboot === true, reason: "set" });
    const item = result.items.find((row) => row.key === payload.key);
    return { ...item, commandId: result.commandId };
  }

  async function importDeviceConfig(state, auth, deviceId, payload = {}) {
    return applyValues(state, auth, deviceId, payload.items || [], { reboot: payload.reboot === true, reason: "import" });
  }

  function exportDeviceConfig(state, auth, deviceId) {
    const shadow = buildShadowView(state, auth, deviceId);
    return {
      deviceId: shadow.deviceId,
      deviceType: shadow.deviceType,
      exportedAt: clock(),
      items: shadow.items.map((item) => ({
        namespace: item.namespace,
        key: item.key,
        type: item.type,
        value: item.value,
        secret: Boolean(item.secret),
      })),
    };
  }

  function sanitizeBackupRows(device, rows = []) {
    const schemaMap = schemaByKey(device);
    return rows.map((row) => {
      const meta = schemaMap.get(text(row.key)) || {};
      return {
        id: text(row.id),
        deviceId: text(row.deviceId),
        deviceType: text(row.deviceType || getDeviceType(device)),
        namespace: text(row.namespace || meta.namespace),
        key: text(row.key),
        type: text(row.type || meta.type),
        value: meta.secret ? (row.encryptedValue ? MASK : "") : row.value,
        secret: Boolean(meta.secret),
        pendingCommandId: text(row.pendingCommandId),
        createdAt: text(row.createdAt),
        updatedAt: text(row.updatedAt),
      };
    });
  }

  function listBackups(state, auth, deviceId) {
    ensureShape(state);
    const device = getDeviceOrThrow(state, auth, deviceId);
    return state.nvsBackups
      .filter((backup) => text(backup.deviceId) === text(device.id))
      .slice()
      .sort((a, b) => text(b.createdAt).localeCompare(text(a.createdAt)))
      .map((backup) => {
        const rows = sanitizeBackupRows(device, backup.rows || []);
        return {
          id: text(backup.id),
          deviceId: text(backup.deviceId),
          deviceType: text(backup.deviceType || getDeviceType(device)),
          reason: text(backup.reason),
          createdBy: text(backup.createdBy),
          createdAt: text(backup.createdAt),
          keys: rows.map((row) => row.key).filter(Boolean),
          rowCount: rows.length,
          rows,
        };
      });
  }

  async function restoreBackup(state, auth, deviceId, backupId, optionsForRestore = {}) {
    ensureShape(state);
    const device = getDeviceOrThrow(state, auth, deviceId);
    const backup = state.nvsBackups.find((item) => text(item.id) === text(backupId) && text(item.deviceId) === text(device.id));
    if (!backup) throw new HttpError(404, "NVS备份不存在或无权限");

    backupShadow(state, auth, device, clock, idFactory, "restore");
    const now = clock();
    const schemaMap = schemaByKey(device);
    const restoredRows = (Array.isArray(backup.rows) ? backup.rows : [])
      .filter((row) => text(row.key))
      .map((row) => {
        const meta = schemaMap.get(text(row.key)) || {};
        return {
          ...clone(row),
          id: idFactory("nvs"),
          deviceId: device.id,
          deviceType: getDeviceType(device),
          namespace: text(row.namespace || meta.namespace),
          type: text(row.type || meta.type),
          pendingCommandId: "",
          createdAt: text(row.createdAt) || now,
          updatedAt: now,
        };
      });

    state.nvsShadows = state.nvsShadows.filter((row) => text(row.deviceId) !== text(device.id));
    state.nvsShadows.unshift(...restoredRows);

    const restoredKeys = restoredRows.map((row) => row.key);
    const ack = createPendingAck(state, {
      deviceId: device.id,
      eventType: "nvs.write",
      source: "nvs.restore",
      operatorId: auth?.userId || "",
      operatorRole: auth?.role || "",
      meta: {
        backupId: backup.id,
        keys: restoredKeys,
        reboot: Boolean(optionsForRestore.reboot),
      },
    });
    restoredRows.forEach((row) => {
      row.pendingCommandId = ack.commandId;
    });

    const changedItems = restoredRows.map((row) => {
      const meta = schemaMap.get(text(row.key)) || {};
      return {
        namespace: text(row.namespace || meta.namespace),
        key: text(row.key),
        type: text(row.type || meta.type),
        value: meta.secret ? "" : row.value,
        encryptedValue: meta.secret ? row.encryptedValue : "",
        secret: Boolean(meta.secret),
        rebootRequired: Boolean(meta.rebootRequired),
      };
    });
    appendOperationLog(
      state,
      auth,
      "nvs.restore",
      device.id,
      { backupId: backup.id, keys: restoredKeys, reboot: Boolean(optionsForRestore.reboot) },
      clock,
      idFactory
    );
    publishNvsWriteEvent(device, ack.commandId, changedItems, optionsForRestore.reboot);
    return {
      deviceId: device.id,
      backupId: backup.id,
      commandId: ack.commandId,
      restored: true,
      restoredKeys,
      items: buildShadowView(state, auth, device.id).items,
    };
  }

  return {
    getSchema,
    getShadow,
    setValue,
    importDeviceConfig,
    exportDeviceConfig,
    listBackups,
    restoreBackup,
  };
}

module.exports = {
  createNvsService,
  E6_SCHEMA,
};
