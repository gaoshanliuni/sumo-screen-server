const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess, getVisibleDeviceIds, resolveTargetDeviceIds } = require("../utils/access");
const { logOperation } = require("../utils/logging");
const { publishDeviceEvent } = require("../utils/realtime.hub");
const {
  saveXiqueSyncConfig,
  getXiqueStatus,
  prepareXiqueLogin,
  submitXiqueImport,
  reverifyXiqueSession,
} = require("../services/xique_sync.service");

const router = express.Router();
router.use(allowRoles("admin", "user", "device"));

function normalizeIdList(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof input === "string") {
    const value = String(input || "").trim();
    if (!value) return [];
    if (value.startsWith("[")) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return normalizeIdList(parsed);
      } catch (_) {
        // ignore
      }
    }
    return [...new Set(value.split(",").map((item) => String(item || "").trim()).filter(Boolean))];
  }
  return [];
}

function resolveBatchTargets(db, auth, body = {}) {
  const singleId = String(body.deviceId || "").trim();
  const deviceIds = normalizeIdList(body.deviceIds);
  const clusterIds = normalizeIdList(body.clusterIds);
  const merged = new Set(resolveTargetDeviceIds(db, deviceIds, clusterIds));
  if (singleId) merged.add(singleId);
  if (!merged.size) throw new HttpError(400, "At least one target device is required");

  const targetIds = [];
  const denied = [];
  [...merged].forEach((id) => {
    try {
      ensureDeviceAccess(db, auth, id);
      targetIds.push(id);
    } catch (error) {
      denied.push({ deviceId: id, reason: error?.message || "No permission or device not found" });
    }
  });
  return { targetIds, denied, requestedCount: merged.size };
}

function applyTemplate(raw, device) {
  const text = String(raw || "");
  const vars = {
    id: String(device.id || ""),
    deviceId: String(device.id || ""),
    mac: String(device.mac || ""),
    displayName: String(device.displayName || ""),
    remark: String(device.remark || ""),
    name: String(device.displayName || device.remark || device.id || ""),
  };
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""));
}

function normalizeWeekday(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 1 || n > 7) return 1;
  return Math.floor(n);
}

function normalizeScheduleInput(row = {}) {
  const mode = String(row.mode || "").toLowerCase() === "meeting" ? "meeting" : "course";
  const weekday = normalizeWeekday(row.weekday || row.weekDay || row.week);
  const orderIndexRaw = Number(row.orderIndex || 0);
  const orderIndex = Number.isFinite(orderIndexRaw) && orderIndexRaw > 0 ? Math.floor(orderIndexRaw) : 1;

  const title = String(row.title || row.courseName || "").trim();
  const content = String(row.content || row.note || "").trim();
  const startTime = String(row.startTime || "").trim();
  const endTime = String(row.endTime || "").trim();

  if (!title) return null;

  return {
    mode,
    weekday,
    orderIndex,
    title,
    content,
    startTime,
    endTime,
  };
}

function buildScheduleTitle(body, device) {
  const mode = String(body.mode || "same").toLowerCase();
  if (mode === "regex") {
    const source = applyTemplate(String(body.regexSource || body.title || body.courseName || ""), device);
    const pattern = String(body.regexPattern || "");
    if (!pattern) return source;
    const replaceWith = applyTemplate(String(body.regexReplace || ""), device);
    try {
      return source.replace(new RegExp(pattern, "g"), replaceWith);
    } catch (_) {
      throw new HttpError(400, "姝ｅ垯琛ㄨ揪寮忎笉鍚堟硶");
    }
  }
  if (mode === "template") {
    return applyTemplate(String(body.title || body.courseName || ""), device);
  }
  return String(body.title || body.courseName || "");
}

