const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const config = require("../config");
const createId = require("../utils/id");
const { normalizeTemplateRefreshConfig } = require("../services/api_template_refresh_config.service");
const { ensureDeviceVariableContainer } = require("../services/device_variable.service");

let cache = null;
let initialized = false;
let writeQueue = Promise.resolve();
const thirdCacheWriteQueues = new Map();
let warnedReadFallback = false;
let warnedWriteFallback = false;
let forceCacheReads = false;
let dbRetryAfterTs = 0;
let initializedFromDB = false;
let mysqlPool = null;
let cacheGeneration = 0;
let pendingOptimisticSnapshot = null;
let pendingOptimisticLabel = "optimistic update";
let pendingOptimisticVersion = 0;
let pendingOptimisticDirtyKeys = new Set();
let optimisticPersistScheduled = false;
let optimisticPersistTimer = null;
let optimisticLatestVersion = 0;
let optimisticPersistedVersion = 0;
let optimisticInFlightVersion = 0;
let optimisticLastAttemptAt = "";
let optimisticLastSuccessAt = "";
let optimisticLastFailureAt = "";
let optimisticLastError = null;
let optimisticLastOutcome = "idle";
const dbOpTimeoutMs = Math.max(1000, Number(config.mysql.opTimeoutMs || config.mysql.connectTimeoutMs || 6000));
const optimisticPersistDelayMs = Math.max(0, Number(config.mysql.optimisticPersistDelayMs || 50));
const thirdCacheDbOpTimeoutMs = Math.max(
  1000,
  Math.min(
    dbOpTimeoutMs,
    Number(config.defaultApiTemplateRefreshTimeoutMs || config.requestTimeoutMs || config.mysql.connectTimeoutMs || 8000)
  )
);
const BUILTIN_TEMPLATE_NAME_BY_SLUG = {
  weather: "和风天气",
  zaoan: "早安心语",
  wanan: "晚安心语",
  bulletin: "每日日报",
  addressparse: "物流地址解析",
  amap_geocode: "高德地理编码",
  todo: "TODO列表",
  xique_schedule: "喜鹊课程表",
};
const MIGRATION_WEATHER_TEMPLATE_REFRESH_60M = "2026-06-25-weather-template-refresh-60m";
const MIGRATION_PLAY_COLLECTION_2M_TO_10M = "2026-06-25-play-collection-2m-to-10m";
const REQUIRED_STORE_MIGRATIONS = [
  MIGRATION_WEATHER_TEMPLATE_REFRESH_60M,
  MIGRATION_PLAY_COLLECTION_2M_TO_10M,
];
const DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC = 10 * 60;
const LEGACY_PLAY_COLLECTION_SLIDE_INTERVAL_SEC = 2 * 60;
const BUILTIN_TEMPLATE_MOJIBAKE_NAME_SET = new Set([
  "鍜岄澶╂皵",
  "鏃╁畨蹇冭",
  "鏅氬畨蹇冭",
  "鐗╂祦鍦板潃瑙ｆ瀽",
  "楂樺痉鍦扮悊缂栫爜",
]);

class StoreInfrastructureError extends Error {
  constructor(operation, cause) {
    const message = cause && cause.message ? cause.message : String(cause || "unknown infrastructure error");
    super(`${operation}: ${message}`, { cause });
    this.name = "StoreInfrastructureError";
    this.code = "STORE_INFRASTRUCTURE_ERROR";
    this.operation = String(operation || "store operation");
  }
}

async function runStoreInfrastructureOperation(operation, runner) {
  try {
    return await runner();
  } catch (error) {
    if (error instanceof StoreInfrastructureError) throw error;
    throw new StoreInfrastructureError(operation, error);
  }
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timeout`));
    }, Math.max(100, Number(timeoutMs || dbOpTimeoutMs)));
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function clone(data) {
  if (data === undefined) return undefined;
  return JSON.parse(JSON.stringify(data));
}

function enqueueThirdCacheWrite(queueKey, runner) {
  const safeKey = String(queueKey || "default");
  const previous = thirdCacheWriteQueues.get(safeKey) || Promise.resolve();
  const task = previous.catch(() => undefined).then(runner);
  const tracked = task
    .catch(() => undefined)
    .finally(() => {
      if (thirdCacheWriteQueues.get(safeKey) === tracked) {
        thirdCacheWriteQueues.delete(safeKey);
      }
    });
  thirdCacheWriteQueues.set(safeKey, tracked);
  return task;
}

function resolveThirdCacheQueueKey(deviceId) {
  const safeDeviceId = String(deviceId || "").trim();
  if (cache && typeof cache === "object" && Array.isArray(cache.devices)) {
    const target = cache.devices.find((item) => {
      const id = String(item?.id || "").trim();
      const did = String(item?.deviceId || "").trim();
      return id === safeDeviceId || did === safeDeviceId;
    });
    if (target) {
      return String(target.id || target.deviceId || safeDeviceId);
    }
  }
  return safeDeviceId;
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

function normalizeIntervalMinutes(value) {
  const allowed = new Set([10, 30, 60]);
  const n = Number(value || 60);
  if (!Number.isFinite(n)) return 60;
  const rounded = Math.floor(n);
  return allowed.has(rounded) ? rounded : 60;
}

function normalizeObjectField(input) {
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}

function normalizeSecondsField(value, fallback = DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(5, Math.min(86400, Math.floor(n)));
}

function ensureMigrationMap(state) {
  state.meta = state.meta && typeof state.meta === "object" && !Array.isArray(state.meta) ? state.meta : {};
  state.meta.migrations =
    state.meta.migrations && typeof state.meta.migrations === "object" && !Array.isArray(state.meta.migrations)
      ? state.meta.migrations
      : {};
  return state.meta.migrations;
}

function hasMigration(state, migrationId) {
  const migrations = ensureMigrationMap(state);
  return Boolean(migrations[String(migrationId || "")]);
}

function markMigration(state, migrationId, now = new Date().toISOString()) {
  const migrations = ensureMigrationMap(state);
  migrations[String(migrationId || "")] = String(now);
}

function missingRequiredStoreMigrations(state = {}) {
  const migrations =
    state.meta?.migrations && typeof state.meta.migrations === "object" && !Array.isArray(state.meta.migrations)
      ? state.meta.migrations
      : {};
  return REQUIRED_STORE_MIGRATIONS.filter((migrationId) => !migrations[migrationId]);
}

function normalizeStringField(input, fallback = "") {
  return String(input ?? fallback);
}

function normalizeWeeksField(input, maxWeek = 30) {
  const safeMax = Math.max(4, Number(maxWeek || 30));
  if (!Array.isArray(input)) return [];
  const set = new Set();
  input.forEach((item) => {
    const week = Math.floor(Number(item || 0));
    if (Number.isFinite(week) && week >= 1 && week <= safeMax) {
      set.add(week);
    }
  });
  return Array.from(set.values()).sort((a, b) => a - b);
}

function normalizeBooleanField(input, fallback = false) {
  if (input === undefined || input === null || input === "") return Boolean(fallback);
  return Boolean(input);
}

function normalizeScheduleSyncConfigRow(row = {}) {
  const now = new Date().toISOString();
  return {
    id: normalizeStringField(row.id || createId("xsync")),
    deviceId: normalizeStringField(row.deviceId || ""),
    ownerId: normalizeStringField(row.ownerId || ""),
    source: "xique",
    enabled: normalizeBooleanField(row.enabled, false),
    intervalMinutes: normalizeIntervalMinutes(row.intervalMinutes),
    currentTermKey: normalizeStringField(row.currentTermKey || row.termKey || ""),
    termStartDate: normalizeStringField(row.termStartDate || ""),
    currentWeek: Number.isFinite(Number(row.currentWeek || 0)) && Number(row.currentWeek || 0) > 0
      ? Math.floor(Number(row.currentWeek))
      : null,
    currentWeekAt: normalizeStringField(row.currentWeekAt || ""),
    currentWeekSource: normalizeStringField(row.currentWeekSource || ""),
    adapterMode: normalizeStringField(row.adapterMode || "mock"),
    baseUrl: normalizeStringField(row.baseUrl || ""),
    sampleUrl: normalizeStringField(row.sampleUrl || ""),
    sampleHtml: normalizeStringField(row.sampleHtml || ""),
    sampleJson: normalizeObjectField(row.sampleJson),
    requireCaptcha: normalizeBooleanField(row.requireCaptcha, false),
    needRelogin: normalizeBooleanField(row.needRelogin, false),
    needCaptchaReverify: normalizeBooleanField(row.needCaptchaReverify, false),
    paused: normalizeBooleanField(row.paused, false),
    pauseReason: normalizeStringField(row.pauseReason || ""),
    pauseUntil: normalizeStringField(row.pauseUntil || ""),
    failureCount: Number(row.failureCount || 0),
    lastAttemptAt: normalizeStringField(row.lastAttemptAt || ""),
    lastSuccessAt: normalizeStringField(row.lastSuccessAt || ""),
    lastSyncAt: normalizeStringField(row.lastSyncAt || row.lastSuccessAt || ""),
    lastSyncStatus: normalizeStringField(row.lastSyncStatus || ""),
    lastSyncErrorCode: normalizeStringField(row.lastSyncErrorCode || ""),
    lastError: normalizeStringField(row.lastError || ""),
    nextRunAt: normalizeStringField(row.nextRunAt || ""),
    loginUsername: normalizeStringField(row.loginUsername || ""),
    loginDisplayName: normalizeStringField(row.loginDisplayName || ""),
    createdAt: normalizeStringField(row.createdAt || now),
    updatedAt: normalizeStringField(row.updatedAt || now),
  };
}

function normalizeXiqueSessionVaultRow(row = {}) {
  const now = new Date().toISOString();
  return {
    id: normalizeStringField(row.id || createId("xvault")),
    configId: normalizeStringField(row.configId || ""),
    deviceId: normalizeStringField(row.deviceId || ""),
    state: normalizeStringField(row.state || "idle"),
    sessionId: normalizeStringField(row.sessionId || ""),
    sessionExpiresAt: normalizeStringField(row.sessionExpiresAt || ""),
    authCookieCipher: normalizeStringField(row.authCookieCipher || ""),
    authTokenCipher: normalizeStringField(row.authTokenCipher || ""),
    credentialCipher: normalizeStringField(row.credentialCipher || ""),
    captchaSession: normalizeStringField(row.captchaSession || ""),
    captchaImage: normalizeStringField(row.captchaImage || ""),
    captchaAnswerHash: normalizeStringField(row.captchaAnswerHash || ""),
    captchaExpiresAt: normalizeStringField(row.captchaExpiresAt || ""),
    needCaptchaReverify: normalizeBooleanField(row.needCaptchaReverify, false),
    lastVerifiedAt: normalizeStringField(row.lastVerifiedAt || ""),
    lastLoginAt: normalizeStringField(row.lastLoginAt || ""),
    lastSyncAt: normalizeStringField(row.lastSyncAt || ""),
    lastSyncStatus: normalizeStringField(row.lastSyncStatus || ""),
    lastSyncErrorCode: normalizeStringField(row.lastSyncErrorCode || ""),
    lastError: normalizeStringField(row.lastError || ""),
    createdAt: normalizeStringField(row.createdAt || now),
    updatedAt: normalizeStringField(row.updatedAt || now),
  };
}

function normalizeSyncLogRow(row = {}) {
  const now = new Date().toISOString();
  return {
    id: normalizeStringField(row.id || createId("xslog")),
    configId: normalizeStringField(row.configId || ""),
    deviceId: normalizeStringField(row.deviceId || ""),
    action: normalizeStringField(row.action || ""),
    status: normalizeStringField(row.status || "info"),
    detail: normalizeObjectField(row.detail),
    createdAt: normalizeStringField(row.createdAt || now),
  };
}

function normalizeScheduleRow(row = {}) {
  const now = new Date().toISOString();
  const sourceMetaRaw = normalizeObjectField(row.sourceMeta);
  const weeks = normalizeWeeksField(
    Array.isArray(row.weeks) ? row.weeks : (Array.isArray(sourceMetaRaw.weeks) ? sourceMetaRaw.weeks : [])
  );
  const weekRule = normalizeStringField(
    row.weekRule || sourceMetaRaw.weekRule || (weeks.length ? "custom" : "all")
  );
  const termStartDate = normalizeStringField(row.termStartDate || sourceMetaRaw.termStartDate || "");
  const sourceMeta = {
    ...sourceMetaRaw,
    weeks,
    weekRule,
    termStartDate,
  };
  return {
    id: normalizeStringField(row.id || createId("sch")),
    deviceId: normalizeStringField(row.deviceId || ""),
    mode: normalizeStringField(String(row.mode || "course")).toLowerCase() === "meeting" ? "meeting" : "course",
    weekday: Number.isFinite(Number(row.weekday || 0)) ? Math.max(1, Math.min(7, Math.floor(Number(row.weekday || 1)))) : 1,
    orderIndex: Number.isFinite(Number(row.orderIndex || 0)) && Number(row.orderIndex || 0) > 0 ? Math.floor(Number(row.orderIndex || 0)) : 1,
    title: normalizeStringField(row.title || row.courseName || ""),
    content: normalizeStringField(row.content || row.note || ""),
    startTime: normalizeStringField(row.startTime || ""),
    endTime: normalizeStringField(row.endTime || ""),
    courseName: normalizeStringField(row.courseName || row.title || ""),
    note: normalizeStringField(row.note || row.content || ""),
    source: normalizeStringField(row.source || "manual"),
    sourceKey: normalizeStringField(row.sourceKey || ""),
    termKey: normalizeStringField(row.termKey || row.sourceTermKey || ""),
    xiqueCourseId: normalizeStringField(row.xiqueCourseId || ""),
    xiqueClassKey: normalizeStringField(row.xiqueClassKey || ""),
    weeks,
    weekRule,
    termStartDate,
    sourceMeta,
    createdAt: normalizeStringField(row.createdAt || now),
    updatedAt: normalizeStringField(row.updatedAt || now),
  };
}

function normalizeThirdCacheEntry(row = {}, refreshConfig = {}) {
  const nowIso = new Date().toISOString();
  const safeRow = row && typeof row === "object" && !Array.isArray(row) ? row : {};
  const ttlSeconds = Math.max(30, Number(refreshConfig?.ttlSeconds || 300));
  const updatedAt = normalizeStringField(safeRow.updatedAt || safeRow.updated_at || "", nowIso);
  const updatedTs = Date.parse(updatedAt);
  const expireFallback = Number.isFinite(updatedTs)
    ? new Date(updatedTs + ttlSeconds * 1000).toISOString()
    : new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const expireAt = normalizeStringField(safeRow.expireAt || safeRow.expire_at || "", expireFallback);
  return {
    template:
      safeRow.template && typeof safeRow.template === "object" && !Array.isArray(safeRow.template)
        ? safeRow.template
        : {},
    formatted:
      safeRow.formatted !== undefined
        ? safeRow.formatted
        : safeRow.raw && typeof safeRow.raw === "object" && !Array.isArray(safeRow.raw)
          ? safeRow.raw.output
          : null,
    raw:
      safeRow.raw && typeof safeRow.raw === "object" && !Array.isArray(safeRow.raw)
        ? safeRow.raw
        : { output: safeRow.formatted !== undefined ? safeRow.formatted : null, vars: {}, steps: [] },
    updatedAt,
    expireAt,
    nextRefreshAt: normalizeStringField(safeRow.nextRefreshAt || safeRow.next_refresh_at || "", ""),
    refreshMode: normalizeStringField(
      safeRow.refreshMode || safeRow.refresh_mode || refreshConfig.mode || "interval",
      "interval"
    ),
    refreshStatus: normalizeStringField(safeRow.refreshStatus || safeRow.refresh_status || "idle", "idle"),
    lastError: normalizeStringField(safeRow.lastError || safeRow.last_error || "", ""),
    lastLatencyMs: Number(safeRow.lastLatencyMs || safeRow.last_latency_ms || 0) || 0,
    lastRefreshSource: normalizeStringField(
      safeRow.lastRefreshSource || safeRow.last_refresh_source || "",
      ""
    ),
    lastRequestAt: normalizeStringField(safeRow.lastRequestAt || safeRow.last_request_at || "", ""),
    stale: Date.parse(expireAt) <= Date.now(),
  };
}

function fixBuiltinTemplateName(tpl = {}) {
  const slug = String(tpl.slug || "").trim();
  if (!slug) return;
  const canonicalName = BUILTIN_TEMPLATE_NAME_BY_SLUG[slug];
  if (!canonicalName) return;
  const currentName = String(tpl.name || "").trim();
  if (!currentName || BUILTIN_TEMPLATE_MOJIBAKE_NAME_SET.has(currentName)) {
    tpl.name = canonicalName;
  }
}

function tableName() {
  return `\`${String(config.mysql.stateTable).replace(/`/g, "")}\``;
}

