const createId = require("../utils/id");
const HttpError = require("../utils/httpError");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess, resolveTargetDeviceIds } = require("../utils/access");
const { publishDeviceEvent } = require("../utils/realtime.hub");
const { createPendingAck } = require("../utils/remoteAck");
const { logOperation } = require("../utils/logging");
const { upsertBaseVariableOnDevice } = require("./device_variable.service");
const { refreshTemplateIfNeeded } = require("./api_template_refresh.service");
const {
  normalizeBackendBaseUrl,
  buildBackendUrlCommandPayload,
} = require("./remote_control.service");

const ACTION_TYPES = new Set([
  "device.variable.upsert",
  "api_template.refresh",
  "remote.update_backend_url",
  "remote.switch_view",
]);

function normalizeIdList(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return [];
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return normalizeIdList(parsed);
      } catch (_) {
        // fall back to comma splitting
      }
    }
    return [...new Set(text.split(",").map((item) => String(item || "").trim()).filter(Boolean))];
  }
  return [];
}

function normalizeTimeList(input, fallback = []) {
  const rows = Array.isArray(input) ? input : String(input || "").split(/[,\n;\s]+/g);
  const result = [];
  rows.forEach((item) => {
    const match = String(item || "").trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) return;
    const value = `${String(match[1]).padStart(2, "0")}:${match[2]}`;
    if (!result.includes(value)) result.push(value);
  });
  return result.length ? result.sort() : fallback;
}

function normalizeWeekdays(input) {
  const values = Array.isArray(input) ? input : [];
  const set = new Set();
  values.forEach((item) => {
    const n = Math.floor(Number(item || 0));
    if (Number.isFinite(n) && n >= 1 && n <= 7) set.add(n);
  });
  return [...set].sort((a, b) => a - b);
}

function normalizeCalendarDates(input) {
  const values = Array.isArray(input) ? input : [];
  const out = [];
  values.forEach((item) => {
    const match = String(item || "").trim().match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) return;
    const month = Math.max(1, Math.min(12, Math.floor(Number(match[1]))));
    const day = Math.max(1, Math.min(31, Math.floor(Number(match[2]))));
    const value = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!out.includes(value)) out.push(value);
  });
  return out.sort();
}

function normalizeScheduleSpec(mode, input = {}) {
  const safe = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (mode === "once") {
    return { runAt: String(safe.runAt || safe.startAt || "") };
  }
  if (mode === "calendar") {
    return {
      dates: normalizeCalendarDates(safe.dates || safe.monthDays),
      times: normalizeTimeList(safe.times, ["09:00"]),
    };
  }
  return {
    weekdays: normalizeWeekdays(safe.weekdays).length ? normalizeWeekdays(safe.weekdays) : [1, 2, 3, 4, 5],
    times: normalizeTimeList(safe.times, ["09:00"]),
  };
}

function normalizeRepeatSpec(input = {}) {
  const safe = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    enabled: Boolean(safe.enabled),
    intervalMinutes: Math.max(1, Math.min(24 * 60, Math.floor(Number(safe.intervalMinutes || 60)))),
  };
}

function normalizeRetrySpec(input = {}) {
  const safe = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    maxRetries: Math.max(0, Math.min(5, Math.floor(Number(safe.maxRetries || 0)))),
    retryDelayMinutes: Math.max(1, Math.min(24 * 60, Math.floor(Number(safe.retryDelayMinutes || 5)))),
  };
}

function normalizeStep(step = {}, index = 0) {
  const actionType = String(step.actionType || step.type || "").trim();
  return {
    id: String(step.id || createId("step")),
    actionType: ACTION_TYPES.has(actionType) ? actionType : "device.variable.upsert",
    title: String(step.title || actionType || `步骤${index + 1}`),
    enabled: step.enabled !== false,
    orderIndex: Math.max(1, Math.floor(Number(step.orderIndex || index + 1))),
    targetOverride: step.targetOverride && typeof step.targetOverride === "object" && !Array.isArray(step.targetOverride)
      ? {
          deviceIds: normalizeIdList(step.targetOverride.deviceIds),
          clusterIds: normalizeIdList(step.targetOverride.clusterIds),
        }
      : null,
    params: step.params && typeof step.params === "object" && !Array.isArray(step.params) ? step.params : {},
    continueOnError: Boolean(step.continueOnError),
  };
}