router.post(
  "/batch-dispatch",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const target = resolveBatchTargets(db, req.auth, req.body || {});
    if (target.targetIds.length === 0) {
      return res.success({
        total: target.requestedCount,
        successCount: 0,
        failedCount: target.denied.length,
        successDeviceIds: [],
        failed: target.denied,
      }, "No dispatchable device");
    }

    const now = new Date().toISOString();
    const replace = Boolean(req.body?.replace);
    const mode = String(req.body?.scheduleMode || req.body?.mode || "course").toLowerCase() === "meeting" ? "meeting" : "course";
    const weekday = normalizeWeekday(req.body?.weekday || 1);
    const orderIndexRaw = Number(req.body?.orderIndex || 1);
    const orderIndex = Number.isFinite(orderIndexRaw) && orderIndexRaw > 0 ? Math.floor(orderIndexRaw) : 1;
    const startTime = String(req.body?.startTime || "").trim();
    const endTime = String(req.body?.endTime || "").trim();
    const content = String(req.body?.content || req.body?.note || "").trim();

    const success = [];
    const failed = [...target.denied];

    await updateDB((draft) => {
      target.targetIds.forEach((deviceId) => {
        const device = draft.devices.find((item) => item.id === deviceId);
        if (!device) {
          failed.push({ deviceId, reason: "Device not found" });
          return;
        }

        let title = "";
        try {
          title = String(buildScheduleTitle(req.body || {}, device) || "").trim();
        } catch (error) {
          failed.push({ deviceId, reason: error?.message || "鏍囬鐢熸垚澶辫触" });
          return;
        }
        if (!title) {
          failed.push({ deviceId, reason: "鏍囬涓嶈兘涓虹┖" });
          return;
        }

        if (replace) {
          draft.schedules = draft.schedules.filter((item) => item.deviceId !== deviceId);
        }

        const row = {
          id: createId("sch"),
          deviceId,
          mode,
          weekday,
          orderIndex,
          title,
          content,
          startTime,
          endTime,
          // Legacy compatibility fields for existing device-side parsers.
          courseName: title,
          note: content,
          source: "manual",
          sourceKey: "",
          termKey: "",
          xiqueCourseId: "",
          xiqueClassKey: "",
          sourceMeta: {},
          createdAt: now,
          updatedAt: now,
        };
        draft.schedules.push(row);
        success.push({ deviceId, scheduleId: row.id, title });
      });
    });

    success.forEach((item) => {
      publishDeviceEvent({
        type: "schedule.changed",
        deviceId: item.deviceId,
        payload: { action: "batch_dispatch", scheduleId: item.scheduleId },
      });
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "schedule.batch_dispatch",
      targetType: "device_batch",
      targetId: `count:${target.targetIds.length}`,
      detail: {
        requestedCount: target.requestedCount,
        successCount: success.length,
        failedCount: failed.length,
        mode: String(req.body?.mode || "same"),
        scheduleMode: mode,
        replace,
      },
    });

    res.success({
      total: target.requestedCount,
      successCount: success.length,
      failedCount: failed.length,
      successDeviceIds: success.map((item) => item.deviceId),
      failed,
      results: success,
    }, success.length ? "鎵归噺涓嬪彂鎴愬姛" : "鎵归噺涓嬪彂澶辫触");
  })
);

