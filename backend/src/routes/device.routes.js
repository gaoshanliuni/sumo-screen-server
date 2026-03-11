const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { readDB, updateDB } = require("../db/store");
const { allowRoles } = require("../middleware/auth");
const { ensureDeviceAccess, resolveTargetDeviceIds } = require("../utils/access");
const { logOperation } = require("../utils/logging");
const { publishDeviceEvent } = require("../utils/realtime.hub");

const router = express.Router();

function normalizeMac(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, ":");
}

function isMacValid(mac) {
  const compact = mac.replace(/:/g, "");
  return /^[0-9A-F]{12}$/.test(compact);
}

function ensureUserExists(db, userId) {
  return db.users.some((item) => item.id === userId && item.role === "user" && item.status !== "blocked");
}

function normalizePin(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "");
}

function normalizeThirdParams(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function deleteDeviceFromDraft(draft, deviceId) {
  const cleanup = {
    todos: 0,
    schedules: 0,
    upgradeJobs: 0,
    clusterRefs: 0,
    bindingPins: 0,
    tfLocal: 0,
  };

  const deviceIndex = draft.devices.findIndex((item) => item.id === deviceId);
  if (deviceIndex < 0) throw new HttpError(404, `device not found: ${deviceId}`);
  draft.devices.splice(deviceIndex, 1);

  const todoBefore = draft.todos.length;
  draft.todos = draft.todos.filter((item) => item.deviceId !== deviceId);
  cleanup.todos = todoBefore - draft.todos.length;

  const scheduleBefore = draft.schedules.length;
  draft.schedules = draft.schedules.filter((item) => item.deviceId !== deviceId);
  cleanup.schedules = scheduleBefore - draft.schedules.length;

  const jobBefore = draft.upgradeJobs.length;
  draft.upgradeJobs = draft.upgradeJobs.filter((item) => item.deviceId !== deviceId);
  cleanup.upgradeJobs = jobBefore - draft.upgradeJobs.length;

  const pinBefore = draft.bindingPins.length;
  draft.bindingPins = draft.bindingPins.filter((item) => item.deviceId !== deviceId);
  cleanup.bindingPins = pinBefore - draft.bindingPins.length;

  const tfBefore = draft.tfDeviceFiles.length;
  draft.tfDeviceFiles = draft.tfDeviceFiles.filter((item) => item.deviceId !== deviceId);
  cleanup.tfLocal = tfBefore - draft.tfDeviceFiles.length;

  draft.clusters.forEach((cluster) => {
    const before = (cluster.deviceIds || []).length;
    cluster.deviceIds = (cluster.deviceIds || []).filter((id) => id !== deviceId);
    const removed = before - cluster.deviceIds.length;
    if (removed > 0) {
      cleanup.clusterRefs += removed;
      cluster.updatedAt = new Date().toISOString();
    }
  });

  return cleanup;
}

router.post(
  "/batch/config",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { deviceIds = [], clusterIds = [], keys = {} } = req.body || {};
    if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.keys(keys).length === 0) {
      throw new HttpError(400, "keys配置不能为空");
    }

    const db = await readDB();
    const slugs = new Set(db.apiTemplates.map((item) => item.slug));
    const invalidSlug = Object.keys(keys).find((slug) => !slugs.has(slug));
    if (invalidSlug) throw new HttpError(400, `API模板不存在: ${invalidSlug}`);

    const targetIds = resolveTargetDeviceIds(db, deviceIds, clusterIds);
    if (targetIds.length === 0) throw new HttpError(400, "未找到目标设备");

    const result = { success: [], failed: [] };

    await updateDB((draft) => {
      targetIds.forEach((id) => {
        const device = draft.devices.find((item) => item.id === id);
        if (!device) {
          result.failed.push({ deviceId: id, reason: "设备不存在" });
          return;
        }
        device.apiKeys = device.apiKeys || {};
        Object.keys(keys).forEach((slug) => {
          const value = keys[slug];
          if (value === null || value === undefined || value === "") {
            delete device.apiKeys[slug];
          } else {
            device.apiKeys[slug] = String(value);
          }
        });
        device.updatedAt = new Date().toISOString();
        result.success.push({ deviceId: id });
      });
    });

    result.success.forEach((item) => {
      publishDeviceEvent({
        type: "device.updated",
        deviceId: item.deviceId,
        payload: { action: "batch_config", keys: Object.keys(keys) },
      });
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "device.batch_config_push",
      targetType: "device_batch",
      targetId: `count:${targetIds.length}`,
      detail: { keys: Object.keys(keys), clusterIds, deviceIds },
    });

    res.success(result, "批量下发完成");
  })
);

