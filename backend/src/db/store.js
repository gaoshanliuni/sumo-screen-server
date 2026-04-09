const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const config = require("../config");
const createId = require("../utils/id");

let cache = null;
let pool = null;
let initialized = false;
let writeQueue = Promise.resolve();
let warnedReadFallback = false;
let warnedWriteFallback = false;
let forceCacheReads = false;
let dbRetryAfterTs = 0;

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

function buildLegacyAdvancedConfig(method, url) {
  return {
    output: "",
    timeoutMs: Number(config.requestTimeoutMs || 8000),
    steps: [
      {
        name: "step1",
        method: String(method || "GET").toUpperCase(),
        url: String(url || ""),
        legacyCompat: true,
        passInputParams: true,
        headers: {},
        params: {},
        body: {},
        extract: [],
      },
    ],
  };
}

function ensureTemplateAdvancedConfig(input, method, url) {
  const cfg = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  if (Array.isArray(cfg.steps) && cfg.steps.length) return cfg;
  return buildLegacyAdvancedConfig(method, url);
}

function tableName() {
  return `\`${String(config.mysql.stateTable).replace(/`/g, "")}\``;
}

function warnFallback(kind, error) {
  const msg = error && error.message ? error.message : String(error || "unknown error");
  // eslint-disable-next-line no-console
  console.warn(`[store] ${kind} fallback to in-memory cache: ${msg}`);
}

function enableCacheReadMode() {
  forceCacheReads = true;
  const cooldown = Math.max(1000, Number(config.dbRetryCooldownMs || 30000));
  dbRetryAfterTs = Date.now() + cooldown;
}

function disableCacheReadMode() {
  forceCacheReads = false;
  dbRetryAfterTs = 0;
}

function shouldBypassDB() {
  return forceCacheReads && Date.now() < dbRetryAfterTs;
}

async function ensureMemoryStore() {
  if (cache && typeof cache === "object") {
    normalizeStoreShape(cache);
    initialized = true;
    return;
  }
  cache = await getDefaultData();
  normalizeStoreShape(cache);
  initialized = true;
}