router.post(
  "/batch-upsert",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const { deviceId, rows = [], deletedIds = [] } = req.body || {};
    if (!deviceId) throw new HttpError(400, "deviceId涓嶈兘涓虹┖");
    if (!Array.isArray(rows) || !Array.isArray(deletedIds)) {
      throw new HttpError(400, "rows/deletedIds must be arrays");
    }

    const db = await readDB();
    ensureDeviceAccess(db, req.auth, deviceId);
    const now = new Date().toISOString();
    const changedRows = [];

    await updateDB((draft) => {
      const deleteSet = new Set(deletedIds.map((item) => String(item)));
      draft.schedules = draft.schedules.filter((item) => !(item.deviceId === deviceId && deleteSet.has(item.id)));

      rows.forEach((row) => {
        const scheduleId = row?.id ? String(row.id) : "";
        const existing = scheduleId ? draft.schedules.find((item) => item.id === scheduleId && item.deviceId === deviceId) : null;
        const normalized = normalizeScheduleInput(row);
        if (!normalized) return;

        if (existing) {
          existing.mode = normalized.mode;
          existing.weekday = normalized.weekday;
          existing.orderIndex = normalized.orderIndex;
          existing.title = normalized.title;
          existing.content = normalized.content;
          existing.startTime = normalized.startTime;
          existing.endTime = normalized.endTime;
          existing.courseName = normalized.title;
          existing.note = normalized.content;
          existing.updatedAt = now;
          changedRows.push(existing);
        } else {
          const created = {
            id: createId("sch"),
            deviceId,
            mode: normalized.mode,
            weekday: normalized.weekday,
            orderIndex: normalized.orderIndex,
            title: normalized.title,
            content: normalized.content,
            startTime: normalized.startTime,
            endTime: normalized.endTime,
            courseName: normalized.title,
            note: normalized.content,
            source: "manual",
            sourceKey: "",
            termKey: "",
            xiqueCourseId: "",
            xiqueClassKey: "",
            sourceMeta: {},
            createdAt: now,
            updatedAt: now,
          };
          draft.schedules.push(created);
          changedRows.push(created);
        }
      });
    });

    const fresh = (await readDB()).schedules.filter((item) => item.deviceId === deviceId);

    publishDeviceEvent({
      type: "schedule.changed",
      deviceId,
      payload: { action: "batch_upsert", changed: changedRows.length, deleted: deletedIds.length },
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "schedule.batch_upsert",
      targetType: "device",
      targetId: deviceId,
      detail: { changed: changedRows.length, deleted: deletedIds.length },
    });

    res.success(fresh, "Schedule batch saved");
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { deviceId } = req.body || {};
    const normalized = normalizeScheduleInput(req.body || {});
    if (!deviceId || !normalized) {
      throw new HttpError(400, "deviceId/title涓哄繀濉」");
    }

    const db = await readDB();
    ensureDeviceAccess(db, req.auth, deviceId);

    const now = new Date().toISOString();
    const row = {
      id: createId("sch"),
      deviceId,
      mode: normalized.mode,
      weekday: normalized.weekday,
      orderIndex: normalized.orderIndex,
      title: normalized.title,
      content: normalized.content,
      startTime: normalized.startTime,
      endTime: normalized.endTime,
      courseName: normalized.title,
      note: normalized.content,
      source: "manual",
      sourceKey: "",
      termKey: "",
      xiqueCourseId: "",
      xiqueClassKey: "",
      sourceMeta: {},
      createdAt: now,
      updatedAt: now,
    };

    await updateDB((draft) => {
      draft.schedules.push(row);
    });

    publishDeviceEvent({
      type: "schedule.changed",
      deviceId,
      payload: { action: "create", row },
    });

    await logOperation({
      actorId: req.auth.userId || req.auth.deviceId,
      actorRole: req.auth.role,
      action: "schedule.create",
      targetType: "schedule",
      targetId: row.id,
      detail: { deviceId },
    });

    res.success(row, "璇剧▼鍒涘缓鎴愬姛");
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { deviceId } = req.query || {};
    const db = await readDB();
    const visible = getVisibleDeviceIds(db, req.auth);

    let list = db.schedules.filter((item) => visible.has(item.deviceId));
    if (deviceId) list = list.filter((item) => item.deviceId === deviceId);
    list.sort((a, b) => {
      if (a.weekday !== b.weekday) return a.weekday - b.weekday;
      return a.orderIndex - b.orderIndex;
    });

    res.success(list, "ok");
  })
);

router.post(
  "/:scheduleId",
  asyncHandler(async (req, res) => {
    const { scheduleId } = req.params;
    const payload = req.body || {};
    const db = await readDB();
    const current = db.schedules.find((item) => item.id === scheduleId);
    if (!current) throw new HttpError(404, "Schedule not found");
    ensureDeviceAccess(db, req.auth, current.deviceId);

    let updated = null;
    await updateDB((draft) => {
      const target = draft.schedules.find((item) => item.id === scheduleId);
      if (!target) throw new HttpError(404, "Schedule not found");
      if (payload.mode !== undefined) target.mode = String(payload.mode).toLowerCase() === "meeting" ? "meeting" : "course";
      if (payload.weekday !== undefined) target.weekday = normalizeWeekday(payload.weekday);
      if (payload.orderIndex !== undefined) {
        const orderRaw = Number(payload.orderIndex);
        if (!Number.isFinite(orderRaw) || orderRaw <= 0) throw new HttpError(400, "orderIndex蹇呴』澶т簬0");
        target.orderIndex = Math.floor(orderRaw);
      }
      if (payload.title !== undefined || payload.courseName !== undefined) {
        target.title = String(payload.title || payload.courseName || "").trim();
        if (!target.title) throw new HttpError(400, "title涓嶈兘涓虹┖");
        target.courseName = target.title;
      }
      if (payload.content !== undefined || payload.note !== undefined) {
        target.content = String(payload.content || payload.note || "");
        target.note = target.content;
      }
      if (payload.startTime !== undefined) target.startTime = String(payload.startTime || "");
      if (payload.endTime !== undefined) target.endTime = String(payload.endTime || "");
      target.updatedAt = new Date().toISOString();
      updated = target;
    });

    publishDeviceEvent({
      type: "schedule.changed",
      deviceId: current.deviceId,
      payload: { action: "update", row: updated },
    });

    await logOperation({
      actorId: req.auth.userId || req.auth.deviceId,
      actorRole: req.auth.role,
      action: "schedule.update",
      targetType: "schedule",
      targetId: scheduleId,
    });

    res.success(updated, "Schedule updated");
  })
);