router.post(
  "/register",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { mac: rawMac, ownerId, type = "ink-screen", remark = "", displayName = "" } = req.body || {};
    const mac = normalizeMac(rawMac);
    if (!mac || !isMacValid(mac)) throw new HttpError(400, "MAC地址格式不合法");

    const db = await readDB();
    const exists = db.devices.find((item) => item.mac === mac);
    if (exists) throw new HttpError(409, "该MAC已注册");

    const finalOwnerId = ownerId;
    if (!finalOwnerId) throw new HttpError(400, "ownerId不能为空");
    if (!ensureUserExists(db, finalOwnerId)) throw new HttpError(400, "绑定用户不存在");

    const now = new Date().toISOString();
    const device = {
      id: createId("dev"),
      mac,
      ownerId: finalOwnerId,
      type,
      remark,
      displayName: String(displayName || "").trim(),
      defaultView: "home",
      status: "enabled",
      apiKeys: {},
      firmwareVersion: "",
      simulated: false,
      bindState: "bound",
      boundAt: now,
      boundBy: req.auth.userId,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: "",
    };

    await updateDB((draft) => {
      draft.devices.push(device);
    });

    publishDeviceEvent({
      type: "device.created",
      deviceId: device.id,
      payload: { simulated: false, ownerId: device.ownerId },
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "device.register",
      targetType: "device",
      targetId: device.id,
      detail: { mac: device.mac, ownerId: device.ownerId },
    });

    res.success(device, "设备注册成功");
  })
);

router.get(
  "/",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const { status, mac, ownerId, simulated, bound } = req.query || {};
    const db = await readDB();
    let list = db.devices;

    if (req.auth.role === "user") {
      list = list.filter((item) => item.ownerId === req.auth.userId);
    }

    if (status) list = list.filter((item) => item.status === status);
    if (mac) list = list.filter((item) => item.mac.includes(String(mac).toUpperCase()));
    if (ownerId && req.auth.role === "admin") list = list.filter((item) => item.ownerId === ownerId);
    if (simulated === "true") list = list.filter((item) => item.simulated === true);
    if (simulated === "false") list = list.filter((item) => item.simulated !== true);
    if (bound === "true") list = list.filter((item) => item.bindState === "bound");
    if (bound === "false") list = list.filter((item) => item.bindState !== "bound");

    const clusterMap = new Map();
    (db.clusters || []).forEach((cluster) => {
      (cluster.deviceIds || []).forEach((deviceId) => {
        if (!clusterMap.has(deviceId)) clusterMap.set(deviceId, []);
        clusterMap.get(deviceId).push({ id: cluster.id, name: cluster.name || "" });
      });
    });

    const rows = list.map((item) => ({
      ...item,
      clusterIds: (clusterMap.get(item.id) || []).map((x) => x.id),
      clusterNames: (clusterMap.get(item.id) || []).map((x) => x.name).filter(Boolean),
    }));

    res.success(rows, "ok");
  })
);