function normalizeTaskPlan(input = {}, now = new Date().toISOString()) {
  const scheduleModeRaw = String(input.scheduleMode || "once").trim();
  const scheduleMode = ["once", "weekly", "calendar"].includes(scheduleModeRaw) ? scheduleModeRaw : "once";
  const row = {
    id: String(input.id || createId("task")),
    name: String(input.name || "未命名计划任务").trim() || "未命名计划任务",
    description: String(input.description || ""),
    enabled: input.enabled !== false,
    priority: Math.max(0, Math.min(9999, Math.floor(Number(input.priority || 10)))),
    targetDeviceIds: normalizeIdList(input.targetDeviceIds || input.deviceIds),
    targetClusterIds: normalizeIdList(input.targetClusterIds || input.clusterIds),
    scheduleMode,
    scheduleSpec: normalizeScheduleSpec(scheduleMode, input.scheduleSpec),
    repeatSpec: normalizeRepeatSpec(input.repeatSpec),
    retrySpec: normalizeRetrySpec(input.retrySpec),
    steps: Array.isArray(input.steps) ? input.steps.map(normalizeStep).sort((a, b) => a.orderIndex - b.orderIndex) : [],
    lastRunAt: String(input.lastRunAt || ""),
    nextRunAt: String(input.nextRunAt || ""),
    createdAt: String(input.createdAt || now),
    updatedAt: String(input.updatedAt || now),
  };
  row.nextRunAt = row.nextRunAt || computeNextRunAt(row, new Date(now));
  return row;
}

function dateAtUtcTime(base, timeText) {
  const [h, m] = String(timeText || "09:00").split(":").map((item) => Number(item || 0));
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, m, 0, 0));
}