router.post(
  "/:scheduleId/delete",
  asyncHandler(async (req, res) => {
    const { scheduleId } = req.params;
    const db = await readDB();
    const current = db.schedules.find((item) => item.id === scheduleId);
    if (!current) throw new HttpError(404, "Schedule not found");
    ensureDeviceAccess(db, req.auth, current.deviceId);

    await updateDB((draft) => {
      draft.schedules = draft.schedules.filter((item) => item.id !== scheduleId);
    });

    publishDeviceEvent({
      type: "schedule.changed",
      deviceId: current.deviceId,
      payload: { action: "delete", scheduleId },
    });

    await logOperation({
      actorId: req.auth.userId || req.auth.deviceId,
      actorRole: req.auth.role,
      action: "schedule.delete",
      targetType: "schedule",
      targetId: scheduleId,
    });

    res.success({ id: scheduleId }, "Schedule deleted");
  })
);

router.post(
  "/batch-delete",
  asyncHandler(async (req, res) => {
    const { ids = [] } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, "ids涓嶈兘涓虹┖");

    const db = await readDB();
    const visible = getVisibleDeviceIds(db, req.auth);
    const removableRows = db.schedules.filter((item) => ids.includes(item.id) && visible.has(item.deviceId));
    const removableIds = removableRows.map((item) => item.id);

    await updateDB((draft) => {
      draft.schedules = draft.schedules.filter((item) => !removableIds.includes(item.id));
    });

    const grouped = new Map();
    removableRows.forEach((row) => {
      const list = grouped.get(row.deviceId) || [];
      list.push(row.id);
      grouped.set(row.deviceId, list);
    });
    grouped.forEach((scheduleIds, deviceId) => {
      publishDeviceEvent({
        type: "schedule.changed",
        deviceId,
        payload: { action: "batch_delete", scheduleIds },
      });
    });

    await logOperation({
      actorId: req.auth.userId || req.auth.deviceId,
      actorRole: req.auth.role,
      action: "schedule.batch_delete",
      targetType: "schedule_batch",
      targetId: `count:${removableIds.length}`,
    });

    res.success({ deletedIds: removableIds }, "鎵归噺鍒犻櫎瀹屾垚");
  })
);

router.get(
  "/xique/status",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const deviceId = String(req.query?.deviceId || "").trim();
    if (!deviceId) throw new HttpError(400, "deviceId is required");
    const status = await getXiqueStatus({ auth: req.auth, deviceId });
    res.success(status, "ok");
  })
);

router.post(
  "/xique/config",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const deviceId = String(req.body?.deviceId || "").trim();
    if (!deviceId) throw new HttpError(400, "deviceId is required");
    const result = await saveXiqueSyncConfig({ auth: req.auth, deviceId, body: req.body || {} });
    res.success(result, "鍠滈箠璇剧▼琛ㄩ厤缃凡淇濆瓨");
  })
);

router.post(
  "/xique/init-login",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const deviceId = String(req.body?.deviceId || "").trim();
    if (!deviceId) throw new HttpError(400, "deviceId is required");
    const result = await prepareXiqueLogin({ auth: req.auth, deviceId, body: req.body || {} });
    res.success(result, result.captchaRequired ? "Captcha required" : "Login ready");
  })
);

router.post(
  "/xique/import",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const deviceId = String(req.body?.deviceId || "").trim();
    if (!deviceId) throw new HttpError(400, "deviceId is required");
    const result = await submitXiqueImport({ auth: req.auth, deviceId, body: req.body || {} });
    res.success(result, result.status === "imported" ? "Xique schedule imported" : "Captcha required");
  })
);

router.post(
  "/xique/reverify",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const deviceId = String(req.body?.deviceId || "").trim();
    if (!deviceId) throw new HttpError(400, "deviceId is required");
    const result = await reverifyXiqueSession({ auth: req.auth, deviceId, body: req.body || {} });
    res.success(result, result.captchaRequired ? "Captcha required" : "Reverify ready");
  })
);

module.exports = router;