router.post(
  "/bind-pin",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body?.pin);
    const ownerIdInput = String(req.body?.ownerId || "").trim();
    if (!/^\d{6}$/.test(pin)) throw new HttpError(400, "PIN码必须是6位数字");

    const db = await readDB();
    const nowTs = Date.now();
    const pinRow = db.bindingPins.find((item) => item.pin === pin && item.status === "pending");
    if (!pinRow) throw new HttpError(400, "PIN码无效或已失效");

    if (new Date(pinRow.expiresAt).getTime() <= nowTs) {
      await updateDB((draft) => {
        const target = draft.bindingPins.find((item) => item.id === pinRow.id);
        if (target && target.status === "pending") {
          target.status = "expired";
        }
      });
      throw new HttpError(400, "PIN码已过期");
    }

    if (Number(pinRow.attempts || 0) >= Number(pinRow.maxAttempts || 5)) {
      await updateDB((draft) => {
        const target = draft.bindingPins.find((item) => item.id === pinRow.id);
        if (target) target.status = "max_attempts";
      });
      throw new HttpError(400, "PIN码尝试次数已超限");
    }

    const targetOwnerId = req.auth.role === "admin" ? ownerIdInput : req.auth.userId;
    if (!targetOwnerId) throw new HttpError(400, "管理员绑定时必须指定ownerId");
    if (!ensureUserExists(db, targetOwnerId)) throw new HttpError(400, "ownerId对应用户不存在");

    const device = db.devices.find((item) => item.id === pinRow.deviceId);
    if (!device) throw new HttpError(404, "设备不存在");
    if (device.status === "blocked") throw new HttpError(403, "设备已封禁");

    const now = new Date().toISOString();
    let updatedDevice = null;
    await updateDB((draft) => {
      const pinTarget = draft.bindingPins.find((item) => item.id === pinRow.id);
      if (!pinTarget || pinTarget.status !== "pending") {
        throw new HttpError(400, "PIN码无效或已失效");
      }
      pinTarget.attempts = Number(pinTarget.attempts || 0) + 1;
      pinTarget.status = "used";
      pinTarget.usedBy = targetOwnerId;
      pinTarget.usedAt = now;

      draft.bindingPins.forEach((item) => {
        if (item.deviceId === pinTarget.deviceId && item.id !== pinTarget.id && item.status === "pending") {
          item.status = "replaced";
        }
      });

      const deviceTarget = draft.devices.find((item) => item.id === pinTarget.deviceId);
      if (!deviceTarget) throw new HttpError(404, "设备不存在");
      deviceTarget.ownerId = targetOwnerId;
      deviceTarget.bindState = "bound";
      deviceTarget.boundAt = now;
      deviceTarget.boundBy = req.auth.userId;
      deviceTarget.updatedAt = now;
      updatedDevice = deviceTarget;
    });

    publishDeviceEvent({
      type: "device.bound",
      deviceId: updatedDevice.id,
      payload: { ownerId: updatedDevice.ownerId, actorRole: req.auth.role },
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "device.bind_pin",
      targetType: "device",
      targetId: updatedDevice.id,
      detail: { pin: "***", ownerId: updatedDevice.ownerId },
    });

    res.success(updatedDevice, "设备绑定成功");
  })
);

router.get(
  "/:deviceId/third-params",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, req.params.deviceId);
    const all = normalizeThirdParams(device.thirdApiParams);
    const slug = String(req.query?.slug || "").trim();
    if (!slug) return res.success(all, "ok");
    return res.success(all[slug] && typeof all[slug] === "object" ? all[slug] : {}, "ok");
  })
);

router.post(
  "/batch/third-params",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const { deviceIds = [], clusterIds = [], slug = "", params = {} } = req.body || {};
    const targetSlug = String(slug || "").trim();
    if (!targetSlug) throw new HttpError(400, "slug不能为空");

    const db = await readDB();
    const tpl = db.apiTemplates.find((item) => item.slug === targetSlug);
    if (!tpl) throw new HttpError(404, "模板不存在");

    const requestedIds = resolveTargetDeviceIds(db, deviceIds, clusterIds);
    if (requestedIds.length === 0) throw new HttpError(400, "未找到目标设备");

    const normalizedParams = normalizeThirdParams(params);
    const denied = [];
    const writableIds = [];
    requestedIds.forEach((id) => {
      try {
        ensureDeviceAccess(db, req.auth, id);
        writableIds.push(id);
      } catch (error) {
        denied.push({ deviceId: id, reason: error?.message || "无权限或设备不存在" });
      }
    });

    const success = [];
    const failed = [...denied];
    await updateDB((draft) => {
      writableIds.forEach((id) => {
        const target = draft.devices.find((item) => item.id === id);
        if (!target) {
          failed.push({ deviceId: id, reason: "设备不存在" });
          return;
        }
        target.thirdApiParams =
          target.thirdApiParams && typeof target.thirdApiParams === "object" && !Array.isArray(target.thirdApiParams)
            ? target.thirdApiParams
            : {};
        if (Object.keys(normalizedParams).length === 0) {
          delete target.thirdApiParams[targetSlug];
        } else {
          target.thirdApiParams[targetSlug] = { ...normalizedParams };
        }
        target.updatedAt = new Date().toISOString();
        const current = target.thirdApiParams[targetSlug] || {};
        success.push({ deviceId: id, slug: targetSlug, params: current });
      });
    });

    success.forEach((item) => {
      publishDeviceEvent({
        type: "third.params.changed",
        deviceId: item.deviceId,
        payload: {
          slug: targetSlug,
          params: item.params,
        },
      });
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "device.third_params_batch_update",
      targetType: "device_batch",
      targetId: `count:${success.length}`,
      detail: {
        slug: targetSlug,
        requestedCount: requestedIds.length,
        successCount: success.length,
        failedCount: failed.length,
      },
    });

    res.success(
      {
        total: requestedIds.length,
        successCount: success.length,
        failedCount: failed.length,
        successDeviceIds: success.map((item) => item.deviceId),
        failed,
      },
      "批量参数下发成功"
    );
  })
);