function warnFallback(kind, error) {
  const msg = error && error.message ? error.message : String(error || "unknown error");
  const extra = Array.isArray(error?.errors)
    ? ` | causes=${error.errors
        .map((item) => {
          const code = item?.code ? String(item.code) : "";
          const address = item?.address ? String(item.address) : "";
          const port = Number(item?.port || 0) > 0 ? String(item.port) : "";
          return [code, address, port].filter(Boolean).join("@");
        })
        .filter(Boolean)
        .join(",")}`
    : "";
  // eslint-disable-next-line no-console
  console.warn(`[store] ${kind} fallback to in-memory cache: ${msg}${extra}`);
  if (error && (error.stack || error.cause)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[store] ${kind} fallback detail: ${
        error.stack || String(error.cause?.message || error.cause || "")
      }`
    );
  }
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
  if (process.env.NODE_ENV === "test" && process.env.STORE_TEST_MEMORY_ONLY === "1") return true;
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
  initializedFromDB = false;
}

async function getDefaultData() {
  const now = new Date().toISOString();
  const adminPasswordHash = await bcrypt.hash("admin@0607", 10);
  const demoPasswordHash = await bcrypt.hash("uesr@123", 10);

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
    fullFirmwareBundles: [],
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
        refreshConfig: normalizeTemplateRefreshConfig(
          {
            mode: "interval",
            intervalMinutes: 60,
            ttlSeconds: 3600,
            minRequestGapSeconds: 600,
            jitterSeconds: 60,
          },
          { slug: "weather" }
        ),
        userInputFields: [
          { name: "cityId", placeholder: "天气城市ID（如 101010100）" },
          { name: "lang", placeholder: "语言（可选，zh/en）" },
          { name: "unit", placeholder: "单位（可选，m/i）" },
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
        name: "每日日报",
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
      {
        id: "tpl_todo",
        name: "TODO列表",
        slug: "todo",
        method: "GET",
        url: "/api/todos",
        keyField: "",
        keyIn: ["query"],
        deviceKeyRequired: false,
        defaultParams: {},
        userInputFields: [
          { name: "done", placeholder: "可选：true/false，按完成状态过滤" },
          { name: "limit", placeholder: "可选：限制返回条数（最大500）" },
        ],
        enabled: true,
        builtin: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "tpl_xique_schedule",
        name: "喜鹊课程表",
        slug: "xique_schedule",
        method: "POST",
        url: "/api/schedules/xique/import",
        keyField: "",
        keyIn: ["query"],
        deviceKeyRequired: false,
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
    taskPlans: [],
    taskRuns: [],
    aiSessions: [],
    aiMessages: [],
    aiToolCalls: [],
    aiConfirmations: [],
    aiProviderConfigs: [],
    aiUserAssignments: [],
    aiUsageLogs: [],
    asrProviderConfigs: [],
    asrUsageLogs: [],
    nvsShadows: [],
    nvsBackups: [],
    tasks: [],
    scheduleSyncConfigs: [],
    xiqueSessionVault: [],
    syncLogs: [],
  };
}

async function migrateDefaultCredentialIfNeeded(state) {
  if (!state || !Array.isArray(state.users) || !state.users.length) {
    return false;
  }
  const rules = [
    { username: "admin", oldPassword: "admin123", nextPassword: "admin@0607" },
    { username: "demo", oldPassword: "user123", nextPassword: "uesr@123" },
  ];
  let changed = false;
  const now = new Date().toISOString();
  for (const rule of rules) {
    const user = state.users.find((item) => String(item?.username || "") === rule.username);
    if (!user || !user.passwordHash) {
      continue;
    }
    let alreadyNew = false;
    try {
      alreadyNew = await bcrypt.compare(rule.nextPassword, String(user.passwordHash));
    } catch (_) {
      alreadyNew = false;
    }
    if (alreadyNew) {
      continue;
    }
    let stillOld = false;
    try {
      stillOld = await bcrypt.compare(rule.oldPassword, String(user.passwordHash));
    } catch (_) {
      stillOld = false;
    }
    if (!stillOld) {
      continue;
    }
    user.passwordHash = await bcrypt.hash(rule.nextPassword, 10);
    user.updatedAt = now;
    changed = true;
  }
  return changed;
}

function normalizeStoreShape(state) {
  if (!state || typeof state !== "object") return state;

  state.meta = state.meta || {};
  state.meta.createdAt = state.meta.createdAt || new Date().toISOString();
  state.meta.updatedAt = state.meta.updatedAt || state.meta.createdAt;
  state.meta.version = Number(state.meta.version || 1);
  ensureMigrationMap(state);

  state.users = Array.isArray(state.users) ? state.users : [];
  state.devices = Array.isArray(state.devices) ? state.devices : [];
  state.bindingPins = Array.isArray(state.bindingPins) ? state.bindingPins : [];
  state.clusters = Array.isArray(state.clusters) ? state.clusters : [];
  state.firmwares = Array.isArray(state.firmwares) ? state.firmwares : [];
  state.fullFirmwareBundles = Array.isArray(state.fullFirmwareBundles) ? state.fullFirmwareBundles : [];
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
  state.taskPlans = Array.isArray(state.taskPlans) ? state.taskPlans : [];
  state.taskRuns = Array.isArray(state.taskRuns) ? state.taskRuns : [];
  state.aiSessions = Array.isArray(state.aiSessions) ? state.aiSessions : [];
  state.aiMessages = Array.isArray(state.aiMessages) ? state.aiMessages : [];
  state.aiToolCalls = Array.isArray(state.aiToolCalls) ? state.aiToolCalls : [];
  state.aiConfirmations = Array.isArray(state.aiConfirmations) ? state.aiConfirmations : [];
  state.aiProviderConfigs = Array.isArray(state.aiProviderConfigs) ? state.aiProviderConfigs : [];
  state.aiUserAssignments = Array.isArray(state.aiUserAssignments) ? state.aiUserAssignments : [];
  state.aiUsageLogs = Array.isArray(state.aiUsageLogs) ? state.aiUsageLogs : [];
  state.asrProviderConfigs = Array.isArray(state.asrProviderConfigs) ? state.asrProviderConfigs : [];
  state.asrUsageLogs = Array.isArray(state.asrUsageLogs) ? state.asrUsageLogs : [];
  state.nvsShadows = Array.isArray(state.nvsShadows) ? state.nvsShadows : [];
  state.nvsBackups = Array.isArray(state.nvsBackups) ? state.nvsBackups : [];
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  state.scheduleSyncConfigs = Array.isArray(state.scheduleSyncConfigs) ? state.scheduleSyncConfigs : [];
  state.xiqueSessionVault = Array.isArray(state.xiqueSessionVault) ? state.xiqueSessionVault : [];
  state.syncLogs = Array.isArray(state.syncLogs) ? state.syncLogs : [];
  state.albumSources = Array.isArray(state.albumSources) ? state.albumSources : [];
  state.albumSourceCredentials = Array.isArray(state.albumSourceCredentials) ? state.albumSourceCredentials : [];
  state.albumExternalIndex = Array.isArray(state.albumExternalIndex) ? state.albumExternalIndex : [];
  state.imageAssets = Array.isArray(state.imageAssets) ? state.imageAssets : [];
  state.playCollections = Array.isArray(state.playCollections) ? state.playCollections : [];
  state.playCollectionItems = Array.isArray(state.playCollectionItems) ? state.playCollectionItems : [];
  state.imageImportJobs = Array.isArray(state.imageImportJobs) ? state.imageImportJobs : [];
  state.imageImportJobItems = Array.isArray(state.imageImportJobItems) ? state.imageImportJobItems : [];
  state.collectionSourceRules = Array.isArray(state.collectionSourceRules) ? state.collectionSourceRules : [];
  state.sourceSyncLogs = Array.isArray(state.sourceSyncLogs) ? state.sourceSyncLogs : [];
  state.e6RenderedAssets = Array.isArray(state.e6RenderedAssets) ? state.e6RenderedAssets : [];

  state.taskPlans.forEach((row) => {
    row.id = row.id || createId("task");
    row.name = row.name || "未命名计划任务";
    row.description = row.description || "";
    row.enabled = row.enabled !== false;
    row.priority = Number.isFinite(Number(row.priority)) ? Number(row.priority) : 10;
    row.targetDeviceIds = Array.isArray(row.targetDeviceIds) ? row.targetDeviceIds.filter(Boolean) : [];
    row.targetClusterIds = Array.isArray(row.targetClusterIds) ? row.targetClusterIds.filter(Boolean) : [];
    row.scheduleMode = ["once", "weekly", "calendar"].includes(String(row.scheduleMode || "")) ? row.scheduleMode : "once";
    row.scheduleSpec = row.scheduleSpec && typeof row.scheduleSpec === "object" && !Array.isArray(row.scheduleSpec) ? row.scheduleSpec : {};
    row.repeatSpec = row.repeatSpec && typeof row.repeatSpec === "object" && !Array.isArray(row.repeatSpec) ? row.repeatSpec : {};
    row.retrySpec = row.retrySpec && typeof row.retrySpec === "object" && !Array.isArray(row.retrySpec) ? row.retrySpec : {};
    row.steps = Array.isArray(row.steps) ? row.steps : [];
    row.lastRunAt = row.lastRunAt || "";
    row.nextRunAt = row.nextRunAt || "";
    row.createdAt = row.createdAt || new Date().toISOString();
    row.updatedAt = row.updatedAt || row.createdAt;
  });

  state.taskRuns.forEach((row) => {
    row.id = row.id || createId("trun");
    row.planId = row.planId || "";
    row.planName = row.planName || "";
    row.triggerType = row.triggerType || "manual";
    row.priority = Number.isFinite(Number(row.priority)) ? Number(row.priority) : 0;
    row.status = row.status || "queued";
    row.targetSnapshot = Array.isArray(row.targetSnapshot) ? row.targetSnapshot.filter(Boolean) : [];
    row.reason = row.reason || "";
    row.stepResults = Array.isArray(row.stepResults) ? row.stepResults : [];
    row.startedAt = row.startedAt || "";
    row.finishedAt = row.finishedAt || "";
    row.createdAt = row.createdAt || new Date().toISOString();
    row.updatedAt = row.updatedAt || row.createdAt;
  });

  state.schedules.forEach((row) => {
    Object.assign(row, normalizeScheduleRow(row));
  });

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
    ensureDeviceVariableContainer(device);
    device.status = device.status || "enabled";
    device.type = device.type || "ink-screen";
    if (device.type === "e6_color_frame") device.type = "e6-color-frame";
    device.resolutionWidth = Number(device.resolutionWidth || (device.type === "e6-color-frame" ? 800 : 0)) || "";
    device.resolutionHeight = Number(device.resolutionHeight || (device.type === "e6-color-frame" ? 480 : 0)) || "";
    device.colorMode = device.colorMode || (device.type === "e6-color-frame" ? "e6_6color" : "");
    device.capabilities =
      device.capabilities && typeof device.capabilities === "object" && !Array.isArray(device.capabilities)
        ? device.capabilities
        : {};
    device.currentCollectionId = device.currentCollectionId || "";
    device.currentPlayMode = device.currentPlayMode || "";
    device.lastDisplayImageId = device.lastDisplayImageId || "";
    device.lastDisplayCollectionId = device.lastDisplayCollectionId || "";
    device.lastDisplayItemIndex = Number.isFinite(Number(device.lastDisplayItemIndex))
      ? Number(device.lastDisplayItemIndex)
      : 0;
    device.temperature = device.temperature ?? "";
    device.humidity = device.humidity ?? "";
    device.rssi = device.rssi ?? "";
    device.batteryVoltage = device.batteryVoltage ?? "";
    device.batteryPercent = device.batteryPercent ?? "";
    device.sdCardStatus = device.sdCardStatus || "";
    device.sdFreeBytes = device.sdFreeBytes ?? "";
    device.lastScreenRefreshAt = device.lastScreenRefreshAt || "";
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
    tpl.refreshConfig = normalizeTemplateRefreshConfig(tpl.refreshConfig, { slug: tpl.slug });
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
    fixBuiltinTemplateName(tpl);
    tpl.createdAt = tpl.createdAt || new Date().toISOString();
    tpl.updatedAt = tpl.updatedAt || tpl.createdAt;
  });

  if (!hasMigration(state, MIGRATION_WEATHER_TEMPLATE_REFRESH_60M)) {
    const now = new Date().toISOString();
    const weatherTemplate = state.apiTemplates.find((tpl) => String(tpl?.slug || "").trim() === "weather");
    if (weatherTemplate) {
      const current =
        weatherTemplate.refreshConfig && typeof weatherTemplate.refreshConfig === "object" && !Array.isArray(weatherTemplate.refreshConfig)
          ? weatherTemplate.refreshConfig
          : {};
      weatherTemplate.refreshConfig = normalizeTemplateRefreshConfig(
        {
          ...current,
          mode: "interval",
          enabled: current.enabled !== false,
          intervalMinutes: 60,
          ttlSeconds: 3600,
          minRequestGapSeconds: Math.max(600, Number(current.minRequestGapSeconds || 0)),
        },
        { slug: "weather" }
      );
      weatherTemplate.updatedAt = now;
    }
    markMigration(state, MIGRATION_WEATHER_TEMPLATE_REFRESH_60M, now);
  }

  state.playCollections.forEach((row) => {
    row.id = row.id || createId("col");
    row.ownerId = row.ownerId || "";
    row.name = row.name || "未命名集合";
    row.description = row.description || "";
    row.coverImageId = row.coverImageId || "";
    row.playMode = String(row.playMode || "slideshow").trim() || "slideshow";
    row.slideIntervalSec = normalizeSecondsField(row.slideIntervalSec, DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC);
    row.loopEnabled = row.loopEnabled !== false;
    row.shuffleEnabled = Boolean(row.shuffleEnabled);
    row.offlineSyncEnabled = row.offlineSyncEnabled !== false;
    row.targetDeviceType = row.targetDeviceType || "";
    row.status = row.status || "enabled";
    row.version = Number(row.version || 1);
    row.createdAt = row.createdAt || new Date().toISOString();
    row.updatedAt = row.updatedAt || row.createdAt;
  });

  if (!hasMigration(state, MIGRATION_PLAY_COLLECTION_2M_TO_10M)) {
    const now = new Date().toISOString();
    state.playCollections.forEach((row) => {
      if (Number(row.slideIntervalSec) !== LEGACY_PLAY_COLLECTION_SLIDE_INTERVAL_SEC) return;
      row.slideIntervalSec = DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC;
      row.version = Number(row.version || 1) + 1;
      row.updatedAt = now;
    });
    markMigration(state, MIGRATION_PLAY_COLLECTION_2M_TO_10M, now);
  }

  const refreshConfigBySlug = new Map(
    state.apiTemplates
      .filter((tpl) => tpl && typeof tpl === "object")
      .map((tpl) => [String(tpl.slug || "").trim(), normalizeTemplateRefreshConfig(tpl.refreshConfig, { slug: tpl.slug })])
  );

  state.devices.forEach((device) => {
    const cache = device.thirdApiCache && typeof device.thirdApiCache === "object" && !Array.isArray(device.thirdApiCache)
      ? device.thirdApiCache
      : {};
    const normalizedCache = {};
    Object.keys(cache).forEach((slug) => {
      const refreshConfig = refreshConfigBySlug.get(String(slug || "").trim()) || normalizeTemplateRefreshConfig({}, { slug });
      normalizedCache[slug] = normalizeThirdCacheEntry(cache[slug], refreshConfig);
      if (!normalizedCache[slug].template || typeof normalizedCache[slug].template !== "object") {
        normalizedCache[slug].template = { slug: String(slug || ""), name: String(slug || "") };
      } else {
        if (!String(normalizedCache[slug].template.slug || "").trim()) {
          normalizedCache[slug].template.slug = String(slug || "");
        }
        if (!String(normalizedCache[slug].template.name || "").trim()) {
          normalizedCache[slug].template.name = String(slug || "");
        }
      }
    });
    device.thirdApiCache = normalizedCache;
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
      refreshConfig: normalizeTemplateRefreshConfig({}, { slug: "amap_geocode" }),
      enabled: true,
      builtin: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (!state.apiTemplates.some((tpl) => tpl.slug === "xique_schedule")) {
    const now = new Date().toISOString();
    state.apiTemplates.push({
      id: createId("tpl"),
      name: "喜鹊课程表",
      slug: "xique_schedule",
      method: "POST",
      url: "/api/schedules/xique/import",
      keyField: "",
      keyIn: ["query"],
      deviceKeyRequired: false,
      defaultParams: {},
      refreshConfig: normalizeTemplateRefreshConfig({}, { slug: "xique_schedule" }),
      enabled: true,
      builtin: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (!state.apiTemplates.some((tpl) => tpl.slug === "todo")) {
    const now = new Date().toISOString();
    state.apiTemplates.push({
      id: createId("tpl"),
      name: "TODO列表",
      slug: "todo",
      method: "GET",
      url: "/api/todos",
      keyField: "",
      keyIn: ["query"],
      deviceKeyRequired: false,
      defaultParams: {},
      refreshConfig: normalizeTemplateRefreshConfig({}, { slug: "todo" }),
      userInputFields: [
        { name: "done", placeholder: "可选：true/false，按完成状态过滤" },
        { name: "limit", placeholder: "可选：限制返回条数（最大500）" },
      ],
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
      row.targetDeviceTypes = Array.isArray(row.targetDeviceTypes)
        ? [...new Set(row.targetDeviceTypes.map((item) => String(item || "").trim()).filter(Boolean))]
        : String(row.targetDeviceType || row.deviceTypes || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
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

  state.scheduleSyncConfigs.forEach((row) => {
    Object.assign(row, normalizeScheduleSyncConfigRow(row));
  });
  state.xiqueSessionVault.forEach((row) => {
    Object.assign(row, normalizeXiqueSessionVaultRow(row));
  });
  state.syncLogs.forEach((row) => {
    Object.assign(row, normalizeSyncLogRow(row));
  });
  if (state.syncLogs.length > 2000) {
    state.syncLogs = state.syncLogs.slice(0, 2000);
  }
}

function quoteId(name) {
  return `\`${String(name || "").replace(/`/g, "")}\``;
}