async function getDefaultData() {
  const now = new Date().toISOString();
  const adminPasswordHash = await bcrypt.hash("admin123", 10);
  const demoPasswordHash = await bcrypt.hash("user123", 10);

  return {
    meta: {
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    users: [
      {
        id: "u_admin",
        username: "admin",
        passwordHash: adminPasswordHash,
        role: "admin",
        nickname: "?????",
        status: "enabled",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "u_demo",
        username: "demo",
        passwordHash: demoPasswordHash,
        role: "user",
        nickname: "????",
        status: "enabled",
        createdAt: now,
        updatedAt: now,
      },
    ],
    devices: [],
    bindingPins: [],
    clusters: [],
    firmwares: [],
    upgradeJobs: [],
    todos: [],
    schedules: [],
    tfFiles: [],
    tfDeviceFiles: [],
    apiTemplates: [
      {
        id: "tpl_weather",
        name: "和风天气",
        slug: "weather",
        method: "GET",
        url: "https://devapi.qweather.com/v7/weather/now",
        keyField: "key",
        keyIn: ["query"],
        deviceKeyRequired: true,
        defaultParams: { location: "101010100" },
        userInputFields: [
          { name: "cityId", placeholder: "天气城市ID（如 101010100）" },
          { name: "lang", placeholder: "语言（可空，zh/en）" },
          { name: "unit", placeholder: "单位（可空，m/i）" },
        ],
        enabled: true,
        builtin: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "tpl_zaoan",
        name: "早安心语",
        slug: "zaoan",
        method: "GET",
        url: "https://apis.whyta.cn/tx-zaoan",
        keyField: "",
        keyIn: ["query"],
        deviceKeyRequired: false,
        defaultParams: {},
        enabled: true,
        builtin: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "tpl_wanan",
        name: "晚安心语",
        slug: "wanan",
        method: "GET",
        url: "https://apis.whyta.cn/tx-wanan",
        keyField: "",
        keyIn: ["query"],
        deviceKeyRequired: false,
        defaultParams: {},
        enabled: true,
        builtin: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "tpl_bulletin",
        name: "每日简报",
        slug: "bulletin",
        method: "GET",
        url: "https://apis.whyta.cn/tx-bulletin",
        keyField: "",
        keyIn: ["query"],
        deviceKeyRequired: false,
        defaultParams: {},
        enabled: true,
        builtin: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "tpl_addressparse",
        name: "物流地址解析",
        slug: "addressparse",
        method: "GET",
        url: "https://apis.whyta.cn/tx-addressparse",
        keyField: "",
        keyIn: ["query"],
        deviceKeyRequired: false,
        defaultParams: {},
        enabled: true,
        builtin: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "tpl_amap_geocode",
        name: "高德地理编码",
        slug: "amap_geocode",
        method: "GET",
        url: "https://restapi.amap.com/v3/geocode/geo",
        keyField: "key",
        keyIn: ["query"],
        deviceKeyRequired: true,
        defaultParams: {},
        enabled: true,
        builtin: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    operationLogs: [],
    apiLogs: [],
    nameplateLayouts: [],
    nameplateBatchPlans: [],
    nameplateHistory: [],
    homepageTemplates: [],
    homepageConfigs: [],
    homepageImages: [],
    badgepageTemplates: [],
    badgepageConfigs: [],
    badgepageImages: [],
    weatherpageTemplates: [],
    weatherpageConfigs: [],
    weatherpageImages: [],
    remoteCommandAcks: [],
  };
}

function normalizeStoreShape(state) {
  if (!state || typeof state !== "object") return state;

  state.meta = state.meta || {};
  state.meta.createdAt = state.meta.createdAt || new Date().toISOString();
  state.meta.updatedAt = state.meta.updatedAt || state.meta.createdAt;
  state.meta.version = Number(state.meta.version || 1);

  state.users = Array.isArray(state.users) ? state.users : [];
  state.devices = Array.isArray(state.devices) ? state.devices : [];
  state.bindingPins = Array.isArray(state.bindingPins) ? state.bindingPins : [];
  state.clusters = Array.isArray(state.clusters) ? state.clusters : [];
  state.firmwares = Array.isArray(state.firmwares) ? state.firmwares : [];
  state.upgradeJobs = Array.isArray(state.upgradeJobs) ? state.upgradeJobs : [];
  state.todos = Array.isArray(state.todos) ? state.todos : [];
  state.schedules = Array.isArray(state.schedules) ? state.schedules : [];
  state.tfFiles = Array.isArray(state.tfFiles) ? state.tfFiles : [];
  state.tfDeviceFiles = Array.isArray(state.tfDeviceFiles) ? state.tfDeviceFiles : [];
  state.apiTemplates = Array.isArray(state.apiTemplates) ? state.apiTemplates : [];
  state.operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
  state.apiLogs = Array.isArray(state.apiLogs) ? state.apiLogs : [];
  state.nameplateLayouts = Array.isArray(state.nameplateLayouts) ? state.nameplateLayouts : [];
  state.nameplateBatchPlans = Array.isArray(state.nameplateBatchPlans) ? state.nameplateBatchPlans : [];
  state.nameplateHistory = Array.isArray(state.nameplateHistory) ? state.nameplateHistory : [];
  state.homepageTemplates = Array.isArray(state.homepageTemplates) ? state.homepageTemplates : [];
  state.homepageConfigs = Array.isArray(state.homepageConfigs) ? state.homepageConfigs : [];
  state.homepageImages = Array.isArray(state.homepageImages) ? state.homepageImages : [];
  state.badgepageTemplates = Array.isArray(state.badgepageTemplates) ? state.badgepageTemplates : [];
  state.badgepageConfigs = Array.isArray(state.badgepageConfigs) ? state.badgepageConfigs : [];
  state.badgepageImages = Array.isArray(state.badgepageImages) ? state.badgepageImages : [];
  state.weatherpageTemplates = Array.isArray(state.weatherpageTemplates) ? state.weatherpageTemplates : [];
  state.weatherpageConfigs = Array.isArray(state.weatherpageConfigs) ? state.weatherpageConfigs : [];
  state.weatherpageImages = Array.isArray(state.weatherpageImages) ? state.weatherpageImages : [];
  state.remoteCommandAcks = Array.isArray(state.remoteCommandAcks) ? state.remoteCommandAcks : [];

  state.devices.forEach((device) => {
    device.ownerId = device.ownerId || "";
    if (device.ownerId && device.bindState !== "bound") {
      device.bindState = "bound";
    } else if (!device.ownerId && device.bindState !== "bound") {
      device.bindState = "pending";
    }
    device.boundAt = device.boundAt || (device.bindState === "bound" ? device.updatedAt || device.createdAt || "" : "");
    device.boundBy = device.boundBy || "";
    device.simulated = Boolean(device.simulated);
    device.apiKeys = device.apiKeys && typeof device.apiKeys === "object" ? device.apiKeys : {};
    device.thirdApiParams =
      device.thirdApiParams && typeof device.thirdApiParams === "object" && !Array.isArray(device.thirdApiParams)
        ? device.thirdApiParams
        : {};
    device.thirdApiCache =
      device.thirdApiCache && typeof device.thirdApiCache === "object" && !Array.isArray(device.thirdApiCache)
        ? device.thirdApiCache
        : {};
    device.status = device.status || "enabled";
    device.type = device.type || "ink-screen";
    device.remark = device.remark || "";
    device.displayName = String(device.displayName || "").trim();
    device.defaultView = String(device.defaultView || "home").trim() || "home";
    device.firmwareVersion = device.firmwareVersion || "";
    device.lastLoginAt = device.lastLoginAt || "";
    device.updatedAt = device.updatedAt || device.createdAt || new Date().toISOString();
    device.createdAt = device.createdAt || device.updatedAt;
  });

  state.users.forEach((user) => {
    user.id = user.id || "";
    user.username = user.username || "";
    user.role = user.role || "user";
    user.nickname = user.nickname || "";
    user.status = user.status || "enabled";
    user.createdAt = user.createdAt || new Date().toISOString();
    user.updatedAt = user.updatedAt || user.createdAt;
  });

  state.apiTemplates.forEach((tpl) => {
    tpl.id = tpl.id || "";
    tpl.name = tpl.name || "";
    tpl.slug = tpl.slug || "";
    tpl.method = tpl.method || "GET";
    tpl.url = tpl.url || "";
    tpl.keyField = tpl.keyField || "";
    tpl.keyConcatEnabled = Boolean(tpl.keyConcatEnabled);
    tpl.keyConcatFields = Array.isArray(tpl.keyConcatFields)
      ? tpl.keyConcatFields.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    tpl.keyConcatSeparator = String(tpl.keyConcatSeparator || "|");
    if (Array.isArray(tpl.keyIn)) {
      tpl.keyIn = tpl.keyIn.filter(Boolean);
    } else if (tpl.keyIn) {
      tpl.keyIn = [String(tpl.keyIn)];
    } else {
      tpl.keyIn = ["query"];
    }
    tpl.deviceKeyRequired = Boolean(tpl.deviceKeyRequired);
    tpl.defaultParams = tpl.defaultParams && typeof tpl.defaultParams === "object" && !Array.isArray(tpl.defaultParams)
      ? tpl.defaultParams
      : {};
    tpl.enabled = tpl.enabled !== false;
    tpl.advancedEnabled = true;
    tpl.advancedConfig = ensureTemplateAdvancedConfig(tpl.advancedConfig, tpl.method, tpl.url);
    const firstStep = Array.isArray(tpl.advancedConfig?.steps) ? tpl.advancedConfig.steps[0] : null;
    if (firstStep && firstStep.legacyCompat) {
      firstStep.method = String(tpl.method || firstStep.method || "GET").toUpperCase();
      firstStep.url = String(tpl.url || firstStep.url || "");
    }
    tpl.userInputFields = Array.isArray(tpl.userInputFields)
      ? tpl.userInputFields
          .map((item) => ({
            name: String(item?.name || "").trim(),
            placeholder: String(item?.placeholder || item?.hint || "").trim(),
          }))
          .filter((item) => item.name)
      : [];
    tpl.builtin = Boolean(tpl.builtin);
    tpl.createdAt = tpl.createdAt || new Date().toISOString();
    tpl.updatedAt = tpl.updatedAt || tpl.createdAt;
  });

  state.firmwares.forEach((fw) => {
    fw.id = fw.id || "";
    fw.version = fw.version || "";
    fw.releaseNote = fw.releaseNote || "";
    fw.deviceType = fw.deviceType || "ink-screen";
    fw.fileName = fw.fileName || "";
    fw.fileUrl = fw.fileUrl || "";
    fw.gridId = fw.gridId || "";
    fw.fileSize = Number(fw.fileSize || 0);
    fw.mime = fw.mime || "";
    fw.sha256 = fw.sha256 || "";
    fw.createdAt = fw.createdAt || new Date().toISOString();
    fw.updatedAt = fw.updatedAt || fw.createdAt;
  });

  if (!state.apiTemplates.some((tpl) => tpl.slug === "amap_geocode")) {
    const now = new Date().toISOString();
    state.apiTemplates.push({
      id: createId("tpl"),
      name: "高德地理编码",
      slug: "amap_geocode",
      method: "GET",
      url: "https://restapi.amap.com/v3/geocode/geo",
      keyField: "key",
      keyIn: ["query"],
      deviceKeyRequired: true,
      defaultParams: {},
      enabled: true,
      builtin: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  state.bindingPins.forEach((item) => {
    item.pin = String(item.pin || "");
    item.deviceId = String(item.deviceId || "");
    item.mac = String(item.mac || "");
    item.status = item.status || "pending";
    item.attempts = Number(item.attempts || 0);
    item.maxAttempts = Number(item.maxAttempts || 5);
    item.expiresAt = item.expiresAt || "";
    item.usedBy = item.usedBy || "";
    item.usedAt = item.usedAt || "";
    item.createdAt = item.createdAt || new Date().toISOString();
  });

  state.tfFiles.forEach((file) => {
    const categoryMap = {
      font: "fonts",
      ebook: "read",
      firmware: "update",
      wallpaper: "background",
      custom: "photo",
    };
    file.id = file.id || "";
    file.ownerId = file.ownerId || "";
    file.category = categoryMap[file.category] || file.category || "read";
    file.name = file.name || "";
    file.originalName = file.originalName || file.name || "";
    file.size = Number(file.size || 0);
    file.mime = file.mime || "";
    file.gridId = file.gridId || "";
    file.url = file.url || "";
    file.sha256 = file.sha256 || "";
    file.createdAt = file.createdAt || new Date().toISOString();
    file.updatedAt = file.updatedAt || file.createdAt;
  });

  state.tfDeviceFiles.forEach((record) => {
    const categoryMap = {
      font: "fonts",
      ebook: "read",
      firmware: "update",
      wallpaper: "background",
      custom: "photo",
    };
    record.id = record.id || "";
    record.deviceId = record.deviceId || "";
    record.reportedAt = record.reportedAt || record.updatedAt || "";
    record.files = Array.isArray(record.files) ? record.files : [];
    record.files = record.files
      .map((item) => ({
        name: String(item.name || item.fileName || "").trim(),
        category: categoryMap[item.category] || item.category || "read",
        size: Number(item.size || 0),
        updatedAt: item.updatedAt || item.mtime || "",
      }))
      .filter((item) => item.name);
  });

  state.nameplateLayouts.forEach((row) => {
    row.id = row.id || "";
    row.ownerId = row.ownerId || "";
    row.deviceType = row.deviceType || "ink-screen";
    row.layoutName = row.layoutName || "";
    row.fontFamily = row.fontFamily || "Microsoft YaHei";
    row.nameFontSize = Number(row.nameFontSize || 180);
    row.nameOffsetX = Number(row.nameOffsetX || 0);
    row.nameOffsetY = Number(row.nameOffsetY || 0);
    row.titleFontSize = Number(row.titleFontSize || 76);
    row.titleOffsetX = Number(row.titleOffsetX || 0);
    row.titleOffsetY = Number(row.titleOffsetY || 88);
    row.align = row.align || "center";
    row.margin = Number(row.margin || 40);
    row.createdAt = row.createdAt || new Date().toISOString();
    row.updatedAt = row.updatedAt || row.createdAt;
  });

  state.nameplateHistory.forEach((row) => {
    row.id = row.id || "";
    row.ownerId = row.ownerId || "";
    row.deviceType = row.deviceType || "ink-screen";
    row.layoutSnapshot =
      row.layoutSnapshot && typeof row.layoutSnapshot === "object" && !Array.isArray(row.layoutSnapshot)
        ? row.layoutSnapshot
        : {};
    row.name = row.name || "";
    row.title = row.title || "";
    row.targetDeviceIds = Array.isArray(row.targetDeviceIds) ? row.targetDeviceIds.filter(Boolean) : [];
    row.createdAt = row.createdAt || new Date().toISOString();
  });

  state.nameplateBatchPlans.forEach((row) => {
    row.id = row.id || "";
    row.ownerId = row.ownerId || "";
    row.planName = row.planName || "";
    row.deviceType = row.deviceType || "ink-screen";
    row.layoutId = row.layoutId || "";
    row.entries = Array.isArray(row.entries) ? row.entries : [];
    row.entries = row.entries.map((entry) => ({
      name: String(entry?.name || "").trim(),
      title: String(entry?.title || "").trim(),
      deviceIds: Array.isArray(entry?.deviceIds) ? entry.deviceIds.filter(Boolean) : [],
      clusterIds: Array.isArray(entry?.clusterIds) ? entry.clusterIds.filter(Boolean) : [],
      randomCount: Number(entry?.randomCount || 0),
    }));
    row.createdAt = row.createdAt || new Date().toISOString();
    row.updatedAt = row.updatedAt || row.createdAt;
  });

  const normalizePageTemplates = (rows) => {
    rows.forEach((row) => {
      row.id = row.id || "";
      row.ownerId = row.ownerId || "";
      row.name = row.name || "";
      row.type = row.type || "custom_html";
      row.html = row.html || "";
      row.builtin = Boolean(row.builtin);
      row.createdAt = row.createdAt || new Date().toISOString();
      row.updatedAt = row.updatedAt || row.createdAt;
    });
  };

  const normalizePageConfigs = (rows) => {
    rows.forEach((row) => {
      row.id = row.id || "";
      row.ownerId = row.ownerId || "";
      row.deviceId = row.deviceId || "";
      row.config = row.config && typeof row.config === "object" && !Array.isArray(row.config) ? row.config : {};
      row.version = Number(row.version || 1);
      row.updatedBy = row.updatedBy || "";
      row.createdAt = row.createdAt || new Date().toISOString();
      row.updatedAt = row.updatedAt || row.createdAt;
    });
  };

  const normalizePageImages = (rows) => {
    rows.forEach((row) => {
      row.id = row.id || "";
      row.deviceId = row.deviceId || "";
      row.ownerId = row.ownerId || "";
      row.imageFileId = row.imageFileId || "";
      row.previewFileId = row.previewFileId || "";
      row.templateId = row.templateId || "";
      row.format = row.format || "epd4";
      row.width = Number(row.width || 0);
      row.height = Number(row.height || 0);
      row.etag = row.etag || "";
      row.version = row.version || "";
      row.configVersion = Number(row.configVersion || 1);
      row.createdAt = row.createdAt || new Date().toISOString();
      row.updatedAt = row.updatedAt || row.createdAt;
    });
  };

  normalizePageTemplates(state.homepageTemplates);
  normalizePageConfigs(state.homepageConfigs);
  normalizePageImages(state.homepageImages);
  normalizePageTemplates(state.badgepageTemplates);
  normalizePageConfigs(state.badgepageConfigs);
  normalizePageImages(state.badgepageImages);
  normalizePageTemplates(state.weatherpageTemplates);
  normalizePageConfigs(state.weatherpageConfigs);
  normalizePageImages(state.weatherpageImages);

  state.remoteCommandAcks.forEach((row) => {
    row.id = row.id || "";
    row.commandId = row.commandId || row.id || "";
    row.deviceId = row.deviceId || "";
    row.eventType = row.eventType || "";
    row.source = row.source || "remote";
    row.status = row.status || "pending";
    row.ackStatus = row.ackStatus || "";
    row.ackMessage = row.ackMessage || "";
    row.ackPayload =
      row.ackPayload && typeof row.ackPayload === "object" && !Array.isArray(row.ackPayload)
        ? row.ackPayload
        : {};
    row.operatorId = row.operatorId || "";
    row.operatorRole = row.operatorRole || "";
    row.meta = row.meta && typeof row.meta === "object" && !Array.isArray(row.meta) ? row.meta : {};
    row.createdAt = row.createdAt || new Date().toISOString();
    row.updatedAt = row.updatedAt || row.createdAt;
    row.ackedAt = row.ackedAt || "";
  });
  if (state.remoteCommandAcks.length > 8000) {
    state.remoteCommandAcks = state.remoteCommandAcks.slice(0, 8000);
  }
}

async function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    charset: config.mysql.charset,
    connectionLimit: config.mysql.connectionLimit,
    connectTimeout: config.mysql.connectTimeoutMs,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });
  return pool;
}

async function ensureSchema(conn) {
  const sql = `
    CREATE TABLE IF NOT EXISTS ${tableName()} (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      payload LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await conn.query(sql);
}

async function loadStateFromDB(conn) {
  const [rows] = await conn.query(`SELECT payload FROM ${tableName()} WHERE id = 1 LIMIT 1`);
  if (!rows.length) {
    const initial = await getDefaultData();
    normalizeStoreShape(initial);
    await conn.query(`INSERT INTO ${tableName()} (id, payload) VALUES (1, ?)`, [JSON.stringify(initial)]);
    return initial;
  }
  const parsed = JSON.parse(rows[0].payload);
  normalizeStoreShape(parsed);
  return parsed;
}

async function initStore() {
  if (initialized && cache) return clone(cache);

  try {
    const currentPool = await getPool();
    const conn = await currentPool.getConnection();
    try {
      await ensureSchema(conn);
      cache = await loadStateFromDB(conn);
      initialized = true;
      warnedReadFallback = false;
      warnedWriteFallback = false;
      disableCacheReadMode();
      return clone(cache);
    } finally {
      conn.release();
    }
  } catch (error) {
    await ensureMemoryStore();
    if (!warnedReadFallback) {
      warnFallback("initStore", error);
      warnedReadFallback = true;
    }
    enableCacheReadMode();
    return clone(cache);
  }
}

async function readDB() {
  try {
    await initStore();
    // Serve from in-process snapshot by default to keep API latency stable
    // even when remote DB has jitter. Snapshot is refreshed on startup and
    // every successful updateDB commit.
    warnedReadFallback = false;
    return clone(cache);
  } catch (error) {
    await ensureMemoryStore();
    if (!warnedReadFallback) {
      warnFallback("readDB", error);
      warnedReadFallback = true;
    }
    enableCacheReadMode();
    return clone(cache);
  }
}

// Fast path for high-frequency read endpoints (e.g., hardware login):
// returns in-process snapshot without round-tripping MySQL each call.
async function readDBCached() {
  try {
    await initStore();
    warnedReadFallback = false;
    return clone(cache);
  } catch (error) {
    await ensureMemoryStore();
    if (!warnedReadFallback) {
      warnFallback("readDBCached", error);
      warnedReadFallback = true;
    }
    enableCacheReadMode();
    return clone(cache);
  }
}

async function updateMemoryOnly(mutator) {
  await ensureMemoryStore();
  const draft = clone(cache);
  const result = await mutator(draft);
  normalizeStoreShape(draft);
  draft.meta = draft.meta || {};
  draft.meta.updatedAt = new Date().toISOString();
  cache = draft;
  return result;
}

async function updateDB(mutator) {
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        await initStore();
        if (shouldBypassDB()) {
          return updateMemoryOnly(mutator);
        }
        const currentPool = await getPool();
        const conn = await currentPool.getConnection();
        try {
          await conn.beginTransaction();
          const [rows] = await conn.query(`SELECT payload FROM ${tableName()} WHERE id = 1 FOR UPDATE`);
          let draft;
          if (!rows.length) {
            draft = await getDefaultData();
            normalizeStoreShape(draft);
            await conn.query(`INSERT INTO ${tableName()} (id, payload) VALUES (1, ?)`, [JSON.stringify(draft)]);
          } else {
            draft = JSON.parse(rows[0].payload);
            normalizeStoreShape(draft);
          }

          const result = await mutator(draft);
          normalizeStoreShape(draft);
          draft.meta = draft.meta || {};
          draft.meta.updatedAt = new Date().toISOString();
          await conn.query(`UPDATE ${tableName()} SET payload = ? WHERE id = 1`, [JSON.stringify(draft)]);
          await conn.commit();
          cache = draft;
          warnedWriteFallback = false;
          disableCacheReadMode();
          return result;
        } catch (error) {
          try {
            await conn.rollback();
          } catch (_) {
            // ignore rollback errors
          }
          throw error;
        } finally {
          conn.release();
        }
      } catch (error) {
        if (!warnedWriteFallback) {
          warnFallback("updateDB", error);
          warnedWriteFallback = true;
        }
        enableCacheReadMode();
        return updateMemoryOnly(mutator);
      }
    });

  return writeQueue;
}

module.exports = {
  initStore,
  readDB,
  readDBCached,
  updateDB,
};
