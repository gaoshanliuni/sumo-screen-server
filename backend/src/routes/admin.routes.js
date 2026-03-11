const express = require("express");
const bcrypt = require("bcryptjs");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { logOperation } = require("../utils/logging");
const { publishDeviceEvent } = require("../utils/realtime.hub");
const createId = require("../utils/id");
const dashboardRoutes = require("./dashboard.routes");

const router = express.Router();
router.use(allowRoles("admin"));
router.use("/dashboard", dashboardRoutes);

function buildUserSummary(user, db) {
  const deviceCount = db.devices.filter((item) => item.ownerId === user.id && item.bindState === "bound").length;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    nickname: user.nickname || "",
    status: user.status || "enabled",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    deviceCount,
  };
}

function ensureUserExists(db, userId) {
  return db.users.some((item) => item.id === userId && item.status !== "blocked");
}

function ensureNotLastAdmin(db, userId) {
  const target = db.users.find((item) => item.id === userId);
  if (!target || target.role !== "admin") return;
  const adminCount = db.users.filter((item) => item.role === "admin").length;
  if (adminCount <= 1) {
    throw new HttpError(400, "至少需要保留一个管理员账号");
  }
}

function cleanupDevices(draft, deviceIds) {
  const cleanup = {
    devices: 0,
    todos: 0,
    schedules: 0,
    upgradeJobs: 0,
    clusterRefs: 0,
    bindingPins: 0,
  };

  if (deviceIds.length === 0) return cleanup;
  cleanup.devices = deviceIds.length;

  const todoBefore = draft.todos.length;
  draft.todos = draft.todos.filter((item) => !deviceIds.includes(item.deviceId));
  cleanup.todos = todoBefore - draft.todos.length;

  const scheduleBefore = draft.schedules.length;
  draft.schedules = draft.schedules.filter((item) => !deviceIds.includes(item.deviceId));
  cleanup.schedules = scheduleBefore - draft.schedules.length;

  const jobBefore = draft.upgradeJobs.length;
  draft.upgradeJobs = draft.upgradeJobs.filter((item) => !deviceIds.includes(item.deviceId));
  cleanup.upgradeJobs = jobBefore - draft.upgradeJobs.length;

  const pinBefore = draft.bindingPins.length;
  draft.bindingPins = draft.bindingPins.filter((item) => !deviceIds.includes(item.deviceId));
  cleanup.bindingPins = pinBefore - draft.bindingPins.length;

  draft.clusters.forEach((cluster) => {
    const before = (cluster.deviceIds || []).length;
    cluster.deviceIds = (cluster.deviceIds || []).filter((id) => !deviceIds.includes(id));
    const removed = before - cluster.deviceIds.length;
    if (removed > 0) {
      cleanup.clusterRefs += removed;
      cluster.updatedAt = new Date().toISOString();
    }
  });

  draft.devices = draft.devices.filter((item) => !deviceIds.includes(item.id));
  return cleanup;
}

router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const { role, keyword, status } = req.query || {};
    const db = await readDB();
    let users = db.users;

    if (role) users = users.filter((item) => item.role === role);
    if (status) users = users.filter((item) => item.status === status);
    if (keyword) {
      const text = String(keyword).toLowerCase();
      users = users.filter(
        (item) =>
          item.username.toLowerCase().includes(text) ||
          (item.nickname || "").toLowerCase().includes(text) ||
          item.id.toLowerCase().includes(text)
      );
    }

    res.success(users.map((item) => buildUserSummary(item, db)), "ok");
  })
);

router.post(
  "/users",
  asyncHandler(async (req, res) => {
    const { username, password, role = "user", nickname = "" } = req.body || {};
    if (!username || !password) throw new HttpError(400, "用户名和密码不能为空");
    if (!["admin", "user"].includes(role)) throw new HttpError(400, "role仅支持admin/user");
    if (String(password).length < 6) throw new HttpError(400, "密码长度至少6位");

    const db = await readDB();
    if (db.users.some((item) => item.username === username)) throw new HttpError(409, "用户名已存在");

    const now = new Date().toISOString();
    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = {
      id: createId("u"),
      username: String(username),
      passwordHash,
      role,
      nickname: String(nickname || ""),
      status: "enabled",
      createdAt: now,
      updatedAt: now,
    };

    await updateDB((draft) => {
      draft.users.push(user);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "user.create",
      targetType: "user",
      targetId: user.id,
      detail: { username: user.username, role: user.role },
    });

    res.success(buildUserSummary(user, { ...db, devices: db.devices }), "账号创建成功");
  })
);

router.post(
  "/users/:userId",
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const payload = req.body || {};
    const db = await readDB();
    const current = db.users.find((item) => item.id === userId);
    if (!current) throw new HttpError(404, "账号不存在");

    if (payload.role && !["admin", "user"].includes(payload.role)) {
      throw new HttpError(400, "role仅支持admin/user");
    }
    if (payload.status && !["enabled", "blocked"].includes(payload.status)) {
      throw new HttpError(400, "status仅支持enabled/blocked");
    }
    if (payload.role && current.role === "admin" && payload.role !== "admin") {
      ensureNotLastAdmin(db, userId);
    }
    if (payload.status === "blocked" && current.role === "admin") {
      ensureNotLastAdmin(db, userId);
    }

    let updated = null;
    await updateDB((draft) => {
      const target = draft.users.find((item) => item.id === userId);
      if (!target) throw new HttpError(404, "账号不存在");
      if (payload.nickname !== undefined) target.nickname = String(payload.nickname || "");
      if (payload.role) target.role = payload.role;
      if (payload.status) target.status = payload.status;
      target.updatedAt = new Date().toISOString();
      updated = target;
    });

    if (payload.password) {
      if (String(payload.password).length < 6) throw new HttpError(400, "密码长度至少6位");
      const nextHash = await bcrypt.hash(String(payload.password), 10);
      await updateDB((draft) => {
        const target = draft.users.find((item) => item.id === userId);
        if (target) {
          target.passwordHash = nextHash;
          target.updatedAt = new Date().toISOString();
        }
      });
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "user.update",
      targetType: "user",
      targetId: userId,
      detail: payload,
    });

    const fresh = (await readDB()).users.find((item) => item.id === userId);
    res.success(buildUserSummary(fresh || updated, await readDB()), "账号已更新");
  })
);