function safeJSONString(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch (_) {
    return "{}";
  }
}

function safeJSONParse(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function toDbDateTime(value, fallbackNow = false) {
  let date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    if (!fallbackNow) return null;
    date = new Date();
  }
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(
    date.getUTCMinutes()
  )}:${pad(date.getUTCSeconds())}`;
}

function fromDbDateTime(value, fallback = "") {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(String(value).replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function createEmptyState() {
  const now = new Date().toISOString();
  return {
    meta: {
      createdAt: now,
      updatedAt: now,
      version: 2,
      migrations: {},
    },
    users: [],
    devices: [],
    bindingPins: [],
    clusters: [],
    firmwares: [],
    fullFirmwareBundles: [],
    upgradeJobs: [],
    todos: [],
    schedules: [],
    tfFiles: [],
    tfDeviceFiles: [],
    apiTemplates: [],
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
    scheduleSyncConfigs: [],
    xiqueSessionVault: [],
    syncLogs: [],
    aiSessions: [],
    aiMessages: [],
    aiToolCalls: [],
    aiConfirmations: [],
    aiProviderConfigs: [],
    aiUserAssignments: [],
    aiUsageLogs: [],
    asrProviderConfigs: [],
    asrUsageLogs: [],
    nvsShadows: [],
    nvsBackups: [],
    tasks: [],
    albumSources: [],
    albumSourceCredentials: [],
    albumExternalIndex: [],
    imageAssets: [],
    playCollections: [],
    playCollectionItems: [],
    imageImportJobs: [],
    imageImportJobItems: [],
    collectionSourceRules: [],
    sourceSyncLogs: [],
    e6RenderedAssets: [],
  };
}

function createPayloadOnlySpec(key, table, idPrefix = "row") {
  return {
    key,
    table,
    createSql: `
      CREATE TABLE IF NOT EXISTS ${quoteId(table)} (
        id VARCHAR(80) NOT NULL PRIMARY KEY,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        KEY idx_${table}_sort (sort_index),
        KEY idx_${table}_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: ["id", "payload_json", "created_at", "updated_at", "sort_index"],
    toRecord: (row = {}, index = 0) => ({
      id: normalizeStringField(row.id || `${idPrefix}_${index + 1}`),
      payload_json: safeJSONString(row),
      created_at: toDbDateTime(row.createdAt, true),
      updated_at: toDbDateTime(row.updatedAt || row.createdAt, true),
      sort_index: index,
    }),
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      if (payload && typeof payload === "object" && Object.keys(payload).length) {
        return {
          ...payload,
          id: normalizeStringField(payload.id || record.id || ""),
          createdAt: payload.createdAt || fromDbDateTime(record.created_at),
          updatedAt: payload.updatedAt || fromDbDateTime(record.updated_at),
        };
      }
      return {
        id: normalizeStringField(record.id || ""),
        createdAt: fromDbDateTime(record.created_at),
        updatedAt: fromDbDateTime(record.updated_at),
      };
    },
  };
}