function computeNextRunAt(plan, nowDate = new Date()) {
  const now = nowDate instanceof Date ? nowDate : new Date(nowDate);
  if (!plan || plan.enabled === false || Number.isNaN(now.getTime())) return "";
  if (plan.scheduleMode === "once") {
    const runAt = new Date(plan.scheduleSpec?.runAt || "");
    if (Number.isNaN(runAt.getTime()) || runAt <= now) return "";
    return runAt.toISOString();
  }

  const candidates = [];
  const times = normalizeTimeList(plan.scheduleSpec?.times, ["09:00"]);
  for (let offset = 0; offset <= 370; offset += 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
    if (plan.scheduleMode === "weekly") {
      const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
      if (!normalizeWeekdays(plan.scheduleSpec?.weekdays).includes(weekday)) continue;
    }
    if (plan.scheduleMode === "calendar") {
      const key = `${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
      if (!normalizeCalendarDates(plan.scheduleSpec?.dates).includes(key)) continue;
    }
    times.forEach((timeText) => {
      const candidate = dateAtUtcTime(day, timeText);
      if (candidate > now) candidates.push(candidate);
    });
    if (candidates.length) break;
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ? candidates[0].toISOString() : "";
}

function targetsOverlap(left = [], right = []) {
  const set = new Set((left || []).map(String));
  return (right || []).some((item) => set.has(String(item)));
}

function hasHigherPriorityActiveRun(activeRuns = [], nextRun = {}) {
  return activeRuns.some((run) => {
    if (!["queued", "running"].includes(String(run.status || ""))) return false;
    if (Number(run.priority || 0) < Number(nextRun.priority || 0)) return false;
    return targetsOverlap(run.targetSnapshot, nextRun.targetSnapshot);
  });
}

function buildTaskRunRecord(plan, options = {}) {
  const now = String(options.now || new Date().toISOString());
  const triggerType = String(options.triggerType || "manual");
  const priority = triggerType === "manual" ? 10000 : Number(plan.priority || 0);
  return {
    id: String(options.id || createId("trun")),
    planId: String(plan.id || ""),
    planName: String(plan.name || ""),
    triggerType,
    priority,
    status: "queued",
    targetSnapshot: normalizeIdList(options.targetSnapshot || plan.targetDeviceIds),
    startedAt: "",
    finishedAt: "",
    reason: triggerType === "manual" ? "manual_override" : String(options.reason || "scheduled"),
    stepResults: [],
    createdAt: now,
    updatedAt: now,
  };
}

function resolvePlanTargets(db, auth, plan, targetOverride = null) {
  const deviceIds = normalizeIdList(targetOverride?.deviceIds).length
    ? normalizeIdList(targetOverride.deviceIds)
    : normalizeIdList(plan.targetDeviceIds);
  const clusterIds = normalizeIdList(targetOverride?.clusterIds).length
    ? normalizeIdList(targetOverride.clusterIds)
    : normalizeIdList(plan.targetClusterIds);
  const merged = new Set(resolveTargetDeviceIds(db, deviceIds, clusterIds));
  const denied = [];
  const allowed = [];
  [...merged].forEach((id) => {
    try {
      ensureDeviceAccess(db, auth, id);
      allowed.push(id);
    } catch (error) {
      denied.push({ deviceId: id, reason: error?.message || "无权限或设备不存在" });
    }
  });
  return { targetIds: allowed, denied, requestedCount: merged.size };
}

async function createAckCommand({ draft, deviceId, eventType, source, auth, meta }) {
  return createPendingAck(draft, {
    deviceId,
    eventType,
    source,
    operatorId: auth?.userId || "",
    operatorRole: auth?.role || "",
    meta,
  });
}

async function executeStep({ db, auth, plan, step }) {
  const target = resolvePlanTargets(db, auth, plan, step.targetOverride);
  const result = {
    stepId: step.id,
    actionType: step.actionType,
    title: step.title,
    successCount: 0,
    failedCount: target.denied.length,
    failed: [...target.denied],
    results: [],
  };

  if (!target.targetIds.length) return result;

  if (step.actionType === "device.variable.upsert") {
    const name = String(step.params?.name || "").trim();
    if (!name) throw new HttpError(400, "变量名不能为空");
    await updateDB((draft) => {
      target.targetIds.forEach((deviceId) => {
        const device = draft.devices.find((item) => String(item.id || "") === String(deviceId || ""));
        if (!device) {
          result.failed.push({ deviceId, reason: "设备不存在" });
          result.failedCount += 1;
          return;
        }
        const row = upsertBaseVariableOnDevice(device, { name, value: step.params?.value });
        result.results.push({ deviceId, name: row.name, value: row.value });
        result.successCount += 1;
      });
    });
    target.targetIds.forEach((deviceId) => {
      publishDeviceEvent({ type: "device.variables.updated", deviceId, payload: { source: "task_plan", action: "upsert", name } });
    });
    return result;
  }

  if (step.actionType === "api_template.refresh") {
    const slug = String(step.params?.slug || "").trim();
    if (!slug) throw new HttpError(400, "slug不能为空");
    for (const deviceId of target.targetIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const refresh = await refreshTemplateIfNeeded({
          auth,
          deviceId,
          slug,
          force: true,
          refreshSource: "task_plan",
          reason: `task_plan:${plan.id}`,
          inputParams: step.params?.inputParams || {},
        });
        result.results.push({ deviceId, slug, refresh });
        result.successCount += 1;
      } catch (error) {
        result.failed.push({ deviceId, reason: error?.message || "刷新失败" });
        result.failedCount += 1;
      }
    }
    return result;
  }

  if (step.actionType === "remote.update_backend_url") {
    const backendBaseUrl = normalizeBackendBaseUrl(step.params?.backendBaseUrl);
    await updateDB((draft) => {
      target.targetIds.forEach((deviceId) => {
        const command = createPendingAck(draft, {
          deviceId,
          eventType: "remote.update_backend_url",
          source: "task_plan.remote.update_backend_url",
          operatorId: auth?.userId || "",
          operatorRole: auth?.role || "",
          meta: { backendBaseUrl, taskPlanId: plan.id },
        });
        publishDeviceEvent({
          type: "remote.update_backend_url",
          deviceId,
          payload: buildBackendUrlCommandPayload({ commandId: command.commandId, backendBaseUrl }),
        });
        result.results.push({ deviceId, commandId: command.commandId, backendBaseUrl });
        result.successCount += 1;
      });
    });
    return result;
  }

  if (step.actionType === "remote.switch_view") {
    const view = String(step.params?.view || "home").trim();
    await updateDB((draft) => {
      target.targetIds.forEach((deviceId) => {
        const command = createPendingAck(draft, {
          deviceId,
          eventType: "remote.switch_view",
          source: "task_plan.remote.switch_view",
          operatorId: auth?.userId || "",
          operatorRole: auth?.role || "",
          meta: { view, taskPlanId: plan.id },
        });
        publishDeviceEvent({
          type: "remote.switch_view",
          deviceId,
          payload: { commandId: command.commandId, view, setAsDefault: Boolean(step.params?.setAsDefault) },
        });
        result.results.push({ deviceId, commandId: command.commandId, view });
        result.successCount += 1;
      });
    });
    return result;
  }

  throw new HttpError(400, `不支持的动作: ${step.actionType}`);
}

async function runTaskPlan({ auth, planId, triggerType = "manual", now = new Date().toISOString() }) {
  const db = await readDB();
  const plan = (db.taskPlans || []).find((item) => String(item.id || "") === String(planId || ""));
  if (!plan) throw new HttpError(404, "计划任务不存在");
  const normalizedPlan = normalizeTaskPlan(plan, now);
  const target = resolvePlanTargets(db, auth, normalizedPlan);
  const run = buildTaskRunRecord(normalizedPlan, { triggerType, targetSnapshot: target.targetIds, now });
  const activeRuns = (db.taskRuns || []).filter((item) => ["queued", "running"].includes(String(item.status || "")));
  if (triggerType !== "manual" && hasHigherPriorityActiveRun(activeRuns, run)) {
    run.status = "skipped";
    run.reason = "skipped_higher_priority";
    run.finishedAt = now;
    await updateDB((draft) => {
      draft.taskRuns = Array.isArray(draft.taskRuns) ? draft.taskRuns : [];
      draft.taskRuns.unshift(run);
    });
    return run;
  }

  await updateDB((draft) => {
    draft.taskRuns = Array.isArray(draft.taskRuns) ? draft.taskRuns : [];
    run.status = "running";
    run.startedAt = now;
    run.updatedAt = now;
    draft.taskRuns.unshift(run);
  });

  const stepResults = [];
  let failedCount = 0;
  for (const step of normalizedPlan.steps.filter((item) => item.enabled !== false).sort((a, b) => a.orderIndex - b.orderIndex)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const stepResult = await executeStep({ db: await readDB(), auth, plan: normalizedPlan, step });
      stepResults.push(stepResult);
      failedCount += Number(stepResult.failedCount || 0);
      if (Number(stepResult.failedCount || 0) > 0 && !step.continueOnError) break;
    } catch (error) {
      failedCount += 1;
      stepResults.push({ stepId: step.id, actionType: step.actionType, title: step.title, error: error?.message || "步骤失败", failedCount: 1, successCount: 0 });
      if (!step.continueOnError) break;
    }
  }

  const finishedAt = new Date().toISOString();
  const status = failedCount > 0
    ? stepResults.some((item) => Number(item.successCount || 0) > 0) ? "partial_success" : "failed"
    : "success";
  let finalRun = null;
  await updateDB((draft) => {
    const row = (draft.taskRuns || []).find((item) => String(item.id || "") === run.id);
    if (row) {
      row.status = status;
      row.finishedAt = finishedAt;
      row.updatedAt = finishedAt;
      row.stepResults = stepResults;
      finalRun = row;
    }
    const planRow = (draft.taskPlans || []).find((item) => String(item.id || "") === normalizedPlan.id);
    if (planRow) {
      planRow.lastRunAt = finishedAt;
      planRow.nextRunAt = computeNextRunAt(normalizeTaskPlan(planRow, finishedAt), new Date(finishedAt));
      planRow.updatedAt = finishedAt;
    }
  });

  await logOperation({
    actorId: auth?.userId || "system",
    actorRole: auth?.role || "system",
    action: "task_plan.run",
    targetType: "task_plan",
    targetId: normalizedPlan.id,
    detail: { triggerType, status, stepCount: stepResults.length },
  });

  return finalRun || { ...run, status, finishedAt, stepResults };
}

async function runDueTaskPlansTick(now = new Date()) {
  const db = await readDB();
  const due = (db.taskPlans || [])
    .map((item) => normalizeTaskPlan(item, now.toISOString()))
    .filter((plan) => plan.enabled !== false && plan.nextRunAt && new Date(plan.nextRunAt) <= now);
  const results = [];
  for (const plan of due) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runTaskPlan({
      auth: { role: "admin", userId: "system" },
      planId: plan.id,
      triggerType: "schedule",
      now: now.toISOString(),
    }).catch((error) => ({ planId: plan.id, status: "failed", error: error?.message || "运行失败" }));
    results.push(result);
  }
  return { dueCount: due.length, results };
}

function getTaskPlanSchedulerRuntime() {
  const state = global.__taskPlanScheduler || null;
  if (!state) {
    return {
      started: false,
      startedAt: "",
      intervalMs: 0,
      lastTickAt: "",
      running: false,
      skippedTicks: 0,
      lastTickResult: null,
    };
  }
  return {
    started: true,
    startedAt: String(state.startedAt || ""),
    intervalMs: Number(state.intervalMs || 0),
    lastTickAt: String(state.lastTickAt || ""),
    running: Boolean(state.running),
    skippedTicks: Number(state.skippedTicks || 0),
    lastTickResult: state.lastTickResult || state.lastResult || null,
  };
}

function startTaskPlanScheduler(options = {}) {
  if (global.__taskPlanScheduler) return global.__taskPlanScheduler;
  const requestedIntervalMs = Number(
    options.intervalMs || process.env.TASK_PLAN_SCHEDULER_INTERVAL_MS || 30000
  );
  const intervalMs = Number.isFinite(requestedIntervalMs)
    ? Math.max(1000, requestedIntervalMs)
    : 30000;
  const runTick = typeof options.runTick === "function" ? options.runTick : runDueTaskPlansTick;
  const state = {
    startedAt: new Date().toISOString(),
    intervalMs,
    timer: null,
    running: false,
    skippedTicks: 0,
    lastTickAt: "",
    lastTickResult: null,
    // Kept as an alias for code that inspected the previous runtime object.
    lastResult: null,
    tick: null,
  };
  const tick = async () => {
    if (state.running) {
      state.skippedTicks += 1;
      return { skipped: true, reason: "previous_tick_running" };
    }
    state.running = true;
    state.lastTickAt = new Date().toISOString();
    try {
      state.lastTickResult = await runTick(new Date());
    } catch (error) {
      state.lastTickResult = { status: "failed", error: error?.message || String(error) };
    } finally {
      state.lastResult = state.lastTickResult;
      state.running = false;
    }
    return state.lastTickResult;
  };
  state.tick = tick;
  state.timer = setInterval(() => {
    tick().catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(`[task-plan-scheduler] tick failed: ${String(error?.message || error)}`);
    });
  }, intervalMs);
  if (typeof state.timer.unref === "function") state.timer.unref();
  global.__taskPlanScheduler = state;
  if (options.runImmediately !== false) {
    tick().catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(`[task-plan-scheduler] initial tick failed: ${String(error?.message || error)}`);
    });
  }
  return state;
}

function stopTaskPlanScheduler() {
  const state = global.__taskPlanScheduler;
  if (state?.timer) clearInterval(state.timer);
  if (state) {
    state.timer = null;
    state.running = false;
  }
  delete global.__taskPlanScheduler;
}

module.exports = {
  ACTION_TYPES,
  normalizeIdList,
  normalizeTaskPlan,
  computeNextRunAt,
  hasHigherPriorityActiveRun,
  buildTaskRunRecord,
  resolvePlanTargets,
  runTaskPlan,
  runDueTaskPlansTick,
  startTaskPlanScheduler,
  stopTaskPlanScheduler,
  getTaskPlanSchedulerRuntime,
};