router.post(
  "/:deviceId/third-params",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, req.params.deviceId);
    const slug = String(req.body?.slug || "").trim();
    const params = normalizeThirdParams(req.body?.params);
    if (!slug) throw new HttpError(400, "slug不能为空");

    const tpl = db.apiTemplates.find((item) => item.slug === slug);
    if (!tpl) throw new HttpError(404, "模板不存在");

    let updatedParams = {};
    await updateDB((draft) => {
      const target = draft.devices.find((item) => item.id === device.id);
      if (!target) throw new HttpError(404, "设备不存在");
      target.thirdApiParams =
        target.thirdApiParams && typeof target.thirdApiParams === "object" && !Array.isArray(target.thirdApiParams)
          ? target.thirdApiParams
          : {};
      if (Object.keys(params).length === 0) {
        delete target.thirdApiParams[slug];
      } else {
        target.thirdApiParams[slug] = params;
      }
      target.updatedAt = new Date().toISOString();
      updatedParams = target.thirdApiParams[slug] || {};
    });

    publishDeviceEvent({
      type: "third.params.changed",
      deviceId: device.id,
      payload: {
        slug,
        params: updatedParams,
      },
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "device.third_params_update",
      targetType: "device",
      targetId: device.id,
      detail: { slug, keys: Object.keys(updatedParams) },
    });

    res.success({ slug, params: updatedParams }, "参数下发成功");
  })
);

router.get(
  "/:deviceId",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, req.params.deviceId);
    res.success(device, "ok");
  })
);

router.post(
  "/:deviceId",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const current = ensureDeviceAccess(db, req.auth, req.params.deviceId);

    const payload = req.body || {};
    const allowedFields =
      req.auth.role === "admin"
        ? ["remark", "displayName", "defaultView", "status", "ownerId", "type", "mac", "firmwareVersion", "simulated", "bindState", "boundAt", "boundBy"]
        : ["remark", "displayName"];

    const patch = {};
    Object.keys(payload).forEach((key) => {
      if (allowedFields.includes(key)) patch[key] = payload[key];
    });
    if (Object.keys(patch).length === 0) throw new HttpError(400, "无可更新字段");

    if (patch.mac) {
      const normalized = normalizeMac(patch.mac);
      if (!isMacValid(normalized)) throw new HttpError(400, "MAC地址格式不合法");
      patch.mac = normalized;
      const duplicate = db.devices.find((item) => item.mac === normalized && item.id !== current.id);
      if (duplicate) throw new HttpError(409, "MAC地址重复");
    }

    if (patch.status && !["enabled", "blocked"].includes(patch.status)) {
      throw new HttpError(400, "status仅支持 enabled/blocked");
    }
    if (patch.ownerId && req.auth.role === "admin" && !ensureUserExists(db, patch.ownerId)) {
      throw new HttpError(400, "ownerId对应用户不存在");
    }
    if (patch.bindState && !["pending", "bound"].includes(String(patch.bindState))) {
      throw new HttpError(400, "bindState仅支持 pending/bound");
    }
    if (patch.defaultView && !["home", "reader", "file", "settings", "nameplate", "provision"].includes(String(patch.defaultView))) {
      throw new HttpError(400, "defaultView不合法");
    }
    if (patch.displayName !== undefined) {
      patch.displayName = String(patch.displayName || "").trim();
    }
    if (req.auth.role === "admin" && patch.ownerId !== undefined) {
      if (patch.ownerId) {
        patch.bindState = "bound";
        patch.boundAt = patch.boundAt || new Date().toISOString();
        patch.boundBy = patch.boundBy || req.auth.userId;
      } else {
        patch.bindState = "pending";
        patch.boundAt = "";
      }
    }

    let updated;
    await updateDB((draft) => {
      const target = draft.devices.find((item) => item.id === current.id);
      Object.assign(target, patch, { updatedAt: new Date().toISOString() });
      updated = target;
    });

    publishDeviceEvent({
      type: "device.updated",
      deviceId: current.id,
      payload: { patch },
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "device.update",
      targetType: "device",
      targetId: current.id,
      detail: patch,
    });

    res.success(updated, "设备信息已更新");
  })
);

