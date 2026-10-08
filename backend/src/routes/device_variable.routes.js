const express = require("express");

const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess, resolveTargetDeviceIds } = require("../utils/access");
const { publishDeviceEvent } = require("../utils/realtime.hub");
const { logOperation } = require("../utils/logging");
const {
  normalizeVariableName,
  buildDeviceVariablePayload,
  upsertBaseVariableOnDevice,
  deleteBaseVariableOnDevice,
} = require("../services/device_variable.service");

const router = express.Router();
router.use(allowRoles("admin", "user"));

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
        // ignore malformed JSON and fall back to comma split
      }
    }
    return [...new Set(text.split(",").map((item) => String(item || "").trim()).filter(Boolean))];
  }
  return [];
}

function sampleRandomIds(list, count) {
  const safeCount = Math.floor(Number(count || 0));
  if (!Number.isFinite(safeCount) || safeCount <= 0 || safeCount >= list.length) return [...list];
  const rows = [...list];
  for (let i = rows.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows.slice(0, safeCount);
}

function resolveEntryTargets(db, auth, entry = {}, defaults = {}) {
  const deviceIds = normalizeIdList(entry.deviceIds).length ? normalizeIdList(entry.deviceIds) : normalizeIdList(defaults.deviceIds);
  const clusterIds = normalizeIdList(entry.clusterIds).length ? normalizeIdList(entry.clusterIds) : normalizeIdList(defaults.clusterIds);
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

  return {
    requestedCount: merged.size,
    targetIds: sampleRandomIds(allowed, Number(entry.randomCount || 0)),
    denied,
  };
}

router.get(
  "/:deviceId",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, req.params.deviceId);
    res.success(buildDeviceVariablePayload(db, device), "ok");
  })
);

router.post(
  "/:deviceId/base",
  asyncHandler(async (req, res) => {
    const name = normalizeVariableName(req.body?.name ?? req.body?.key);
    if (!name) throw new HttpError(400, "变量名不能为空");

    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, req.params.deviceId);
    let row = null;
    await updateDB((draft) => {
      const target = draft.devices.find((item) => String(item.id || "") === String(device.id || ""));
      if (!target) throw new HttpError(404, "设备不存在");
      row = upsertBaseVariableOnDevice(target, { name, value: req.body?.value });
    });

    publishDeviceEvent({
      type: "device.variables.updated",
      deviceId: device.id,
      payload: { source: "base", action: "upsert", name },
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "device_variable.upsert",
      targetType: "device",
      targetId: device.id,
      detail: { name },
    });

    const latest = await readDB();
    const latestDevice = ensureDeviceAccess(latest, req.auth, device.id);
    res.success({ row, ...buildDeviceVariablePayload(latest, latestDevice) }, "变量已保存");
  })
);

router.post(
  "/:deviceId/base/delete",
  asyncHandler(async (req, res) => {
    const name = normalizeVariableName(req.body?.name ?? req.body?.key);
    if (!name) throw new HttpError(400, "变量名不能为空");

    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, req.params.deviceId);
    let result = null;
    await updateDB((draft) => {
      const target = draft.devices.find((item) => String(item.id || "") === String(device.id || ""));
      if (!target) throw new HttpError(404, "设备不存在");
      result = deleteBaseVariableOnDevice(target, name);
    });

    publishDeviceEvent({
      type: "device.variables.updated",
      deviceId: device.id,
      payload: { source: "base", action: "delete", name },
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "device_variable.delete",
      targetType: "device",
      targetId: device.id,
      detail: { name },
    });

    res.success(result, result?.deleted ? "变量已删除" : "变量不存在");
  })
);

router.post(
  "/batch/base-upsert",
  asyncHandler(async (req, res) => {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (!entries.length) throw new HttpError(400, "entries不能为空");

    const db = await readDB();
    const defaults = {
      deviceIds: normalizeIdList(req.body?.defaultDeviceIds || req.body?.deviceIds),
      clusterIds: normalizeIdList(req.body?.defaultClusterIds || req.body?.clusterIds),
    };

    const normalizedEntries = entries
      .map((entry, index) => ({
        index,
        name: normalizeVariableName(entry?.name ?? entry?.key),
        value: entry?.value,
        deviceIds: normalizeIdList(entry?.deviceIds),
        clusterIds: normalizeIdList(entry?.clusterIds),
        randomCount: Math.max(0, Math.floor(Number(entry?.randomCount || 0))),
      }))
      .filter((entry) => entry.name);

    if (!normalizedEntries.length) throw new HttpError(400, "至少填写一个变量名");

    const success = [];
    const failed = [];
    let requestedTotal = 0;
    const touchedDeviceIds = new Set();

    await updateDB((draft) => {
      normalizedEntries.forEach((entry) => {
        const target = resolveEntryTargets(draft, req.auth, entry, defaults);
        requestedTotal += target.requestedCount;
        target.denied.forEach((item) => failed.push({ ...item, entryIndex: entry.index, name: entry.name }));
        if (!target.targetIds.length) {
          if (!target.denied.length) {
            failed.push({ entryIndex: entry.index, name: entry.name, reason: "未找到目标设备" });
          }
          return;
        }
        target.targetIds.forEach((deviceId) => {
          const device = draft.devices.find((item) => String(item.id || "") === String(deviceId || ""));
          if (!device) {
            failed.push({ deviceId, entryIndex: entry.index, name: entry.name, reason: "设备不存在" });
            return;
          }
          try {
            const row = upsertBaseVariableOnDevice(device, { name: entry.name, value: entry.value });
            success.push({ deviceId, name: row.name, value: row.value, entryIndex: entry.index });
            touchedDeviceIds.add(deviceId);
          } catch (error) {
            failed.push({ deviceId, entryIndex: entry.index, name: entry.name, reason: error?.message || "变量保存失败" });
          }
        });
      });
    });

    touchedDeviceIds.forEach((deviceId) => {
      publishDeviceEvent({
        type: "device.variables.updated",
        deviceId,
        payload: { source: "base", action: "batch_upsert" },
      });
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "device_variable.batch_upsert",
      targetType: "device_batch",
      targetId: `count:${touchedDeviceIds.size}`,
      detail: {
        entryCount: normalizedEntries.length,
        successCount: success.length,
        failedCount: failed.length,
      },
    });

    res.success(
      {
        total: requestedTotal,
        successCount: success.length,
        failedCount: failed.length,
        successDeviceIds: [...touchedDeviceIds],
        failed,
        results: success,
      },
      success.length ? "批量变量已保存" : "没有变量被保存"
    );
  })
);

module.exports = router;