router.post(
  "/users/:userId/resources",
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { action, targetUserId } = req.body || {};
    if (!["detach", "purge", "transfer"].includes(action)) {
      throw new HttpError(400, "action仅支持detach/purge/transfer");
    }

    const db = await readDB();
    const current = db.users.find((item) => item.id === userId);
    if (!current) throw new HttpError(404, "账号不存在");

    let transferTarget = null;
    if (action === "transfer") {
      if (!targetUserId) throw new HttpError(400, "transfer需要targetUserId");
      if (targetUserId === userId) throw new HttpError(400, "不能转移给自己");
      if (!ensureUserExists(db, targetUserId)) throw new HttpError(400, "目标用户不存在或已封禁");
      transferTarget = db.users.find((item) => item.id === targetUserId);
    }

    const ownedDevices = db.devices.filter((item) => item.ownerId === userId);
    const deviceIds = ownedDevices.map((item) => item.id);
    const now = new Date().toISOString();
    let cleanup = {
      devices: deviceIds.length,
      todos: 0,
      schedules: 0,
      upgradeJobs: 0,
      clusterRefs: 0,
      bindingPins: 0,
    };

    await updateDB((draft) => {
      if (action === "purge") {
        cleanup = cleanupDevices(draft, deviceIds);
      } else if (action === "detach") {
        draft.devices.forEach((device) => {
          if (device.ownerId === userId) {
            device.ownerId = "";
            device.bindState = "pending";
            device.boundAt = "";
            device.boundBy = req.auth.userId;
            device.updatedAt = now;
          }
        });
      } else if (action === "transfer") {
        draft.devices.forEach((device) => {
          if (device.ownerId === userId) {
            device.ownerId = transferTarget.id;
            device.bindState = "bound";
            device.boundAt = now;
            device.boundBy = req.auth.userId;
            device.updatedAt = now;
          }
        });
      }
    });

    if (action === "purge") {
      deviceIds.forEach((id) => {
        publishDeviceEvent({ type: "device.deleted", deviceId: id, payload: { reason: "user_resource_purge" } });
      });
    } else {
      deviceIds.forEach((id) => {
        publishDeviceEvent({
          type: "device.updated",
          deviceId: id,
          payload: { action: `resource_${action}`, actor: req.auth.userId },
        });
      });
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "user.resources",
      targetType: "user",
      targetId: userId,
      detail: { action, targetUserId, deviceCount: deviceIds.length, cleanup },
    });

    res.success({ action, userId, targetUserId: transferTarget?.id || "", cleanup }, "资源处理完成");
  })
);

router.post(
  "/users/:userId/delete",
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { mode = "detach" } = req.body || {};
    if (!["detach", "purge"].includes(mode)) throw new HttpError(400, "mode仅支持detach/purge");

    const db = await readDB();
    const target = db.users.find((item) => item.id === userId);
    if (!target) throw new HttpError(404, "账号不存在");
    ensureNotLastAdmin(db, userId);

    const ownedDevices = db.devices.filter((item) => item.ownerId === userId);
    const deviceIds = ownedDevices.map((item) => item.id);
    const now = new Date().toISOString();
    let cleanup = {
      devices: deviceIds.length,
      todos: 0,
      schedules: 0,
      upgradeJobs: 0,
      clusterRefs: 0,
      bindingPins: 0,
      tfFiles: 0,
    };

    await updateDB((draft) => {
      const index = draft.users.findIndex((item) => item.id === userId);
      if (index < 0) throw new HttpError(404, "账号不存在");
      draft.users.splice(index, 1);

      if (mode === "purge") {
        const removed = cleanupDevices(draft, deviceIds);
        cleanup = { ...cleanup, ...removed };
      } else {
        draft.devices.forEach((device) => {
          if (device.ownerId === userId) {
            device.ownerId = "";
            device.bindState = "pending";
            device.boundAt = "";
            device.boundBy = req.auth.userId;
            device.updatedAt = now;
          }
        });
      }

      const before = draft.tfFiles.length;
      draft.tfFiles = draft.tfFiles.filter((file) => file.ownerId !== userId);
      cleanup.tfFiles = before - draft.tfFiles.length;
    });

    if (mode === "purge") {
      deviceIds.forEach((id) => {
        publishDeviceEvent({ type: "device.deleted", deviceId: id, payload: { reason: "user_delete_purge" } });
      });
    } else {
      deviceIds.forEach((id) => {
        publishDeviceEvent({
          type: "device.updated",
          deviceId: id,
          payload: { action: "user_delete_detach", actor: req.auth.userId },
        });
      });
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "user.delete",
      targetType: "user",
      targetId: userId,
      detail: { mode, deviceCount: deviceIds.length, cleanup },
    });

    res.success({ id: userId, mode, cleanup }, "账号已删除");
  })
);

module.exports = router;