router.post(
  "/batch/delete",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const { deviceIds = [], clusterIds = [], deleteAll = false, filters = {} } = req.body || {};
    const db = await readDB();

    let requestedIds = [];
    if (deleteAll) {
      let list = db.devices.filter((item) => req.auth.role === "admin" || item.ownerId === req.auth.userId);
      const status = String(filters.status || "").trim();
      const bound = String(filters.bound || "").trim();
      const keyword = String(filters.keyword || "").trim().toLowerCase();
      if (status) list = list.filter((item) => String(item.status || "") === status);
      if (bound === "bound") list = list.filter((item) => item.bindState === "bound");
      if (bound === "unbound") list = list.filter((item) => item.bindState !== "bound");
      if (keyword) {
        list = list.filter((item) => {
          const merged = `${item.id} ${item.mac} ${item.displayName || ""} ${item.remark || ""}`.toLowerCase();
          return merged.includes(keyword);
        });
      }
      requestedIds = list.map((item) => item.id);
    } else {
      requestedIds = resolveTargetDeviceIds(db, deviceIds, clusterIds);
    }

    if (!requestedIds.length) throw new HttpError(400, "no target devices");

    const writableIds = [];
    const denied = [];
    requestedIds.forEach((id) => {
      try {
        ensureDeviceAccess(db, req.auth, id);
        writableIds.push(id);
      } catch (error) {
        denied.push({ deviceId: id, reason: error?.message || "access denied" });
      }
    });

    if (!writableIds.length) {
      return res.success(
        {
          total: requestedIds.length,
          successCount: 0,
          failedCount: denied.length,
          deletedDeviceIds: [],
          failed: denied,
        },
        "no device deleted"
      );
    }

    const deletedDeviceIds = [];
    const failed = [...denied];
    const cleanupSummary = {
      todos: 0,
      schedules: 0,
      upgradeJobs: 0,
      clusterRefs: 0,
      bindingPins: 0,
      tfLocal: 0,
    };

    await updateDB((draft) => {
      writableIds.forEach((deviceId) => {
        try {
          const cleanup = deleteDeviceFromDraft(draft, deviceId);
          deletedDeviceIds.push(deviceId);
          cleanupSummary.todos += cleanup.todos;
          cleanupSummary.schedules += cleanup.schedules;
          cleanupSummary.upgradeJobs += cleanup.upgradeJobs;
          cleanupSummary.clusterRefs += cleanup.clusterRefs;
          cleanupSummary.bindingPins += cleanup.bindingPins;
          cleanupSummary.tfLocal += cleanup.tfLocal;
        } catch (error) {
          failed.push({ deviceId, reason: error?.message || "delete failed" });
        }
      });
    });

    deletedDeviceIds.forEach((deviceId) => {
      publishDeviceEvent({
        type: "device.deleted",
        deviceId,
        payload: { cleanup: cleanupSummary, batch: true },
      });
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "device.batch_delete",
      targetType: "device_batch",
      targetId: `count:${deletedDeviceIds.length}`,
      detail: {
        requestedCount: requestedIds.length,
        deletedCount: deletedDeviceIds.length,
        failedCount: failed.length,
        deleteAll: Boolean(deleteAll),
        filters: deleteAll ? filters : undefined,
      },
    });

    res.success(
      {
        total: requestedIds.length,
        successCount: deletedDeviceIds.length,
        failedCount: failed.length,
        deletedDeviceIds,
        failed,
        cleanup: cleanupSummary,
      },
      "batch delete done"
    );
  })
);