const CORE_COLLECTION_SPECS = [
  {
    key: "users",
    table: "users",
    createSql: `
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        username VARCHAR(128) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'user',
        nickname VARCHAR(128) NOT NULL DEFAULT '',
        avatar VARCHAR(512) NOT NULL DEFAULT '',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        status VARCHAR(32) NOT NULL DEFAULT 'enabled',
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        UNIQUE KEY uq_users_username (username),
        KEY idx_users_role_active (role, is_active),
        KEY idx_users_sort (sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: [
      "id",
      "username",
      "password_hash",
      "role",
      "nickname",
      "avatar",
      "is_active",
      "status",
      "payload_json",
      "created_at",
      "updated_at",
      "sort_index",
    ],
    toRecord: (row = {}, index = 0) => {
      const status = normalizeStringField(row.status || "enabled");
      return {
        id: normalizeStringField(row.id || createId("u")),
        username: normalizeStringField(row.username || ""),
        password_hash: normalizeStringField(row.passwordHash || row.password_hash || ""),
        role: normalizeStringField(row.role || "user"),
        nickname: normalizeStringField(row.nickname || ""),
        avatar: normalizeStringField(row.avatar || ""),
        is_active: status === "disabled" ? 0 : 1,
        status,
        payload_json: safeJSONString(row),
        created_at: toDbDateTime(row.createdAt, true),
        updated_at: toDbDateTime(row.updatedAt || row.createdAt, true),
        sort_index: index,
      };
    },
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      return {
        ...payload,
        id: normalizeStringField(payload.id || record.id || ""),
        username: normalizeStringField(payload.username || record.username || ""),
        passwordHash: normalizeStringField(payload.passwordHash || record.password_hash || ""),
        role: normalizeStringField(payload.role || record.role || "user"),
        nickname: normalizeStringField(payload.nickname || record.nickname || ""),
        avatar: normalizeStringField(payload.avatar || record.avatar || ""),
        status: normalizeStringField(payload.status || record.status || (Number(record.is_active || 0) ? "enabled" : "disabled")),
        createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(record.created_at) || ""),
        updatedAt: normalizeStringField(payload.updatedAt || fromDbDateTime(record.updated_at) || ""),
      };
    },
  },
  {
    key: "devices",
    table: "devices",
    createSql: `
      CREATE TABLE IF NOT EXISTS devices (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        device_id VARCHAR(128) NOT NULL,
        name VARCHAR(255) NOT NULL DEFAULT '',
        owner_id VARCHAR(64) NOT NULL DEFAULT '',
        cluster_id VARCHAR(64) NOT NULL DEFAULT '',
        model VARCHAR(64) NOT NULL DEFAULT 'ink-screen',
        status VARCHAR(32) NOT NULL DEFAULT 'enabled',
        last_seen_at DATETIME NULL,
        firmware_version VARCHAR(128) NOT NULL DEFAULT '',
        metadata_json LONGTEXT NOT NULL,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        UNIQUE KEY uq_devices_device_id (device_id),
        KEY idx_devices_owner (owner_id),
        KEY idx_devices_cluster (cluster_id),
        KEY idx_devices_status (status),
        KEY idx_devices_sort (sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: [
      "id",
      "device_id",
      "name",
      "owner_id",
      "cluster_id",
      "model",
      "status",
      "last_seen_at",
      "firmware_version",
      "metadata_json",
      "payload_json",
      "created_at",
      "updated_at",
      "sort_index",
    ],
    toRecord: (row = {}, index = 0) => {
      const meta = {
        name: row.name || "",
        displayName: row.displayName || "",
        defaultView: row.defaultView || "",
        remark: row.remark || "",
        bindState: row.bindState || "",
        boundAt: row.boundAt || "",
        boundBy: row.boundBy || "",
        simulated: Boolean(row.simulated),
        apiKeys: normalizeObjectField(row.apiKeys),
        thirdApiParams: normalizeObjectField(row.thirdApiParams),
        thirdApiCache: normalizeObjectField(row.thirdApiCache),
        deviceVariables: normalizeObjectField(row.deviceVariables),
      };
      return {
        id: normalizeStringField(row.id || createId("dev")),
        device_id: normalizeStringField(row.deviceId || row.id || ""),
        name: normalizeStringField(row.displayName || row.name || row.id || ""),
        owner_id: normalizeStringField(row.ownerId || ""),
        cluster_id: normalizeStringField(row.clusterId || ""),
        model: normalizeStringField(row.type || row.model || "ink-screen"),
        status: normalizeStringField(row.status || "enabled"),
        last_seen_at: toDbDateTime(row.lastSeenAt || row.lastLoginAt, false),
        firmware_version: normalizeStringField(row.firmwareVersion || ""),
        metadata_json: safeJSONString(meta),
        payload_json: safeJSONString(row),
        created_at: toDbDateTime(row.createdAt, true),
        updated_at: toDbDateTime(row.updatedAt || row.createdAt, true),
        sort_index: index,
      };
    },
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      const meta = safeJSONParse(record.metadata_json, {});
      const merged = { ...meta, ...payload };
      if (!merged.id) merged.id = normalizeStringField(record.id || "");
      if (!merged.deviceId) merged.deviceId = normalizeStringField(record.device_id || record.id || "");
      if (!merged.ownerId) merged.ownerId = normalizeStringField(record.owner_id || "");
      if (!merged.clusterId) merged.clusterId = normalizeStringField(record.cluster_id || "");
      if (!merged.type) merged.type = normalizeStringField(record.model || "ink-screen");
      if (!merged.status) merged.status = normalizeStringField(record.status || "enabled");
      if (!merged.firmwareVersion) merged.firmwareVersion = normalizeStringField(record.firmware_version || "");
      if (!merged.createdAt) merged.createdAt = fromDbDateTime(record.created_at);
      if (!merged.updatedAt) merged.updatedAt = fromDbDateTime(record.updated_at);
      if (!merged.lastSeenAt) merged.lastSeenAt = fromDbDateTime(record.last_seen_at, "");
      return merged;
    },
  },
  {
    key: "clusters",
    table: "clusters",
    createSql: `
      CREATE TABLE IF NOT EXISTS clusters (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        owner_id VARCHAR(64) NOT NULL DEFAULT '',
        description TEXT NULL,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        KEY idx_clusters_owner (owner_id),
        KEY idx_clusters_sort (sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: ["id", "name", "owner_id", "description", "payload_json", "created_at", "updated_at", "sort_index"],
    toRecord: (row = {}, index = 0) => ({
      id: normalizeStringField(row.id || createId("cluster")),
      name: normalizeStringField(row.name || ""),
      owner_id: normalizeStringField(row.ownerId || ""),
      description: normalizeStringField(row.description || row.remark || ""),
      payload_json: safeJSONString(row),
      created_at: toDbDateTime(row.createdAt, true),
      updated_at: toDbDateTime(row.updatedAt || row.createdAt, true),
      sort_index: index,
    }),
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      return {
        ...payload,
        id: normalizeStringField(payload.id || record.id || ""),
        name: normalizeStringField(payload.name || record.name || ""),
        ownerId: normalizeStringField(payload.ownerId || record.owner_id || ""),
        description: normalizeStringField(payload.description || record.description || ""),
        createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(record.created_at) || ""),
        updatedAt: normalizeStringField(payload.updatedAt || fromDbDateTime(record.updated_at) || ""),
      };
    },
  },
  {
    key: "bindingPins",
    table: "binding_pins",
    createSql: `
      CREATE TABLE IF NOT EXISTS binding_pins (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        pin_code VARCHAR(32) NOT NULL,
        device_id VARCHAR(128) NOT NULL DEFAULT '',
        mac VARCHAR(64) NOT NULL DEFAULT '',
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        expires_at DATETIME NULL,
        used_at DATETIME NULL,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        UNIQUE KEY uq_binding_pins_pin_code (pin_code),
        KEY idx_binding_pins_device (device_id),
        KEY idx_binding_pins_status (status),
        KEY idx_binding_pins_sort (sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: [
      "id",
      "pin_code",
      "device_id",
      "mac",
      "status",
      "expires_at",
      "used_at",
      "payload_json",
      "created_at",
      "updated_at",
      "sort_index",
    ],
    toRecord: (row = {}, index = 0) => ({
      id: normalizeStringField(row.id || (row.pin ? `pin_${String(row.pin)}` : `pin_${index + 1}`)),
      pin_code: normalizeStringField(row.pin || ""),
      device_id: normalizeStringField(row.deviceId || ""),
      mac: normalizeStringField(row.mac || ""),
      status: normalizeStringField(row.status || "pending"),
      expires_at: toDbDateTime(row.expiresAt, false),
      used_at: toDbDateTime(row.usedAt, false),
      payload_json: safeJSONString(row),
      created_at: toDbDateTime(row.createdAt, true),
      updated_at: toDbDateTime(row.updatedAt || row.createdAt, true),
      sort_index: index,
    }),
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      return {
        ...payload,
        id: normalizeStringField(payload.id || record.id || ""),
        pin: normalizeStringField(payload.pin || record.pin_code || ""),
        deviceId: normalizeStringField(payload.deviceId || record.device_id || ""),
        mac: normalizeStringField(payload.mac || record.mac || ""),
        status: normalizeStringField(payload.status || record.status || "pending"),
        expiresAt: normalizeStringField(payload.expiresAt || fromDbDateTime(record.expires_at, "") || ""),
        usedAt: normalizeStringField(payload.usedAt || fromDbDateTime(record.used_at, "") || ""),
        createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(record.created_at) || ""),
        updatedAt: normalizeStringField(payload.updatedAt || fromDbDateTime(record.updated_at) || ""),
      };
    },
  },
  {
    key: "firmwares",
    table: "firmwares",
    createSql: `
      CREATE TABLE IF NOT EXISTS firmwares (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        version VARCHAR(64) NOT NULL,
        filename VARCHAR(255) NOT NULL DEFAULT '',
        size BIGINT NOT NULL DEFAULT 0,
        sha256 VARCHAR(128) NOT NULL DEFAULT '',
        mongo_grid_id VARCHAR(128) NOT NULL DEFAULT '',
        platform VARCHAR(64) NOT NULL DEFAULT 'ink-screen',
        description TEXT NULL,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        KEY idx_firmwares_version_platform (version, platform),
        KEY idx_firmwares_sha256 (sha256),
        KEY idx_firmwares_sort (sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: [
      "id",
      "version",
      "filename",
      "size",
      "sha256",
      "mongo_grid_id",
      "platform",
      "description",
      "payload_json",
      "created_at",
      "updated_at",
      "sort_index",
    ],
    toRecord: (row = {}, index = 0) => ({
      id: normalizeStringField(row.id || createId("fw")),
      version: normalizeStringField(row.version || ""),
      filename: normalizeStringField(row.fileName || row.filename || ""),
      size: Number(row.fileSize || row.size || 0),
      sha256: normalizeStringField(row.sha256 || ""),
      mongo_grid_id: normalizeStringField(row.gridId || row.mongoGridId || ""),
      platform: normalizeStringField(row.deviceType || row.platform || "ink-screen"),
      description: normalizeStringField(row.releaseNote || row.description || ""),
      payload_json: safeJSONString(row),
      created_at: toDbDateTime(row.createdAt, true),
      updated_at: toDbDateTime(row.updatedAt || row.createdAt, true),
      sort_index: index,
    }),
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      return {
        ...payload,
        id: normalizeStringField(payload.id || record.id || ""),
        version: normalizeStringField(payload.version || record.version || ""),
        fileName: normalizeStringField(payload.fileName || record.filename || ""),
        fileSize: Number(payload.fileSize || record.size || 0),
        sha256: normalizeStringField(payload.sha256 || record.sha256 || ""),
        gridId: normalizeStringField(payload.gridId || record.mongo_grid_id || ""),
        deviceType: normalizeStringField(payload.deviceType || record.platform || "ink-screen"),
        releaseNote: normalizeStringField(payload.releaseNote || record.description || ""),
        createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(record.created_at) || ""),
        updatedAt: normalizeStringField(payload.updatedAt || fromDbDateTime(record.updated_at) || ""),
      };
    },
  },
  {
    key: "upgradeJobs",
    table: "upgrade_jobs",
    createSql: `
      CREATE TABLE IF NOT EXISTS upgrade_jobs (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        job_id VARCHAR(64) NOT NULL,
        target_type VARCHAR(32) NOT NULL DEFAULT 'device',
        target_id VARCHAR(128) NOT NULL DEFAULT '',
        firmware_id VARCHAR(64) NOT NULL DEFAULT '',
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        progress INT NOT NULL DEFAULT 0,
        message TEXT NULL,
        created_by VARCHAR(64) NOT NULL DEFAULT '',
        finished_at DATETIME NULL,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        UNIQUE KEY uq_upgrade_jobs_job_id (job_id),
        KEY idx_upgrade_jobs_target (target_type, target_id),
        KEY idx_upgrade_jobs_status (status),
        KEY idx_upgrade_jobs_sort (sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: [
      "id",
      "job_id",
      "target_type",
      "target_id",
      "firmware_id",
      "status",
      "progress",
      "message",
      "created_by",
      "finished_at",
      "payload_json",
      "created_at",
      "updated_at",
      "sort_index",
    ],
    toRecord: (row = {}, index = 0) => ({
      id: normalizeStringField(row.id || createId("job")),
      job_id: normalizeStringField(row.jobId || row.id || ""),
      target_type: normalizeStringField(row.targetType || "device"),
      target_id: normalizeStringField(row.targetId || row.deviceId || ""),
      firmware_id: normalizeStringField(row.firmwareId || ""),
      status: normalizeStringField(row.status || "pending"),
      progress: Number(row.progress || 0),
      message: normalizeStringField(row.message || ""),
      created_by: normalizeStringField(row.createdBy || row.operatorId || ""),
      finished_at: toDbDateTime(row.finishedAt, false),
      payload_json: safeJSONString(row),
      created_at: toDbDateTime(row.createdAt, true),
      updated_at: toDbDateTime(row.updatedAt || row.createdAt, true),
      sort_index: index,
    }),
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      return {
        ...payload,
        id: normalizeStringField(payload.id || record.id || ""),
        jobId: normalizeStringField(payload.jobId || record.job_id || ""),
        targetType: normalizeStringField(payload.targetType || record.target_type || "device"),
        targetId: normalizeStringField(payload.targetId || record.target_id || ""),
        firmwareId: normalizeStringField(payload.firmwareId || record.firmware_id || ""),
        status: normalizeStringField(payload.status || record.status || "pending"),
        progress: Number(payload.progress || record.progress || 0),
        message: normalizeStringField(payload.message || record.message || ""),
        createdBy: normalizeStringField(payload.createdBy || record.created_by || ""),
        finishedAt: normalizeStringField(payload.finishedAt || fromDbDateTime(record.finished_at, "") || ""),
        createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(record.created_at) || ""),
        updatedAt: normalizeStringField(payload.updatedAt || fromDbDateTime(record.updated_at) || ""),
      };
    },
  },
  {
    key: "todos",
    table: "todos",
    createSql: `
      CREATE TABLE IF NOT EXISTS todos (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        owner_id VARCHAR(64) NOT NULL DEFAULT '',
        device_id VARCHAR(128) NOT NULL DEFAULT '',
        content TEXT NULL,
        done TINYINT(1) NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        due_at DATETIME NULL,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        KEY idx_todos_owner (owner_id),
        KEY idx_todos_device_done (device_id, done),
        KEY idx_todos_sort (sort_order, sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: [
      "id",
      "owner_id",
      "device_id",
      "content",
      "done",
      "sort_order",
      "due_at",
      "payload_json",
      "created_at",
      "updated_at",
      "sort_index",
    ],
    toRecord: (row = {}, index = 0) => ({
      id: normalizeStringField(row.id || createId("todo")),
      owner_id: normalizeStringField(row.ownerId || ""),
      device_id: normalizeStringField(row.deviceId || ""),
      content: normalizeStringField(row.content || row.title || ""),
      done: row.done ? 1 : 0,
      sort_order: Number(row.sortOrder || row.orderIndex || 0),
      due_at: toDbDateTime(row.dueAt, false),
      payload_json: safeJSONString(row),
      created_at: toDbDateTime(row.createdAt, true),
      updated_at: toDbDateTime(row.updatedAt || row.createdAt, true),
      sort_index: index,
    }),
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      return {
        ...payload,
        id: normalizeStringField(payload.id || record.id || ""),
        ownerId: normalizeStringField(payload.ownerId || record.owner_id || ""),
        deviceId: normalizeStringField(payload.deviceId || record.device_id || ""),
        content: normalizeStringField(payload.content || record.content || ""),
        done: payload.done !== undefined ? Boolean(payload.done) : Boolean(Number(record.done || 0)),
        sortOrder: Number(payload.sortOrder || record.sort_order || 0),
        dueAt: normalizeStringField(payload.dueAt || fromDbDateTime(record.due_at, "") || ""),
        createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(record.created_at) || ""),
        updatedAt: normalizeStringField(payload.updatedAt || fromDbDateTime(record.updated_at) || ""),
      };
    },
  },
  {
    key: "schedules",
    table: "schedules",
    createSql: `
      CREATE TABLE IF NOT EXISTS schedules (
        id VARCHAR(80) NOT NULL PRIMARY KEY,
        device_id VARCHAR(128) NOT NULL DEFAULT '',
        term_key VARCHAR(64) NOT NULL DEFAULT '',
        source VARCHAR(64) NOT NULL DEFAULT 'manual',
        source_key VARCHAR(128) NOT NULL DEFAULT '',
        xique_course_id VARCHAR(128) NOT NULL DEFAULT '',
        xique_class_key VARCHAR(128) NOT NULL DEFAULT '',
        course_name VARCHAR(255) NOT NULL DEFAULT '',
        title VARCHAR(255) NOT NULL DEFAULT '',
        content TEXT NULL,
        teacher_name VARCHAR(128) NOT NULL DEFAULT '',
        location VARCHAR(255) NOT NULL DEFAULT '',
        weekday TINYINT UNSIGNED NOT NULL DEFAULT 1,
        start_period INT NOT NULL DEFAULT 0,
        end_period INT NOT NULL DEFAULT 0,
        start_time VARCHAR(16) NOT NULL DEFAULT '',
        end_time VARCHAR(16) NOT NULL DEFAULT '',
        weeks_json LONGTEXT NOT NULL,
        week_rule VARCHAR(64) NOT NULL DEFAULT 'all',
        term_start_date VARCHAR(32) NOT NULL DEFAULT '',
        source_meta_json LONGTEXT NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        KEY idx_schedules_device_term_source (device_id, term_key, source),
        KEY idx_schedules_source_key (source_key),
        KEY idx_schedules_xique_class_key (xique_class_key),
        KEY idx_schedules_weekday_period (weekday, start_period, end_period),
        KEY idx_schedules_active (is_active),
        KEY idx_schedules_sort (sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: [
      "id",
      "device_id",
      "term_key",
      "source",
      "source_key",
      "xique_course_id",
      "xique_class_key",
      "course_name",
      "title",
      "content",
      "teacher_name",
      "location",
      "weekday",
      "start_period",
      "end_period",
      "start_time",
      "end_time",
      "weeks_json",
      "week_rule",
      "term_start_date",
      "source_meta_json",
      "is_active",
      "payload_json",
      "created_at",
      "updated_at",
      "sort_index",
    ],
    toRecord: (row = {}, index = 0) => {
      const normalized = normalizeScheduleRow(row);
      const sourceMeta = normalizeObjectField(normalized.sourceMeta);
      const startPeriod =
        Number(sourceMeta.startPeriod || sourceMeta.startSection || sourceMeta.sectionStart || row.startPeriod || 0) || 0;
      const endPeriod =
        Number(sourceMeta.endPeriod || sourceMeta.endSection || sourceMeta.sectionEnd || row.endPeriod || startPeriod || 0) || 0;
      const teacherName = normalizeStringField(row.teacherName || sourceMeta.teacherName || "");
      const location = normalizeStringField(row.location || sourceMeta.location || "");
      return {
        id: normalizeStringField(normalized.id || createId("sch")),
        device_id: normalizeStringField(normalized.deviceId || ""),
        term_key: normalizeStringField(normalized.termKey || ""),
        source: normalizeStringField(normalized.source || "manual"),
        source_key: normalizeStringField(normalized.sourceKey || ""),
        xique_course_id: normalizeStringField(normalized.xiqueCourseId || ""),
        xique_class_key: normalizeStringField(normalized.xiqueClassKey || ""),
        course_name: normalizeStringField(normalized.courseName || normalized.title || ""),
        title: normalizeStringField(normalized.title || normalized.courseName || ""),
        content: normalizeStringField(normalized.content || normalized.note || ""),
        teacher_name: teacherName,
        location,
        weekday: Number(normalized.weekday || 1),
        start_period: Number(startPeriod || 0),
        end_period: Number(endPeriod || startPeriod || 0),
        start_time: normalizeStringField(normalized.startTime || ""),
        end_time: normalizeStringField(normalized.endTime || ""),
        weeks_json: safeJSONString(Array.isArray(normalized.weeks) ? normalized.weeks : []),
        week_rule: normalizeStringField(normalized.weekRule || "all"),
        term_start_date: normalizeStringField(normalized.termStartDate || ""),
        source_meta_json: safeJSONString(sourceMeta),
        is_active: normalized.isActive === false ? 0 : 1,
        payload_json: safeJSONString(normalized),
        created_at: toDbDateTime(normalized.createdAt, true),
        updated_at: toDbDateTime(normalized.updatedAt || normalized.createdAt, true),
        sort_index: index,
      };
    },
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      const sourceMeta = safeJSONParse(record.source_meta_json, {});
      const weeks = normalizeWeeksField(safeJSONParse(record.weeks_json, []));
      const merged = {
        ...sourceMeta,
        ...payload.sourceMeta,
      };
      const output = {
        ...payload,
        id: normalizeStringField(payload.id || record.id || ""),
        deviceId: normalizeStringField(payload.deviceId || record.device_id || ""),
        termKey: normalizeStringField(payload.termKey || record.term_key || ""),
        source: normalizeStringField(payload.source || record.source || "manual"),
        sourceKey: normalizeStringField(payload.sourceKey || record.source_key || ""),
        xiqueCourseId: normalizeStringField(payload.xiqueCourseId || record.xique_course_id || ""),
        xiqueClassKey: normalizeStringField(payload.xiqueClassKey || record.xique_class_key || ""),
        courseName: normalizeStringField(payload.courseName || record.course_name || ""),
        title: normalizeStringField(payload.title || record.title || ""),
        content: normalizeStringField(payload.content || record.content || ""),
        note: normalizeStringField(payload.note || payload.content || record.content || ""),
        weekday: Number(payload.weekday || record.weekday || 1),
        startTime: normalizeStringField(payload.startTime || record.start_time || ""),
        endTime: normalizeStringField(payload.endTime || record.end_time || ""),
        weeks: Array.isArray(payload.weeks) && payload.weeks.length ? payload.weeks : weeks,
        weekRule: normalizeStringField(payload.weekRule || record.week_rule || "all"),
        termStartDate: normalizeStringField(payload.termStartDate || record.term_start_date || ""),
        sourceMeta: {
          ...merged,
          teacherName: normalizeStringField(payload?.sourceMeta?.teacherName || record.teacher_name || ""),
          location: normalizeStringField(payload?.sourceMeta?.location || record.location || ""),
          startPeriod:
            Number(payload?.sourceMeta?.startPeriod || payload.startPeriod || record.start_period || 0) || 0,
          endPeriod: Number(payload?.sourceMeta?.endPeriod || payload.endPeriod || record.end_period || 0) || 0,
          weeks: Array.isArray(payload?.sourceMeta?.weeks) && payload.sourceMeta.weeks.length ? payload.sourceMeta.weeks : weeks,
          weekRule: normalizeStringField(payload?.sourceMeta?.weekRule || record.week_rule || payload.weekRule || "all"),
          termStartDate: normalizeStringField(
            payload?.sourceMeta?.termStartDate || record.term_start_date || payload.termStartDate || ""
          ),
        },
        isActive: payload.isActive !== undefined ? Boolean(payload.isActive) : Boolean(Number(record.is_active || 1)),
        createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(record.created_at) || ""),
        updatedAt: normalizeStringField(payload.updatedAt || fromDbDateTime(record.updated_at) || ""),
      };
      return normalizeScheduleRow(output);
    },
  },
  {
    key: "scheduleSyncConfigs",
    table: "schedule_sync_configs",
    createSql: `
      CREATE TABLE IF NOT EXISTS schedule_sync_configs (
        id VARCHAR(80) NOT NULL PRIMARY KEY,
        device_id VARCHAR(128) NOT NULL DEFAULT '',
        source VARCHAR(32) NOT NULL DEFAULT 'xique',
        username VARCHAR(128) NOT NULL DEFAULT '',
        encrypted_password TEXT NULL,
        term_start_date VARCHAR(32) NOT NULL DEFAULT '',
        interval_minutes INT NOT NULL DEFAULT 60,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        need_relogin TINYINT(1) NOT NULL DEFAULT 0,
        need_captcha_reverify TINYINT(1) NOT NULL DEFAULT 0,
        paused TINYINT(1) NOT NULL DEFAULT 0,
        next_run_at DATETIME NULL,
        last_sync_at DATETIME NULL,
        last_sync_status VARCHAR(64) NOT NULL DEFAULT '',
        last_error TEXT NULL,
        extra_json LONGTEXT NOT NULL,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        UNIQUE KEY uq_schedule_sync_device_source (device_id, source),
        KEY idx_schedule_sync_next_run (next_run_at),
        KEY idx_schedule_sync_status (last_sync_status),
        KEY idx_schedule_sync_sort (sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: [
      "id",
      "device_id",
      "source",
      "username",
      "encrypted_password",
      "term_start_date",
      "interval_minutes",
      "enabled",
      "need_relogin",
      "need_captcha_reverify",
      "paused",
      "next_run_at",
      "last_sync_at",
      "last_sync_status",
      "last_error",
      "extra_json",
      "payload_json",
      "created_at",
      "updated_at",
      "sort_index",
    ],
    toRecord: (row = {}, index = 0) => {
      const normalized = normalizeScheduleSyncConfigRow(row);
      const extra = {
        ownerId: normalized.ownerId || "",
        currentTermKey: normalized.currentTermKey || "",
        currentWeek: normalized.currentWeek,
        currentWeekAt: normalized.currentWeekAt || "",
        currentWeekSource: normalized.currentWeekSource || "",
        adapterMode: normalized.adapterMode || "",
        baseUrl: normalized.baseUrl || "",
        sampleUrl: normalized.sampleUrl || "",
        sampleHtml: normalized.sampleHtml || "",
        sampleJson: normalizeObjectField(normalized.sampleJson),
        requireCaptcha: Boolean(normalized.requireCaptcha),
        pauseReason: normalized.pauseReason || "",
        pauseUntil: normalized.pauseUntil || "",
        failureCount: Number(normalized.failureCount || 0),
        lastAttemptAt: normalized.lastAttemptAt || "",
        lastSuccessAt: normalized.lastSuccessAt || "",
        lastSyncErrorCode: normalized.lastSyncErrorCode || "",
        loginDisplayName: normalized.loginDisplayName || "",
      };
      return {
        id: normalizeStringField(normalized.id || createId("xsync")),
        device_id: normalizeStringField(normalized.deviceId || ""),
        source: normalizeStringField(normalized.source || "xique"),
        username: normalizeStringField(normalized.loginUsername || normalized.username || ""),
        encrypted_password: normalizeStringField(normalized.encryptedPassword || normalized.credentialCipher || ""),
        term_start_date: normalizeStringField(normalized.termStartDate || ""),
        interval_minutes: normalizeIntervalMinutes(normalized.intervalMinutes),
        enabled: normalized.enabled ? 1 : 0,
        need_relogin: normalized.needRelogin ? 1 : 0,
        need_captcha_reverify: normalized.needCaptchaReverify ? 1 : 0,
        paused: normalized.paused ? 1 : 0,
        next_run_at: toDbDateTime(normalized.nextRunAt, false),
        last_sync_at: toDbDateTime(normalized.lastSyncAt || normalized.lastSuccessAt, false),
        last_sync_status: normalizeStringField(normalized.lastSyncStatus || ""),
        last_error: normalizeStringField(normalized.lastError || ""),
        extra_json: safeJSONString(extra),
        payload_json: safeJSONString(normalized),
        created_at: toDbDateTime(normalized.createdAt, true),
        updated_at: toDbDateTime(normalized.updatedAt || normalized.createdAt, true),
        sort_index: index,
      };
    },
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      const extra = safeJSONParse(record.extra_json, {});
      return normalizeScheduleSyncConfigRow({
        ...extra,
        ...payload,
        id: normalizeStringField(payload.id || record.id || ""),
        deviceId: normalizeStringField(payload.deviceId || record.device_id || ""),
        source: normalizeStringField(payload.source || record.source || "xique"),
        loginUsername: normalizeStringField(payload.loginUsername || record.username || ""),
        encryptedPassword: normalizeStringField(payload.encryptedPassword || record.encrypted_password || ""),
        termStartDate: normalizeStringField(payload.termStartDate || record.term_start_date || ""),
        intervalMinutes: Number(payload.intervalMinutes || record.interval_minutes || 60),
        enabled: payload.enabled !== undefined ? Boolean(payload.enabled) : Boolean(Number(record.enabled || 0)),
        needRelogin:
          payload.needRelogin !== undefined ? Boolean(payload.needRelogin) : Boolean(Number(record.need_relogin || 0)),
        needCaptchaReverify:
          payload.needCaptchaReverify !== undefined
            ? Boolean(payload.needCaptchaReverify)
            : Boolean(Number(record.need_captcha_reverify || 0)),
        paused: payload.paused !== undefined ? Boolean(payload.paused) : Boolean(Number(record.paused || 0)),
        nextRunAt: normalizeStringField(payload.nextRunAt || fromDbDateTime(record.next_run_at, "") || ""),
        lastSyncAt: normalizeStringField(payload.lastSyncAt || fromDbDateTime(record.last_sync_at, "") || ""),
        lastSyncStatus: normalizeStringField(payload.lastSyncStatus || record.last_sync_status || ""),
        lastError: normalizeStringField(payload.lastError || record.last_error || ""),
        createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(record.created_at) || ""),
        updatedAt: normalizeStringField(payload.updatedAt || fromDbDateTime(record.updated_at) || ""),
      });
    },
  },
  {
    key: "apiTemplates",
    table: "api_templates",
    createSql: `
      CREATE TABLE IF NOT EXISTS api_templates (
        id VARCHAR(80) NOT NULL PRIMARY KEY,
        owner_id VARCHAR(64) NOT NULL DEFAULT '',
        slug VARCHAR(128) NOT NULL,
        name VARCHAR(255) NOT NULL,
        method VARCHAR(16) NOT NULL DEFAULT 'GET',
        url TEXT NULL,
        template_json LONGTEXT NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        KEY idx_api_templates_slug (slug),
        KEY idx_api_templates_owner (owner_id),
        KEY idx_api_templates_active (is_active),
        KEY idx_api_templates_sort (sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: [
      "id",
      "owner_id",
      "slug",
      "name",
      "method",
      "url",
      "template_json",
      "is_active",
      "payload_json",
      "created_at",
      "updated_at",
      "sort_index",
    ],
    toRecord: (row = {}, index = 0) => ({
      id: normalizeStringField(row.id || createId("tpl")),
      owner_id: normalizeStringField(row.ownerId || ""),
      slug: normalizeStringField(row.slug || ""),
      name: normalizeStringField(row.name || ""),
      method: normalizeStringField(row.method || "GET").toUpperCase(),
      url: normalizeStringField(row.url || ""),
      template_json: safeJSONString({
        keyField: row.keyField || "",
        keyIn: Array.isArray(row.keyIn) ? row.keyIn : [],
        deviceKeyRequired: Boolean(row.deviceKeyRequired),
        defaultParams: normalizeObjectField(row.defaultParams),
        userInputFields: Array.isArray(row.userInputFields) ? row.userInputFields : [],
        enabled: row.enabled !== false,
        builtin: Boolean(row.builtin),
        advancedEnabled: row.advancedEnabled !== false,
        advancedConfig: ensureTemplateAdvancedConfig(row.advancedConfig, row.method, row.url),
        keyConcatEnabled: Boolean(row.keyConcatEnabled),
        keyConcatFields: Array.isArray(row.keyConcatFields) ? row.keyConcatFields : [],
        keyConcatSeparator: normalizeStringField(row.keyConcatSeparator || "|"),
        refreshConfig: normalizeTemplateRefreshConfig(row.refreshConfig, { slug: row.slug }),
      }),
      is_active: row.enabled === false ? 0 : 1,
      payload_json: safeJSONString(row),
      created_at: toDbDateTime(row.createdAt, true),
      updated_at: toDbDateTime(row.updatedAt || row.createdAt, true),
      sort_index: index,
    }),
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      const tplJson = safeJSONParse(record.template_json, {});
      return {
        ...tplJson,
        ...payload,
        id: normalizeStringField(payload.id || record.id || ""),
        ownerId: normalizeStringField(payload.ownerId || record.owner_id || ""),
        slug: normalizeStringField(payload.slug || record.slug || ""),
        name: normalizeStringField(payload.name || record.name || ""),
        method: normalizeStringField(payload.method || record.method || "GET").toUpperCase(),
        url: normalizeStringField(payload.url || record.url || ""),
        enabled: payload.enabled !== undefined ? Boolean(payload.enabled) : Boolean(Number(record.is_active || 1)),
        refreshConfig: normalizeTemplateRefreshConfig(
          payload.refreshConfig || tplJson.refreshConfig,
          { slug: payload.slug || record.slug || "" }
        ),
        createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(record.created_at) || ""),
        updatedAt: normalizeStringField(payload.updatedAt || fromDbDateTime(record.updated_at) || ""),
      };
    },
  },
  {
    key: "tfFiles",
    table: "tf_files",
    createSql: `
      CREATE TABLE IF NOT EXISTS tf_files (
        id VARCHAR(80) NOT NULL PRIMARY KEY,
        owner_id VARCHAR(64) NOT NULL DEFAULT '',
        device_id VARCHAR(128) NOT NULL DEFAULT '',
        filename VARCHAR(255) NOT NULL DEFAULT '',
        category VARCHAR(64) NOT NULL DEFAULT '',
        size BIGINT NOT NULL DEFAULT 0,
        sha256 VARCHAR(128) NOT NULL DEFAULT '',
        mongo_grid_id VARCHAR(128) NOT NULL DEFAULT '',
        extra_json LONGTEXT NOT NULL,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        KEY idx_tf_files_device (device_id),
        KEY idx_tf_files_owner (owner_id),
        KEY idx_tf_files_category (category),
        KEY idx_tf_files_sort (sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: [
      "id",
      "owner_id",
      "device_id",
      "filename",
      "category",
      "size",
      "sha256",
      "mongo_grid_id",
      "extra_json",
      "payload_json",
      "created_at",
      "updated_at",
      "sort_index",
    ],
    toRecord: (row = {}, index = 0) => ({
      id: normalizeStringField(row.id || createId("tf")),
      owner_id: normalizeStringField(row.ownerId || ""),
      device_id: normalizeStringField(row.deviceId || ""),
      filename: normalizeStringField(row.name || row.originalName || row.filename || ""),
      category: normalizeStringField(row.category || "read"),
      size: Number(row.size || 0),
      sha256: normalizeStringField(row.sha256 || ""),
      mongo_grid_id: normalizeStringField(row.gridId || row.mongoGridId || ""),
      extra_json: safeJSONString({
        mime: row.mime || "",
        url: row.url || "",
        originalName: row.originalName || "",
      }),
      payload_json: safeJSONString(row),
      created_at: toDbDateTime(row.createdAt, true),
      updated_at: toDbDateTime(row.updatedAt || row.createdAt, true),
      sort_index: index,
    }),
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      const extra = safeJSONParse(record.extra_json, {});
      return {
        ...extra,
        ...payload,
        id: normalizeStringField(payload.id || record.id || ""),
        ownerId: normalizeStringField(payload.ownerId || record.owner_id || ""),
        deviceId: normalizeStringField(payload.deviceId || record.device_id || ""),
        name: normalizeStringField(payload.name || record.filename || ""),
        originalName: normalizeStringField(payload.originalName || extra.originalName || record.filename || ""),
        category: normalizeStringField(payload.category || record.category || "read"),
        size: Number(payload.size || record.size || 0),
        sha256: normalizeStringField(payload.sha256 || record.sha256 || ""),
        gridId: normalizeStringField(payload.gridId || record.mongo_grid_id || ""),
        mime: normalizeStringField(payload.mime || extra.mime || ""),
        url: normalizeStringField(payload.url || extra.url || ""),
        createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(record.created_at) || ""),
        updatedAt: normalizeStringField(payload.updatedAt || fromDbDateTime(record.updated_at) || ""),
      };
    },
  },
  {
    key: "syncLogs",
    table: "sync_logs",
    createSql: `
      CREATE TABLE IF NOT EXISTS sync_logs (
        id VARCHAR(80) NOT NULL PRIMARY KEY,
        device_id VARCHAR(128) NOT NULL DEFAULT '',
        source VARCHAR(64) NOT NULL DEFAULT 'xique',
        task_id VARCHAR(128) NOT NULL DEFAULT '',
        status VARCHAR(64) NOT NULL DEFAULT 'info',
        message TEXT NULL,
        detail_json LONGTEXT NOT NULL,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        sort_index INT NOT NULL DEFAULT 0,
        KEY idx_sync_logs_device_source (device_id, source),
        KEY idx_sync_logs_task (task_id),
        KEY idx_sync_logs_created (created_at),
        KEY idx_sync_logs_sort (sort_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    columns: [
      "id",
      "device_id",
      "source",
      "task_id",
      "status",
      "message",
      "detail_json",
      "payload_json",
      "created_at",
      "updated_at",
      "sort_index",
    ],
    toRecord: (row = {}, index = 0) => ({
      id: normalizeStringField(row.id || createId("xslog")),
      device_id: normalizeStringField(row.deviceId || ""),
      source: normalizeStringField(row.source || "xique"),
      task_id: normalizeStringField(row.taskId || row.configId || ""),
      status: normalizeStringField(row.status || "info"),
      message: normalizeStringField(row.message || row.action || ""),
      detail_json: safeJSONString(normalizeObjectField(row.detail)),
      payload_json: safeJSONString(row),
      created_at: toDbDateTime(row.createdAt, true),
      updated_at: toDbDateTime(row.updatedAt || row.createdAt, true),
      sort_index: index,
    }),
    fromRecord: (record = {}) => {
      const payload = safeJSONParse(record.payload_json, {});
      const detail = safeJSONParse(record.detail_json, {});
      return normalizeSyncLogRow({
        ...payload,
        id: normalizeStringField(payload.id || record.id || ""),
        deviceId: normalizeStringField(payload.deviceId || record.device_id || ""),
        source: normalizeStringField(payload.source || record.source || "xique"),
        configId: normalizeStringField(payload.configId || payload.taskId || record.task_id || ""),
        status: normalizeStringField(payload.status || record.status || "info"),
        action: normalizeStringField(payload.action || record.message || ""),
        detail: normalizeObjectField(payload.detail && typeof payload.detail === "object" ? payload.detail : detail),
        createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(record.created_at) || ""),
      });
    },
  },
];

const AUX_COLLECTION_SPECS = [
  createPayloadOnlySpec("tfDeviceFiles", "tf_device_files", "tfdev"),
  createPayloadOnlySpec("fullFirmwareBundles", "full_firmware_bundles", "fwfull"),
  createPayloadOnlySpec("operationLogs", "operation_logs", "oplog"),
  createPayloadOnlySpec("apiLogs", "api_logs", "apilog"),
  createPayloadOnlySpec("nameplateLayouts", "nameplate_layouts", "nlayout"),
  createPayloadOnlySpec("nameplateBatchPlans", "nameplate_batch_plans", "nplan"),
  createPayloadOnlySpec("nameplateHistory", "nameplate_history", "nhis"),
  createPayloadOnlySpec("homepageTemplates", "homepage_templates", "hptpl"),
  createPayloadOnlySpec("homepageConfigs", "homepage_configs", "hpcfg"),
  createPayloadOnlySpec("homepageImages", "homepage_images", "hpimg"),
  createPayloadOnlySpec("badgepageTemplates", "badgepage_templates", "bdtpl"),
  createPayloadOnlySpec("badgepageConfigs", "badgepage_configs", "bdcfg"),
  createPayloadOnlySpec("badgepageImages", "badgepage_images", "bdimg"),
  createPayloadOnlySpec("weatherpageTemplates", "weatherpage_templates", "wttpl"),
  createPayloadOnlySpec("weatherpageConfigs", "weatherpage_configs", "wtcfg"),
  createPayloadOnlySpec("weatherpageImages", "weatherpage_images", "wtimg"),
  createPayloadOnlySpec("remoteCommandAcks", "remote_command_acks", "rack"),
  createPayloadOnlySpec("taskPlans", "task_plans", "task"),
  createPayloadOnlySpec("taskRuns", "task_runs", "trun"),
  createPayloadOnlySpec("xiqueSessionVault", "xique_session_vault", "xvault"),
  createPayloadOnlySpec("aiSessions", "ai_sessions", "aisess"),
  createPayloadOnlySpec("aiMessages", "ai_messages", "aimsg"),
  createPayloadOnlySpec("aiToolCalls", "ai_tool_calls", "aitool"),
  createPayloadOnlySpec("aiConfirmations", "ai_confirmations", "aicfm"),
  createPayloadOnlySpec("aiProviderConfigs", "ai_provider_configs", "aicfg"),
  createPayloadOnlySpec("aiUserAssignments", "ai_user_assignments", "aiassign"),
  createPayloadOnlySpec("aiUsageLogs", "ai_usage_logs", "aiusage"),
  createPayloadOnlySpec("asrProviderConfigs", "asr_provider_configs", "asrcfg"),
  createPayloadOnlySpec("asrUsageLogs", "asr_usage_logs", "asrusage"),
  createPayloadOnlySpec("nvsShadows", "nvs_shadows", "nvs"),
  createPayloadOnlySpec("nvsBackups", "nvs_backups", "nvsbak"),
  createPayloadOnlySpec("tasks", "tasks", "task"),
  createPayloadOnlySpec("albumSources", "album_sources", "src"),
  createPayloadOnlySpec("albumSourceCredentials", "album_source_credentials", "cred"),
  createPayloadOnlySpec("albumExternalIndex", "album_external_index", "aidx"),
  createPayloadOnlySpec("imageAssets", "image_assets", "img"),
  createPayloadOnlySpec("playCollections", "play_collections", "col"),
  createPayloadOnlySpec("playCollectionItems", "play_collection_items", "coli"),
  createPayloadOnlySpec("imageImportJobs", "image_import_jobs", "ijob"),
  createPayloadOnlySpec("imageImportJobItems", "image_import_job_items", "ijobi"),
  createPayloadOnlySpec("collectionSourceRules", "collection_source_rules", "crule"),
  createPayloadOnlySpec("sourceSyncLogs", "source_sync_logs", "slog"),
  createPayloadOnlySpec("e6RenderedAssets", "e6_rendered_assets", "e6asset"),
];

const ALL_COLLECTION_SPECS = [...CORE_COLLECTION_SPECS, ...AUX_COLLECTION_SPECS];

const META_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS store_meta (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    version INT NOT NULL DEFAULT 2,
    payload_json LONGTEXT NOT NULL,
    created_at DATETIME NULL,
    updated_at DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function execQuery(conn, sql, params = [], label = "db query") {
  return withTimeout(conn.query(sql, params), dbOpTimeoutMs * 3, label);
}

async function getPool() {
  if (!mysqlPool) {
    mysqlPool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      charset: config.mysql.charset,
      waitForConnections: true,
      connectionLimit: Number(config.mysql.connectionLimit || 10),
      queueLimit: 0,
      connectTimeout: config.mysql.connectTimeoutMs,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }
  return mysqlPool.getConnection();
}

async function resetPool() {
  if (!mysqlPool) return;
  const pool = mysqlPool;
  mysqlPool = null;
  try {
    await pool.end();
  } catch (_) {
    // ignore
  }
}

async function closeConn(conn) {
  if (!conn) return;
  try {
    if (typeof conn.release === "function") {
      conn.release();
      return;
    }
    if (typeof conn.end === "function") {
      await conn.end();
      return;
    }
  } catch (_) {
    // ignore
  }
}

async function ensureSchema(conn) {
  await execQuery(conn, META_TABLE_SQL, [], "db create store_meta");
  for (const spec of ALL_COLLECTION_SPECS) {
    await execQuery(conn, spec.createSql, [], `db create ${spec.table}`);
  }
  await ensureMysqlIndexes(conn);
}

async function ensureMysqlIndexes(conn) {
  const indexes = [
    ["devices", "idx_devices_owner_status_updated", "CREATE INDEX idx_devices_owner_status_updated ON devices(owner_id, status, updated_at)"],
    ["devices", "idx_devices_owner_updated", "CREATE INDEX idx_devices_owner_updated ON devices(owner_id, updated_at)"],
    ["devices", "idx_devices_device_updated", "CREATE INDEX idx_devices_device_updated ON devices(device_id, updated_at)"],
    ["operation_logs", "idx_operation_logs_created", "CREATE INDEX idx_operation_logs_created ON operation_logs(created_at)"],
    ["api_logs", "idx_api_logs_created", "CREATE INDEX idx_api_logs_created ON api_logs(created_at)"],
    ["nameplate_history", "idx_nameplate_history_created", "CREATE INDEX idx_nameplate_history_created ON nameplate_history(created_at)"],
  ];
  for (const [table, indexName, sql] of indexes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await execQuery(conn, sql, [], `db create index ${indexName}`);
    } catch (error) {
      const msg = String(error?.message || error || "");
      if (!/Duplicate key name|already exists|1061/i.test(msg)) {
        // eslint-disable-next-line no-console
        console.warn(`[store] skip index ${table}.${indexName}: ${msg}`);
      }
    }
  }
}

async function tableExists(conn, name) {
  const [rows] = await execQuery(
    conn,
    "SELECT COUNT(1) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
    [String(name || "").replace(/`/g, "")],
    "db table exists"
  );
  return Number(rows?.[0]?.c || 0) > 0;
}

async function shouldBootstrapFromLegacy(conn) {
  const [metaRows] = await execQuery(conn, "SELECT COUNT(1) AS c FROM store_meta", [], "db count store_meta");
  if (Number(metaRows?.[0]?.c || 0) > 0) return false;
  for (const spec of CORE_COLLECTION_SPECS) {
    const [rows] = await execQuery(conn, `SELECT COUNT(1) AS c FROM ${quoteId(spec.table)}`, [], `db count ${spec.table}`);
    if (Number(rows?.[0]?.c || 0) > 0) {
      return false;
    }
  }
  return true;
}

async function loadLegacyState(conn) {
  const legacyTable = String(config.mysql.stateTable || "").replace(/`/g, "");
  if (!legacyTable) return null;
  if (!(await tableExists(conn, legacyTable))) return null;
  try {
    const [rows] = await execQuery(conn, `SELECT payload FROM ${tableName()} WHERE id = 1 LIMIT 1`, [], "db load legacy payload");
    if (!rows.length) return null;
    const parsed = safeJSONParse(rows[0].payload, null);
    if (!parsed || typeof parsed !== "object") return null;
    normalizeStoreShape(parsed);
    return parsed;
  } catch (_) {
    return null;
  }
}

async function replaceCollectionRows(conn, spec, rows) {
  await execQuery(conn, `DELETE FROM ${quoteId(spec.table)}`, [], `db clear ${spec.table}`);
  if (!Array.isArray(rows) || !rows.length) return;
  const chunkSize = 120;
  const columns = spec.columns;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const slice = rows.slice(start, start + chunkSize);
    const records = slice.map((row, idx) => spec.toRecord(row, start + idx));
    const placeholders = records.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
    const sql = `INSERT INTO ${quoteId(spec.table)} (${columns.map((col) => quoteId(col)).join(",")}) VALUES ${placeholders}`;
    const params = [];
    records.forEach((record) => {
      columns.forEach((col) => params.push(record[col]));
    });
    await execQuery(conn, sql, params, `db insert ${spec.table}`);
  }
}

async function loadCollectionRows(conn, spec) {
  const [rows] = await execQuery(
    conn,
    `SELECT * FROM ${quoteId(spec.table)} ORDER BY sort_index ASC, created_at ASC, id ASC`,
    [],
    `db load ${spec.table}`
  );
  return rows.map((record) => spec.fromRecord(record));
}

async function saveStoreMeta(conn, meta = {}) {
  const now = new Date().toISOString();
  const merged = {
    createdAt: normalizeStringField(meta.createdAt || now),
    updatedAt: normalizeStringField(meta.updatedAt || now),
    version: Number(meta.version || 2),
    migrations:
      meta.migrations && typeof meta.migrations === "object" && !Array.isArray(meta.migrations)
        ? meta.migrations
        : {},
  };
  const sql = `
    REPLACE INTO store_meta (id, version, payload_json, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?)
  `;
  await execQuery(
    conn,
    sql,
    [merged.version, safeJSONString(merged), toDbDateTime(merged.createdAt, true), toDbDateTime(merged.updatedAt, true)],
    "db save store_meta"
  );
}

async function loadStoreMeta(conn) {
  const [rows] = await execQuery(conn, "SELECT * FROM store_meta WHERE id = 1 LIMIT 1", [], "db load store_meta");
  if (!rows.length) {
    const now = new Date().toISOString();
    return {
      createdAt: now,
      updatedAt: now,
      version: 2,
      migrations: {},
    };
  }
  const row = rows[0];
  const payload = safeJSONParse(row.payload_json, {});
  return {
    createdAt: normalizeStringField(payload.createdAt || fromDbDateTime(row.created_at) || new Date().toISOString()),
    updatedAt: normalizeStringField(payload.updatedAt || fromDbDateTime(row.updated_at) || new Date().toISOString()),
    version: Number(payload.version || row.version || 2),
    migrations:
      payload.migrations && typeof payload.migrations === "object" && !Array.isArray(payload.migrations)
        ? payload.migrations
        : {},
  };
}

async function saveStateToTables(conn, state) {
  normalizeStoreShape(state);
  state.meta = state.meta || {};
  state.meta.updatedAt = new Date().toISOString();
  state.meta.version = Number(state.meta.version || 2);
  await saveStoreMeta(conn, state.meta);
  for (const spec of ALL_COLLECTION_SPECS) {
    const rows = Array.isArray(state[spec.key]) ? state[spec.key] : [];
    await replaceCollectionRows(conn, spec, rows);
  }
}

function captureCollectionFingerprints(state = {}) {
  const fingerprints = new Map();
  for (const spec of ALL_COLLECTION_SPECS) {
    const rows = Array.isArray(state[spec.key]) ? state[spec.key] : [];
    fingerprints.set(spec.key, safeJSONString(rows));
  }
  return fingerprints;
}

function detectChangedCollectionKeys(beforeFingerprints, state = {}) {
  const changed = [];
  for (const spec of ALL_COLLECTION_SPECS) {
    const rows = Array.isArray(state[spec.key]) ? state[spec.key] : [];
    if (beforeFingerprints?.get(spec.key) !== safeJSONString(rows)) {
      changed.push(spec.key);
    }
  }
  return changed;
}

async function saveStateChangesToTables(conn, state, changedKeys = []) {
  state.meta = state.meta || {};
  state.meta.updatedAt = new Date().toISOString();
  state.meta.version = Number(state.meta.version || 2);
  await saveStoreMeta(conn, state.meta);

  const keySet = new Set(Array.isArray(changedKeys) ? changedKeys : []);
  for (const spec of ALL_COLLECTION_SPECS) {
    if (!keySet.has(spec.key)) continue;
    const rows = Array.isArray(state[spec.key]) ? state[spec.key] : [];
    await replaceCollectionRows(conn, spec, rows);
  }
}

async function loadStateFromTables(conn) {
  const state = createEmptyState();
  state.meta = await loadStoreMeta(conn);
  for (const spec of ALL_COLLECTION_SPECS) {
    state[spec.key] = await loadCollectionRows(conn, spec);
  }
  const missingMigrations = missingRequiredStoreMigrations(state);
  normalizeStoreShape(state);
  Object.defineProperty(state, "__needsMigrationPersist", {
    value: missingMigrations.length > 0,
    enumerable: false,
    configurable: true,
  });
  return state;
}

async function migrateLegacyStateToMysqlTables(conn) {
  const legacy = await loadLegacyState(conn);
  if (!legacy) return false;
  normalizeStoreShape(legacy);
  if (await migrateDefaultCredentialIfNeeded(legacy)) {
    legacy.meta = legacy.meta || {};
    legacy.meta.updatedAt = new Date().toISOString();
  }
  await saveStateToTables(conn, legacy);
  return true;
}

const LEGACY_MEDIA_BACKFILL_KEYS = ["tfFiles", "imageAssets", "e6RenderedAssets"];

async function backfillLegacyMediaRowsIfNeeded(conn, state) {
  if (String(process.env.LEGACY_MEDIA_BACKFILL || "1") === "0") return false;
  const legacy = await loadLegacyState(conn);
  if (!legacy) return false;
  normalizeStoreShape(legacy);

  let changed = false;
  for (const key of LEGACY_MEDIA_BACKFILL_KEYS) {
    const currentRows = Array.isArray(state[key]) ? state[key] : [];
    const legacyRows = Array.isArray(legacy[key]) ? legacy[key] : [];
    if (!legacyRows.length) continue;

    const currentIds = new Set(currentRows.map((row) => String(row?.id || "")).filter(Boolean));
    const missingRows = legacyRows.filter((row) => {
      const id = String(row?.id || "");
      return id && !currentIds.has(id);
    });
    if (!missingRows.length) continue;

    state[key] = [...currentRows, ...missingRows];
    missingRows.forEach((row) => currentIds.add(String(row?.id || "")));
    changed = true;
    // eslint-disable-next-line no-console
    console.warn(`[store] legacy media backfill key=${key} added=${missingRows.length}`);
  }

  if (changed) {
    normalizeStoreShape(state);
    await saveStateToTables(conn, state);
  }
  return changed;
}

async function loadStoreFromDBWithRetry() {
  const maxAttempts = Math.max(1, Number(process.env.DB_INIT_RETRY_MAX || 3));
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let conn = null;
    try {
      conn = await withTimeout(getPool(), dbOpTimeoutMs, "db connect(init)");
      await ensureSchema(conn);

      if (await shouldBootstrapFromLegacy(conn)) {
        const migrated = await migrateLegacyStateToMysqlTables(conn);
        if (!migrated) {
          const initial = await getDefaultData();
          normalizeStoreShape(initial);
          await saveStateToTables(conn, initial);
        }
      }

      const loaded = await loadStateFromTables(conn);
      const credentialMigrated = await migrateDefaultCredentialIfNeeded(loaded);
      if (loaded.__needsMigrationPersist || credentialMigrated) {
        await saveStateToTables(conn, loaded);
      }
      await backfillLegacyMediaRowsIfNeeded(conn, loaded);
      return loaded;
    } catch (error) {
      lastError = error;
      await resetPool();
      if (attempt < maxAttempts) {
        const backoffMs = Math.min(2000, attempt * 400);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    } finally {
      await closeConn(conn);
    }
  }
  throw lastError || new Error("db init failed");
}

async function ensureStoreInitialized() {
  if (process.env.NODE_ENV === "test" && process.env.STORE_TEST_MEMORY_ONLY === "1") {
    await ensureMemoryStore();
    return cache;
  }
  if (initialized && cache && initializedFromDB) return cache;
  if (initialized && cache && !initializedFromDB && shouldBypassDB()) return cache;

  try {
    cache = await loadStoreFromDBWithRetry();
    initialized = true;
    initializedFromDB = true;
    warnedReadFallback = false;
    warnedWriteFallback = false;
    disableCacheReadMode();
    return cache;
  } catch (error) {
    await ensureMemoryStore();
    initializedFromDB = false;
    if (!warnedReadFallback) {
      warnFallback("initStore", error);
      warnedReadFallback = true;
    }
    enableCacheReadMode();
    return cache;
  }
}

async function initStore() {
  await ensureStoreInitialized();
  return clone(cache);
}

async function readDB() {
  try {
    await ensureStoreInitialized();
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
    await ensureStoreInitialized();
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

// Clone only the requested top-level collections. `meta` is always included so
// callers retain the store version/timestamp needed for cache validation.
async function readDBView(keys = []) {
  const requestedKeys = typeof keys === "string" ? [keys] : keys;
  if (!Array.isArray(requestedKeys)) {
    throw new TypeError("readDBView keys must be a string or an array of strings");
  }

  try {
    await ensureStoreInitialized();
    warnedReadFallback = false;
  } catch (error) {
    await ensureMemoryStore();
    if (!warnedReadFallback) {
      warnFallback("readDBView", error);
      warnedReadFallback = true;
    }
    enableCacheReadMode();
  }

  const view = { meta: clone(cache?.meta || {}) };
  const seen = new Set(["meta"]);
  for (const rawKey of requestedKeys) {
    if (typeof rawKey !== "string") {
      throw new TypeError("readDBView keys must contain only strings");
    }
    const key = rawKey.trim();
    if (!key || seen.has(key)) continue;
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    seen.add(key);
    if (cache && Object.prototype.hasOwnProperty.call(cache, key)) {
      view[key] = clone(cache[key]);
    }
  }
  return view;
}

async function updateMemoryOnly(mutator, options = {}) {
  await ensureMemoryStore();
  const generationAtStart =
    options.generationAtStart === undefined ? cacheGeneration : Number(options.generationAtStart);
  const draft = clone(cache);
  const result = await mutator(draft);
  normalizeStoreShape(draft);
  draft.meta = draft.meta || {};
  draft.meta.updatedAt = new Date().toISOString();
  if (options.skipIfStale && cacheGeneration !== generationAtStart) {
    return result;
  }
  cache = draft;
  cacheGeneration += 1;
  return result;
}

async function persistSnapshot(snapshot, label = "optimistic update", dirtyKeys = []) {
  if (!initializedFromDB || shouldBypassDB()) {
    const reason = !initializedFromDB
      ? "database snapshot has not been initialized"
      : "database retry cooldown is active";
    return {
      ok: false,
      skipped: true,
      error: new StoreInfrastructureError(`db persist(${label})`, new Error(reason)),
    };
  }
  let conn = null;
  try {
    conn = await withTimeout(getPool(), dbOpTimeoutMs, `db connect(${label})`);
    await withTimeout(conn.beginTransaction(), dbOpTimeoutMs, `db beginTransaction(${label})`);
    await saveStateChangesToTables(conn, clone(snapshot), dirtyKeys);
    await withTimeout(conn.commit(), dbOpTimeoutMs, `db commit(${label})`);
    warnedWriteFallback = false;
    disableCacheReadMode();
    return { ok: true, skipped: false, error: null };
  } catch (error) {
    try {
      if (conn) await withTimeout(conn.rollback(), dbOpTimeoutMs, `db rollback(${label})`);
    } catch (_) {
      // ignore rollback errors
    }
    if (!warnedWriteFallback) {
      warnFallback(label, error);
      warnedWriteFallback = true;
    }
    enableCacheReadMode();
    return {
      ok: false,
      skipped: false,
      error: error instanceof StoreInfrastructureError
        ? error
        : new StoreInfrastructureError(`db persist(${label})`, error),
    };
  } finally {
    await closeConn(conn);
  }
}

function serializeOptimisticPersistError(error) {
  if (!error) return null;
  return {
    name: String(error.name || "Error"),
    code: String(error.code || ""),
    operation: String(error.operation || ""),
    message: String(error.message || error),
  };
}

function getOptimisticPersistStatus() {
  return {
    pending: Boolean(pendingOptimisticSnapshot || optimisticPersistScheduled || optimisticPersistTimer),
    hasPendingSnapshot: Boolean(pendingOptimisticSnapshot),
    scheduled: Boolean(optimisticPersistScheduled || optimisticPersistTimer),
    inFlight: optimisticInFlightVersion > 0,
    pendingVersion: Number(pendingOptimisticVersion || 0),
    pendingDirtyKeys: [...pendingOptimisticDirtyKeys],
    inFlightVersion: Number(optimisticInFlightVersion || 0),
    latestVersion: Number(optimisticLatestVersion || 0),
    persistedVersion: Number(optimisticPersistedVersion || 0),
    durable: optimisticPersistedVersion >= optimisticLatestVersion,
    lastOutcome: optimisticLastOutcome,
    lastAttemptAt: optimisticLastAttemptAt,
    lastSuccessAt: optimisticLastSuccessAt,
    lastFailureAt: optimisticLastFailureAt,
    lastError: clone(optimisticLastError),
  };
}

function schedulePendingOptimisticPersist(delayMs = optimisticPersistDelayMs) {
  if (!pendingOptimisticSnapshot || optimisticPersistScheduled || optimisticPersistTimer) {
    return writeQueue;
  }

  const attach = () => {
    optimisticPersistTimer = null;
    if (!pendingOptimisticSnapshot || optimisticPersistScheduled) return;
    optimisticPersistScheduled = true;
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          // Drain all snapshots queued while persistence is running. Each new
          // optimistic snapshot supersedes the older one and already contains
          // all in-process mutations made before it.
          while (pendingOptimisticSnapshot) {
            const snapshot = pendingOptimisticSnapshot;
            const label = pendingOptimisticLabel;
            const version = pendingOptimisticVersion;
            const dirtyKeys = [...pendingOptimisticDirtyKeys];
            pendingOptimisticSnapshot = null;
            pendingOptimisticLabel = "optimistic update";
            pendingOptimisticVersion = 0;
            pendingOptimisticDirtyKeys = new Set();
            optimisticInFlightVersion = version;
            optimisticLastAttemptAt = new Date().toISOString();
            optimisticLastOutcome = "in_flight";

            let outcome;
            try {
              outcome = await persistSnapshot(snapshot, label, dirtyKeys);
            } catch (error) {
              outcome = { ok: false, skipped: false, error };
            }

            if (outcome?.ok) {
              optimisticPersistedVersion = Math.max(optimisticPersistedVersion, version);
              optimisticLastSuccessAt = new Date().toISOString();
              optimisticLastError = null;
              optimisticLastOutcome = "persisted";
              continue;
            }

            optimisticLastFailureAt = new Date().toISOString();
            optimisticLastError = serializeOptimisticPersistError(outcome?.error);
            optimisticLastOutcome = outcome?.skipped ? "skipped" : "failed";
            // Do not silently drop a failed write. Preserve it for a later
            // explicit flush or let a newer snapshot supersede it.
            if (!pendingOptimisticSnapshot || pendingOptimisticVersion < version) {
              pendingOptimisticSnapshot = snapshot;
              pendingOptimisticLabel = label;
              pendingOptimisticVersion = version;
              pendingOptimisticDirtyKeys = new Set(dirtyKeys);
            } else {
              dirtyKeys.forEach((key) => pendingOptimisticDirtyKeys.add(key));
            }
            break;
          }
        } finally {
          optimisticInFlightVersion = 0;
          optimisticPersistScheduled = false;
        }
      });
  };

  if (delayMs > 0) {
    optimisticPersistTimer = setTimeout(attach, delayMs);
  } else {
    attach();
  }

  return writeQueue;
}

function flushPendingOptimisticPersist(options = {}) {
  if (optimisticPersistTimer) {
    clearTimeout(optimisticPersistTimer);
    optimisticPersistTimer = null;
  }
  const drain = schedulePendingOptimisticPersist(0);
  return Promise.resolve(drain).catch(() => undefined).then(() => {
    const status = getOptimisticPersistStatus();
    if (options.throwOnError && status.hasPendingSnapshot && status.lastError) {
      const error = new Error(status.lastError.message || "optimistic persistence failed");
      error.name = "OptimisticPersistError";
      error.code = "OPTIMISTIC_PERSIST_FAILED";
      error.status = status;
      throw error;
    }
    return status;
  });
}

async function closeStore() {
  let firstError = null;
  try {
    await flushPendingOptimisticPersist({ throwOnError: true });
  } catch (error) {
    firstError = error;
  }

  try {
    await writeQueue;
  } catch (error) {
    firstError = firstError || error;
  }

  // Third-party template cache patches use per-device queues rather than the
  // global write queue. Let requests already accepted before HTTP shutdown
  // finish before the pool is released.
  if (thirdCacheWriteQueues.size > 0) {
    await Promise.allSettled([...thirdCacheWriteQueues.values()]);
  }

  await resetPool();
  if (firstError) throw firstError;
  return getOptimisticPersistStatus();
}

function enqueueSnapshotPersist(snapshot, label = "optimistic update", dirtyKeys = []) {
  optimisticLatestVersion += 1;
  pendingOptimisticSnapshot = clone(snapshot);
  pendingOptimisticLabel = label;
  pendingOptimisticVersion = optimisticLatestVersion;
  for (const key of dirtyKeys) pendingOptimisticDirtyKeys.add(key);
  optimisticLastOutcome = "pending";
  return schedulePendingOptimisticPersist();
}

function enqueueSyncWrite(runner) {
  if (optimisticPersistTimer) {
    clearTimeout(optimisticPersistTimer);
    optimisticPersistTimer = null;
  }
  schedulePendingOptimisticPersist(0);
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(runner);
  return writeQueue;
}

async function updateDBOptimistic(mutator) {
  await ensureMemoryStore();
  const draft = clone(cache);
  const beforeFingerprints = captureCollectionFingerprints(draft);
  const result = await mutator(draft);
  normalizeStoreShape(draft);
  draft.meta = draft.meta || {};
  draft.meta.updatedAt = new Date().toISOString();
  cache = draft;
  cacheGeneration += 1;
  const dirtyKeys = detectChangedCollectionKeys(beforeFingerprints, draft);
  enqueueSnapshotPersist(draft, "updateDBOptimistic", dirtyKeys).catch(() => undefined);
  return result;
}

async function patchThirdCacheInMemoryOnly({ deviceId, slug, updater, now }) {
  await ensureMemoryStore();
  const safeDeviceId = String(deviceId || "").trim();
  const safeSlug = String(slug || "").trim();
  if (!safeDeviceId) throw new Error("deviceId required");
  if (!safeSlug) throw new Error("slug required");
  if (typeof updater !== "function") throw new Error("updater must be function");

  const draft = clone(cache);
  const devices = Array.isArray(draft.devices) ? draft.devices : [];
  const target = devices.find((item) => {
    const id = String(item?.id || "").trim();
    const did = String(item?.deviceId || "").trim();
    return id === safeDeviceId || did === safeDeviceId;
  });
  if (!target) throw new Error(`device not found: ${safeDeviceId}`);

  target.thirdApiCache =
    target.thirdApiCache && typeof target.thirdApiCache === "object" && !Array.isArray(target.thirdApiCache)
      ? target.thirdApiCache
      : {};
  const currentEntry = target.thirdApiCache[safeSlug];
  const nextEntry = await updater(clone(currentEntry));
  if (nextEntry === null) {
    delete target.thirdApiCache[safeSlug];
  } else if (nextEntry !== undefined) {
    target.thirdApiCache[safeSlug] = nextEntry;
  }
  target.updatedAt = String(now || new Date().toISOString());
  draft.meta = draft.meta || {};
  draft.meta.updatedAt = String(now || new Date().toISOString());
  normalizeStoreShape(draft);
  cache = draft;
  return clone(target.thirdApiCache[safeSlug] ?? null);
}

async function patchDeviceThirdApiCache(options = {}) {
  const safeDeviceId = String(options.deviceId || "").trim();
  const safeSlug = String(options.slug || "").trim();
  const updater =
    typeof options.updater === "function"
      ? options.updater
      : () => options.entry;
  if (!safeDeviceId) throw new Error("deviceId required");
  if (!safeSlug) throw new Error("slug required");
  const queueKey = resolveThirdCacheQueueKey(safeDeviceId);

  return enqueueThirdCacheWrite(queueKey, async () => {
      const startedAt = Date.now();
      const now = new Date().toISOString();
      try {
        await initStore();
        if (shouldBypassDB()) {
          const output = await patchThirdCacheInMemoryOnly({
            deviceId: safeDeviceId,
            slug: safeSlug,
            updater,
            now,
          });
          // eslint-disable-next-line no-console
          console.info(
            `[api-template-refresh] cache-write mode=memory-only device=${safeDeviceId} slug=${safeSlug} ms=${Date.now() - startedAt}`
          );
          return output;
        }

        const conn = await withTimeout(getPool(), thirdCacheDbOpTimeoutMs, "db connect(patchThirdCache)");
        try {
          await withTimeout(conn.beginTransaction(), thirdCacheDbOpTimeoutMs, "db beginTransaction(patchThirdCache)");
          const [rows] = await withTimeout(
            conn.query(
              "SELECT id, device_id, payload_json, metadata_json FROM devices WHERE id = ? OR device_id = ? LIMIT 1",
              [safeDeviceId, safeDeviceId]
            ),
            thirdCacheDbOpTimeoutMs,
            "db select device for third cache patch"
          );
          if (!Array.isArray(rows) || !rows.length) {
            throw new Error(`device not found: ${safeDeviceId}`);
          }

          const row = rows[0];
          const payload = safeJSONParse(row.payload_json, {});
          const metadata = safeJSONParse(row.metadata_json, {});
          const device = { ...metadata, ...payload };
          device.id = normalizeStringField(device.id || row.id || "");
          device.deviceId = normalizeStringField(device.deviceId || row.device_id || row.id || "");
          device.thirdApiCache =
            device.thirdApiCache && typeof device.thirdApiCache === "object" && !Array.isArray(device.thirdApiCache)
              ? device.thirdApiCache
              : {};
          const currentEntry = device.thirdApiCache[safeSlug];
          const nextEntry = await updater(clone(currentEntry));
          if (nextEntry === null) {
            delete device.thirdApiCache[safeSlug];
          } else if (nextEntry !== undefined) {
            device.thirdApiCache[safeSlug] = nextEntry;
          }
          device.updatedAt = now;

          const nextMeta = {
            ...metadata,
            name: device.name || metadata.name || "",
            displayName: device.displayName || metadata.displayName || "",
            defaultView: device.defaultView || metadata.defaultView || "",
            remark: device.remark || metadata.remark || "",
            bindState: device.bindState || metadata.bindState || "",
            boundAt: device.boundAt || metadata.boundAt || "",
            boundBy: device.boundBy || metadata.boundBy || "",
            simulated: Boolean(device.simulated || metadata.simulated),
            apiKeys: normalizeObjectField(device.apiKeys || metadata.apiKeys),
            thirdApiParams: normalizeObjectField(device.thirdApiParams || metadata.thirdApiParams),
            thirdApiCache: normalizeObjectField(device.thirdApiCache),
          };

          await withTimeout(
            conn.query(
              "UPDATE devices SET payload_json = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
              [safeJSONString(device), safeJSONString(nextMeta), toDbDateTime(now, true), normalizeStringField(row.id || "")]
            ),
            thirdCacheDbOpTimeoutMs,
            "db update device third cache patch"
          );

          await withTimeout(conn.commit(), thirdCacheDbOpTimeoutMs, "db commit(patchThirdCache)");

          if (cache && typeof cache === "object" && Array.isArray(cache.devices)) {
            const target = cache.devices.find((item) => {
              const id = String(item?.id || "").trim();
              const did = String(item?.deviceId || "").trim();
              return id === String(row.id || "").trim() || did === safeDeviceId;
            });
            if (target) {
              target.thirdApiCache = normalizeObjectField(device.thirdApiCache);
              target.updatedAt = now;
            }
            cache.meta = cache.meta || {};
            cache.meta.updatedAt = now;
          }
          initializedFromDB = true;
          warnedWriteFallback = false;
          disableCacheReadMode();
          // eslint-disable-next-line no-console
          console.info(
            `[api-template-refresh] cache-write mode=partial-direct queue=${queueKey} device=${safeDeviceId} slug=${safeSlug} ms=${Date.now() - startedAt}`
          );
          return clone(device.thirdApiCache[safeSlug] ?? null);
        } catch (error) {
          try {
            await withTimeout(conn.rollback(), thirdCacheDbOpTimeoutMs, "db rollback(patchThirdCache)");
          } catch (_) {
            // ignore rollback errors
          }
          throw error;
        } finally {
          await closeConn(conn);
        }
      } catch (error) {
        if (!warnedWriteFallback) {
          warnFallback("patchDeviceThirdApiCache", error);
          warnedWriteFallback = true;
        }
        initializedFromDB = false;
        enableCacheReadMode();
        const output = await patchThirdCacheInMemoryOnly({
          deviceId: safeDeviceId,
          slug: safeSlug,
          updater,
          now,
        });
        // eslint-disable-next-line no-console
        console.info(
          `[api-template-refresh] cache-write mode=fallback-memory device=${safeDeviceId} slug=${safeSlug} ms=${Date.now() - startedAt}`
        );
        return output;
      }
    });
}

async function updateDB(mutator) {
  return enqueueSyncWrite(async () => {
    const generationAtStart = cacheGeneration;
    await ensureStoreInitialized();
    if (shouldBypassDB()) {
      // This branch is intentionally outside an infrastructure catch: a
      // mutator/HttpError must propagate unchanged and execute exactly once.
      return updateMemoryOnly(mutator, { skipIfStale: true, generationAtStart });
    }

    let conn = null;
    let draft = null;
    let result;
    let mutationCompleted = false;
    try {
      conn = await runStoreInfrastructureOperation(
        "db connect(update)",
        () => withTimeout(getPool(), dbOpTimeoutMs, "db connect(update)")
      );
      await runStoreInfrastructureOperation(
        "db beginTransaction(update)",
        () => withTimeout(conn.beginTransaction(), dbOpTimeoutMs, "db beginTransaction")
      );
      draft = await runStoreInfrastructureOperation(
        "db load state(update)",
        () => loadStateFromTables(conn)
      );
      const beforeFingerprints = captureCollectionFingerprints(draft);

      // Do not wrap application code as an infrastructure operation. This
      // preserves the original Error/HttpError identity for Express handlers.
      result = await mutator(draft);
      normalizeStoreShape(draft);
      draft.meta = draft.meta || {};
      draft.meta.updatedAt = new Date().toISOString();
      const dirtyKeys = detectChangedCollectionKeys(beforeFingerprints, draft);
      mutationCompleted = true;

      await runStoreInfrastructureOperation(
        "db save changed state(update)",
        () => saveStateChangesToTables(conn, draft, dirtyKeys)
      );
      await runStoreInfrastructureOperation(
        "db commit(update)",
        () => withTimeout(conn.commit(), dbOpTimeoutMs, "db commit")
      );
      if (cacheGeneration === generationAtStart) {
        cache = draft;
        cacheGeneration += 1;
      }
      initializedFromDB = true;
      warnedWriteFallback = false;
      disableCacheReadMode();
      return result;
    } catch (error) {
      try {
        if (conn) await withTimeout(conn.rollback(), dbOpTimeoutMs, "db rollback(update)");
      } catch (_) {
        // ignore rollback errors
      }

      if (!(error instanceof StoreInfrastructureError)) {
        throw error;
      }

      if (!warnedWriteFallback) {
        warnFallback("updateDB", error);
        warnedWriteFallback = true;
      }
      initializedFromDB = false;
      enableCacheReadMode();

      if (mutationCompleted) {
        // Persistence failed after the mutator already completed. Reuse that
        // prepared draft instead of executing potentially side-effecting
        // application code a second time.
        if (cacheGeneration === generationAtStart) {
          cache = draft;
          cacheGeneration += 1;
        }
        return result;
      }

      // The infrastructure failed before application code ran, so applying it
      // once to the in-process snapshot preserves the existing fallback API.
      return updateMemoryOnly(mutator, { skipIfStale: true, generationAtStart });
    } finally {
      await closeConn(conn);
    }
    });
}

module.exports = {
  initStore,
  readDB,
  readDBCached,
  readDBView,
  updateDB,
  updateDBOptimistic,
  flushPendingOptimisticPersist,
  getOptimisticPersistStatus,
  closeStore,
  patchDeviceThirdApiCache,
};

if (process.env.NODE_ENV === "test") {
  module.exports.__testing = {
    captureCollectionFingerprints,
    detectChangedCollectionKeys,
    configureRuntime({ state, pool = null, fromDB = false } = {}) {
      cache = clone(state || {});
      normalizeStoreShape(cache);
      initialized = true;
      initializedFromDB = Boolean(fromDB);
      mysqlPool = pool;
      forceCacheReads = false;
      dbRetryAfterTs = 0;
      warnedReadFallback = false;
      warnedWriteFallback = false;
      cacheGeneration += 1;
      writeQueue = Promise.resolve();
      if (optimisticPersistTimer) clearTimeout(optimisticPersistTimer);
      pendingOptimisticSnapshot = null;
      pendingOptimisticLabel = "optimistic update";
      pendingOptimisticVersion = 0;
      pendingOptimisticDirtyKeys = new Set();
      optimisticPersistScheduled = false;
      optimisticPersistTimer = null;
      optimisticLatestVersion = 0;
      optimisticPersistedVersion = 0;
      optimisticInFlightVersion = 0;
      optimisticLastAttemptAt = "";
      optimisticLastSuccessAt = "";
      optimisticLastFailureAt = "";
      optimisticLastError = null;
      optimisticLastOutcome = "idle";
    },
  };
}


