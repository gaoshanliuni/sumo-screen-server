const config = require("../config");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess } = require("../utils/access");
const { logOperation } = require("../utils/logging");
const homepageService = require("./homepage_page.service");
const { renderAndPersistForDevice, publishPagePushEvents } = require("./page_push.service");
const {
  ALLOWED_INTERVALS,
  DEFAULT_DAILY_START_TIME,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_INTERVAL_WINDOW_END_TIME,
  normalizeAutoRenderPushConfig,
  computeNextAutoRenderRunAt,
} = require("./homepage_auto_push_time.service");

const RUNNING_DEVICE_IDS = new Set();

function nowIso() {
  return new Date().toISOString();
}

function findHomepageConfigRow(draft, ownerId, deviceId) {
  const key = homepageService.configKey;
  draft[key] = Array.isArray(draft[key]) ? draft[key] : [];
  return draft[key].find(
    (item) => String(item.ownerId || "") === String(ownerId || "") && String(item.deviceId || "") === String(deviceId || "")
  );
}

function ensureHomepageConfigRow(draft, ownerId, deviceId) {
  const existing = findHomepageConfigRow(draft, ownerId, deviceId);
  if (existing) return existing;

  const now = nowIso();
  const resolved = homepageService.resolveConfig(draft, ownerId, deviceId);
  const row = {
    id: `hpc_auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ownerId: String(ownerId || ""),
    deviceId: String(deviceId || ""),
    config: homepageService.normalizeConfig(resolved.config || {}),
    version: Number(resolved.config?.version || 1),
    createdAt: now,
    updatedAt: now,
    updatedBy: "system",
  };
  draft[homepageService.configKey].unshift(row);
  return row;
}

function normalizeForNow(input, options = {}) {
  return normalizeAutoRenderPushConfig(input, {
    now: options.now || new Date(),
    timeZone: options.timeZone || config.timezone || "Asia/Shanghai",
    recomputeNext: options.recomputeNext === true,
  });
}

function getSchedulerDecision(now, autoConfig, deviceId) {
  if (!autoConfig.enabled) return { shouldRun: false, reason: "disabled" };
  if (RUNNING_DEVICE_IDS.has(deviceId)) return { shouldRun: false, reason: "running" };
  const nextRunAt = String(autoConfig.next_run_at || "").trim();
  if (!nextRunAt) return { shouldRun: false, reason: "missing_next_run_at" };
  const nextTs = Date.parse(nextRunAt);
  if (!Number.isFinite(nextTs)) return { shouldRun: false, reason: "invalid_next_run_at" };
  if (nextTs > now.getTime()) return { shouldRun: false, reason: "not_due" };
  return { shouldRun: true, reason: "due" };
}

function getHomepageAutoPushSchedulerRuntime() {
  const state = global.__homepageAutoPushScheduler || null;
  if (!state) {
    return {
      started: false,
      intervalMs: 0,
      startedAt: "",
      lastTickAt: "",
      running: false,
      lastTickResult: null,
    };
  }
  return {
    started: true,
    intervalMs: Number(state.intervalMs || 0),
    startedAt: String(state.startedAt || ""),
    lastTickAt: String(state.lastTickAt || ""),
    running: Boolean(state.running),
    lastTickResult: state.lastTickResult || null,
  };
}

async function persistAutoResult({ ownerId, deviceId, reason, status, errorMessage }) {
  const now = new Date();
  const nowText = now.toISOString();
  await updateDB((draft) => {
    const row = ensureHomepageConfigRow(draft, ownerId, deviceId);
    const auto = normalizeForNow(row.config?.auto_render_push, {
      now,
      recomputeNext: true,
    });
    auto.last_run_at = nowText;
    auto.last_result = status;
    auto.last_reason = String(reason || "");
    auto.last_error = status === "failed" ? String(errorMessage || "auto_render_push_failed") : "";
    row.config = homepageService.deepMerge(row.config || {}, { auto_render_push: auto });
    row.updatedAt = nowText;
    row.updatedBy = "system";
  });
}

async function markRunningState({ ownerId, deviceId, reason }) {
  const nowText = nowIso();
  await updateDB((draft) => {
    const row = ensureHomepageConfigRow(draft, ownerId, deviceId);
    const auto = normalizeForNow(row.config?.auto_render_push, {
      now: new Date(),
      recomputeNext: false,
    });
    auto.last_result = "running";
    auto.last_reason = String(reason || "");
    auto.last_error = "";
    row.config = homepageService.deepMerge(row.config || {}, { auto_render_push: auto });
    row.updatedAt = nowText;
    row.updatedBy = "system";
  });
}

async function runHomepageAutoPushNow({
  auth,
  deviceId,
  reason = "manual",
  dataPatch = undefined,
  configPatch = undefined,
  templatePatch = undefined,
}) {
  const db = await readDB();
  const device = ensureDeviceAccess(db, auth || { role: "admin", userId: "system" }, deviceId);
  const ownerId = String(device.ownerId || "");
  if (!ownerId) {
    throw new Error("设备未绑定用户，无法执行主页自动下发");
  }

  if (RUNNING_DEVICE_IDS.has(deviceId)) {
    return {
      status: "running",
      deviceId,
      reason: "已有任务正在执行",
    };
  }

  RUNNING_DEVICE_IDS.add(deviceId);
  // eslint-disable-next-line no-console
  console.info(`[homepage-auto-push] run start device=${deviceId} reason=${reason}`);
  await markRunningState({ ownerId, deviceId, reason });

  try {
    const rendered = await renderAndPersistForDevice({
      auth: { role: "admin", userId: "system" },
      deviceId,
      dataPatch,
      configPatch,
      templatePatch,
      pageType: homepageService.PAGE_TYPE,
      service: homepageService,
      skipAccessCheck: false,
    });
    publishPagePushEvents({
      eventPrefix: "homepage",
      deviceId,
      payload: rendered.payload,
    });
    await persistAutoResult({
      ownerId,
      deviceId,
      reason,
      status: "success",
      errorMessage: "",
    });
    await logOperation({
      actorId: "system",
      actorRole: "system",
      action: "homepage.auto_render_push.success",
      targetType: "device",
      targetId: deviceId,
      detail: {
        reason,
        imageId: rendered.payload?.image?.image_id || "",
        etag: rendered.payload?.image?.etag || "",
      },
    });
    return {
      status: "success",
      deviceId,
      reason,
      imageId: rendered.payload?.image?.image_id || "",
      etag: rendered.payload?.image?.etag || "",
    };
  } catch (error) {
    const message = String(error?.message || "auto_render_push_failed");
    await persistAutoResult({
      ownerId,
      deviceId,
      reason,
      status: "failed",
      errorMessage: message,
    });
    await logOperation({
      actorId: "system",
      actorRole: "system",
      action: "homepage.auto_render_push.failed",
      status: "failed",
      targetType: "device",
      targetId: deviceId,
      detail: {
        reason,
        error: message,
      },
    });
    // eslint-disable-next-line no-console
    console.warn(`[homepage-auto-push] run failed device=${deviceId} reason=${reason} error=${message}`);
    throw error;
  } finally {
    // eslint-disable-next-line no-console
    console.info(`[homepage-auto-push] run finish device=${deviceId} reason=${reason}`);
    RUNNING_DEVICE_IDS.delete(deviceId);
  }
}

async function getHomepageAutoPushStatus({ auth, deviceId }) {
  const db = await readDB();
  const device = ensureDeviceAccess(db, auth, deviceId);
  const resolved = homepageService.resolveConfig(db, String(device.ownerId || ""), String(device.id || ""));
  const auto = normalizeForNow(resolved.config?.auto_render_push, {
    now: new Date(),
    recomputeNext: false,
  });
  const decision = getSchedulerDecision(new Date(), auto, String(device.id || ""));
  const scheduler = getHomepageAutoPushSchedulerRuntime();
  return {
    deviceId: String(device.id || ""),
    enabled: Boolean(auto.enabled),
    interval_enabled: Boolean(auto.interval_enabled),
    window_start_time: String(auto.window_start_time || auto.daily_start_time || DEFAULT_DAILY_START_TIME),
    window_end_time: String(auto.window_end_time || DEFAULT_INTERVAL_WINDOW_END_TIME),
    fixed_times: Array.isArray(auto.fixed_times) ? auto.fixed_times : [],
    // legacy fields
    daily_start_time: auto.daily_start_time,
    interval_minutes: auto.interval_minutes,
    next_run_at: auto.next_run_at,
    last_run_at: auto.last_run_at,
    last_result: RUNNING_DEVICE_IDS.has(device.id) ? "running" : auto.last_result,
    last_error: auto.last_error,
    last_reason: auto.last_reason,
    running: RUNNING_DEVICE_IDS.has(device.id),
    scheduler_decision: String(decision.reason || "unknown"),
    scheduler: {
      started: Boolean(scheduler.started),
      running: Boolean(scheduler.running),
      started_at: String(scheduler.startedAt || ""),
      last_tick_at: String(scheduler.lastTickAt || ""),
      interval_ms: Number(scheduler.intervalMs || 0),
    },
    allowed_intervals: [...ALLOWED_INTERVALS],
  };
}

function prepareHomepageAutoConfigRow(row, now = new Date()) {
  const currentConfig = row?.config && typeof row.config === "object" ? row.config : {};
  const normalized = normalizeForNow(currentConfig.auto_render_push, { now, recomputeNext: false });
  const nextRunRaw = String(normalized.next_run_at || "").trim();
  const hasValidNextRunAt = Boolean(nextRunRaw) && Number.isFinite(Date.parse(nextRunRaw));
  const nextRunInitialized = Boolean(normalized.enabled && !hasValidNextRunAt);
  if (nextRunInitialized) {
    normalized.next_run_at = computeNextAutoRenderRunAt(
      normalized,
      now,
      config.timezone || "Asia/Shanghai"
    );
  }
  const nextConfig = homepageService.deepMerge(currentConfig, { auto_render_push: normalized });
  return {
    changed: JSON.stringify(nextConfig) !== JSON.stringify(currentConfig),
    nextConfig,
    nextRunInitialized,
  };
}

async function ensureNextRunAtForEnabledRows(now = new Date(), options = {}) {
  // Avoid the expensive full-state update path on the common no-op tick.
  const snapshot = options.snapshot || await readDB();
  const snapshotRows = Array.isArray(snapshot[homepageService.configKey])
    ? snapshot[homepageService.configKey]
    : [];
  const needsUpdate = snapshotRows.some(
    (row) => row?.deviceId && prepareHomepageAutoConfigRow(row, now).changed
  );
  if (!needsUpdate) return { changed: 0, updateAttempted: false };

  // Recompute from the transaction's fresh draft instead of applying a stale
  // snapshot patch. This keeps concurrent configuration edits intact.
  const result = await updateDB((draft) => {
    const rows = Array.isArray(draft[homepageService.configKey]) ? draft[homepageService.configKey] : [];
    let changed = 0;
    rows.forEach((row) => {
      if (!row?.deviceId) return;
      const prepared = prepareHomepageAutoConfigRow(row, now);
      if (!prepared.changed) return;
      row.config = prepared.nextConfig;
      if (prepared.nextRunInitialized) {
        row.updatedAt = now.toISOString();
        row.updatedBy = "system";
      }
      changed += 1;
    });
    return { changed };
  });
  return { changed: Number(result?.changed || 0), updateAttempted: true };
}

async function runHomepageAutoPushSchedulerTick(now = new Date()) {
  let db = await readDB();
  const initialized = await ensureNextRunAtForEnabledRows(now, { snapshot: db });
  if (initialized.updateAttempted) db = await readDB();
  const rows = Array.isArray(db[homepageService.configKey]) ? db[homepageService.configKey] : [];
  const dueRows = [];

  rows.forEach((row) => {
    if (!row?.deviceId) return;
    const auto = normalizeForNow(row.config?.auto_render_push, { now, recomputeNext: false });
    const decision = getSchedulerDecision(now, auto, String(row.deviceId || ""));
    if (decision.shouldRun) {
      dueRows.push({
        deviceId: String(row.deviceId || ""),
        ownerId: String(row.ownerId || ""),
      });
    }
  });

  const results = [];
  for (const row of dueRows) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runHomepageAutoPushNow({
      auth: { role: "admin", userId: row.ownerId || "system" },
      deviceId: row.deviceId,
      reason: "scheduler",
    }).catch((error) => ({
      status: "failed",
      deviceId: row.deviceId,
      reason: String(error?.message || "auto_render_push_failed"),
    }));
    results.push(result);
  }

  return {
    tickAt: now.toISOString(),
    count: results.length,
    results,
  };
}

function startHomepageAutoPushScheduler() {
  if (global.__homepageAutoPushScheduler) return global.__homepageAutoPushScheduler;
  const intervalMs = Math.max(15000, Number(process.env.HOMEPAGE_AUTO_PUSH_SCHEDULER_INTERVAL_MS || 60000));
  const state = {
    startedAt: nowIso(),
    intervalMs,
    timer: null,
    running: false,
    lastTickAt: "",
    lastTickResult: null,
  };

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    state.lastTickAt = nowIso();
    try {
      state.lastTickResult = await runHomepageAutoPushSchedulerTick(new Date());
    } catch (error) {
      state.lastTickResult = {
        failed: true,
        error: String(error?.message || error),
      };
      // eslint-disable-next-line no-console
      console.warn(`[homepage-auto-push] tick failed: ${String(error?.message || error)}`);
    } finally {
      state.running = false;
    }
  };

  tick().catch((error) => {
    // eslint-disable-next-line no-console
    console.warn(`[homepage-auto-push] initial tick failed: ${String(error?.message || error)}`);
  });

  state.timer = setInterval(() => {
    tick().catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(`[homepage-auto-push] scheduler tick crash: ${String(error?.message || error)}`);
    });
  }, intervalMs);
  if (typeof state.timer.unref === "function") {
    state.timer.unref();
  }

  // eslint-disable-next-line no-console
  console.info(`[homepage-auto-push] scheduler started intervalMs=${intervalMs}`);
  global.__homepageAutoPushScheduler = state;
  return state;
}

function stopHomepageAutoPushScheduler() {
  const state = global.__homepageAutoPushScheduler;
  if (state?.timer) clearInterval(state.timer);
  delete global.__homepageAutoPushScheduler;
}

module.exports = {
  ALLOWED_INTERVALS,
  DEFAULT_DAILY_START_TIME,
  DEFAULT_INTERVAL_MINUTES,
  normalizeAutoRenderPushConfig,
  computeNextAutoRenderRunAt,
  runHomepageAutoPushNow,
  getHomepageAutoPushStatus,
  runHomepageAutoPushSchedulerTick,
  startHomepageAutoPushScheduler,
  stopHomepageAutoPushScheduler,
  getHomepageAutoPushSchedulerRuntime,
  prepareHomepageAutoConfigRow,
  ensureNextRunAtForEnabledRows,
};