router.post(
  "/:deviceId/delete",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const { deviceId } = req.params;
    const db = await readDB();
    const current = ensureDeviceAccess(db, req.auth, deviceId);

    const cleanup = {
      todos: 0,
      schedules: 0,
      upgradeJobs: 0,
      clusterRefs: 0,
      bindingPins: 0,
      tfLocal: 0,
    };

    await updateDB((draft) => {
      const deviceIndex = draft.devices.findIndex((item) => item.id === deviceId);
      if (deviceIndex < 0) throw new HttpError(404, "设备不存在");
      draft.devices.splice(deviceIndex, 1);

      const todoBefore = draft.todos.length;
      draft.todos = draft.todos.filter((item) => item.deviceId !== deviceId);
      cleanup.todos = todoBefore - draft.todos.length;

      const scheduleBefore = draft.schedules.length;
      draft.schedules = draft.schedules.filter((item) => item.deviceId !== deviceId);
      cleanup.schedules = scheduleBefore - draft.schedules.length;

      const jobBefore = draft.upgradeJobs.length;
      draft.upgradeJobs = draft.upgradeJobs.filter((item) => item.deviceId !== deviceId);
      cleanup.upgradeJobs = jobBefore - draft.upgradeJobs.length;

      const pinBefore = draft.bindingPins.length;
      draft.bindingPins = draft.bindingPins.filter((item) => item.deviceId !== deviceId);
      cleanup.bindingPins = pinBefore - draft.bindingPins.length;

      const tfBefore = draft.tfDeviceFiles.length;
      draft.tfDeviceFiles = draft.tfDeviceFiles.filter((item) => item.deviceId !== deviceId);
      cleanup.tfLocal = tfBefore - draft.tfDeviceFiles.length;

      draft.clusters.forEach((cluster) => {
        const before = (cluster.deviceIds || []).length;
        cluster.deviceIds = (cluster.deviceIds || []).filter((id) => id !== deviceId);
        const removed = before - cluster.deviceIds.length;
        if (removed > 0) {
          cleanup.clusterRefs += removed;
          cluster.updatedAt = new Date().toISOString();
        }
      });
    });

    publishDeviceEvent({
      type: "device.deleted",
      deviceId,
      payload: { cleanup },
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "device.delete",
      targetType: "device",
      targetId: deviceId,
      detail: {
        mac: current.mac,
        ownerId: current.ownerId,
        cleanup,
      },
    });

    res.success({ id: deviceId, cleanup }, "设备已删除");
  })
);

router.get(
  "/:deviceId/keys",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, req.params.deviceId);
    res.success(device.apiKeys || {}, "ok");
  })
);

router.post(
  "/:deviceId/keys",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, req.params.deviceId);
    const payload = req.body || {};
    const slugs = new Set(db.apiTemplates.map((item) => item.slug));
    const updates = payload.keys && typeof payload.keys === "object" ? payload.keys : null;
    if (!updates || Array.isArray(updates) || Object.keys(updates).length === 0) {
      throw new HttpError(400, "请以 keys 对象提交更新");
    }

    const invalid = Object.keys(updates).find((slug) => !slugs.has(slug));
    if (invalid) throw new HttpError(400, `API模板不存在: ${invalid}`);

    let nextKeys = {};
    await updateDB((draft) => {
      const target = draft.devices.find((item) => item.id === device.id);
      target.apiKeys = target.apiKeys || {};
      Object.keys(updates).forEach((slug) => {
        const value = updates[slug];
        if (value === null || value === undefined || value === "") {
          delete target.apiKeys[slug];
        } else {
          target.apiKeys[slug] = String(value);
        }
      });
      target.updatedAt = new Date().toISOString();
      nextKeys = target.apiKeys;
    });

    publishDeviceEvent({
      type: "device.updated",
      deviceId: device.id,
      payload: { action: "keys_update", keys: Object.keys(updates) },
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "device.update_keys",
      targetType: "device",
      targetId: device.id,
      detail: { keys: Object.keys(updates) },
    });

    res.success(nextKeys, "设备密钥更新成功");
  })
);

module.exports = router;
