const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess, getVisibleDeviceIds, resolveTargetDeviceIds } = require("../utils/access");
const { logOperation } = require("../utils/logging");
const { publishDeviceEvent } = require("../utils/realtime.hub");

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
        // ignore json parse error and fallback to comma split
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
  if (!merged.size) throw new HttpError(400, "至少提供一个目标设备");

  const targetIds = [];
  const denied = [];
  [...merged].forEach((id) => {
    try {
      ensureDeviceAccess(db, auth, id);
      targetIds.push(id);
    } catch (error) {
      denied.push({ deviceId: id, reason: error?.message || "无权限或设备不存在" });
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

function buildTodoContent(body, device) {
  const mode = String(body.mode || "same").toLowerCase();
  if (mode === "regex") {
    const source = applyTemplate(String(body.regexSource || body.content || body.text || ""), device);
    const pattern = String(body.regexPattern || "");
    if (!pattern) return source;
    const replaceWith = applyTemplate(String(body.regexReplace || ""), device);
    try {
      return source.replace(new RegExp(pattern, "g"), replaceWith);
    } catch (_) {
      throw new HttpError(400, "正则表达式不合法");
    }
  }
  if (mode === "template") {
    return applyTemplate(String(body.content || body.text || ""), device);
  }
  return String(body.content || body.text || "");
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
      }, "没有可下发设备");
    }

    const done = Boolean(req.body?.done);
    const replace = Boolean(req.body?.replace);
    const priorityRaw = req.body?.priority;
    const priority = priorityRaw === null || priorityRaw === undefined || priorityRaw === "" ? null : Number(priorityRaw);

    const now = new Date().toISOString();
    const success = [];
    const failed = [...target.denied];

    await updateDB((draft) => {
      target.targetIds.forEach((deviceId) => {
        const device = draft.devices.find((item) => item.id === deviceId);
        if (!device) {
          failed.push({ deviceId, reason: "设备不存在" });
          return;
        }
        let content = "";
        try {
          content = String(buildTodoContent(req.body || {}, device) || "").trim();
        } catch (error) {
          failed.push({ deviceId, reason: error?.message || "内容生成失败" });
          return;
        }
        if (!content) {
          failed.push({ deviceId, reason: "内容不能为空" });
          return;
        }

        if (replace) {
          draft.todos = draft.todos.filter((item) => item.deviceId !== deviceId);
        }

        const row = {
          id: createId("todo"),
          deviceId,
          content,
          done,
          priority,
          createdAt: now,
          updatedAt: now,
        };
        draft.todos.push(row);
        success.push({ deviceId, todoId: row.id, content });
      });
    });

    success.forEach((item) => {
      publishDeviceEvent({
        type: "todo.changed",
        deviceId: item.deviceId,
        payload: { action: "batch_dispatch", todoId: item.todoId },
      });
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "todo.batch_dispatch",
      targetType: "device_batch",
      targetId: `count:${target.targetIds.length}`,
      detail: {
        requestedCount: target.requestedCount,
        successCount: success.length,
        failedCount: failed.length,
        mode: String(req.body?.mode || "same"),
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
    }, success.length ? "批量下发成功" : "批量下发失败");
  })
);

router.post(
  "/batch-upsert",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const { deviceId, rows = [], deletedIds = [] } = req.body || {};
    if (!deviceId) throw new HttpError(400, "deviceId不能为空");
    if (!Array.isArray(rows) || !Array.isArray(deletedIds)) {
      throw new HttpError(400, "rows/deletedIds必须是数组");
    }

    const db = await readDB();
    ensureDeviceAccess(db, req.auth, deviceId);
    const now = new Date().toISOString();
    const updatedRows = [];

    await updateDB((draft) => {
      const deleteSet = new Set(deletedIds.map((item) => String(item)));
      draft.todos = draft.todos.filter((item) => !(item.deviceId === deviceId && deleteSet.has(item.id)));

      rows.forEach((row) => {
        const todoId = row?.id ? String(row.id) : "";
        const existing = todoId ? draft.todos.find((item) => item.id === todoId && item.deviceId === deviceId) : null;
        if (existing) {
          existing.content = String(row.content || "");
          existing.done = Boolean(row.done);
          existing.priority = row.priority === null || row.priority === undefined || row.priority === "" ? null : Number(row.priority);
          existing.updatedAt = now;
          updatedRows.push(existing);
        } else if (row.content) {
          const created = {
            id: createId("todo"),
            deviceId,
            content: String(row.content),
            done: Boolean(row.done),
            priority: row.priority === null || row.priority === undefined || row.priority === "" ? null : Number(row.priority),
            createdAt: now,
            updatedAt: now,
          };
          draft.todos.push(created);
          updatedRows.push(created);
        }
      });
    });

    const fresh = (await readDB()).todos.filter((item) => item.deviceId === deviceId);

    publishDeviceEvent({
      type: "todo.changed",
      deviceId,
      payload: { action: "batch_upsert", changed: updatedRows.length, deleted: deletedIds.length },
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "todo.batch_upsert",
      targetType: "device",
      targetId: deviceId,
      detail: { changed: updatedRows.length, deleted: deletedIds.length },
    });

    res.success(fresh, "TODO批量保存成功");
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { deviceId, content, done = false, priority = null } = req.body || {};
    if (!deviceId || !content) throw new HttpError(400, "deviceId和content不能为空");

    const db = await readDB();
    ensureDeviceAccess(db, req.auth, deviceId);

    const now = new Date().toISOString();
    const todo = {
      id: createId("todo"),
      deviceId,
      content: String(content),
      done: Boolean(done),
      priority: priority === null || priority === undefined || priority === "" ? null : Number(priority),
      createdAt: now,
      updatedAt: now,
    };

    await updateDB((draft) => {
      draft.todos.push(todo);
    });

    publishDeviceEvent({
      type: "todo.changed",
      deviceId,
      payload: { action: "create", todo },
    });

    await logOperation({
      actorId: req.auth.userId || req.auth.deviceId,
      actorRole: req.auth.role,
      action: "todo.create",
      targetType: "todo",
      targetId: todo.id,
      detail: { deviceId },
    });

    res.success(todo, "TODO创建成功");
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { deviceId, done, orderBy = "priority", order = "desc" } = req.query || {};
    const db = await readDB();
    const visible = getVisibleDeviceIds(db, req.auth);

    let list = db.todos.filter((item) => visible.has(item.deviceId));
    if (deviceId) list = list.filter((item) => item.deviceId === deviceId);
    if (done !== undefined) {
      const doneValue = String(done) === "true";
      list = list.filter((item) => item.done === doneValue);
    }

    list.sort((a, b) => {
      if (orderBy === "createdAt") {
        return order === "asc" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt);
      }
      const pa = a.priority === null ? -Infinity : a.priority;
      const pb = b.priority === null ? -Infinity : b.priority;
      return order === "asc" ? pa - pb : pb - pa;
    });

    res.success(list, "ok");
  })
);

router.post(
  "/:todoId",
  asyncHandler(async (req, res) => {
    const { todoId } = req.params;
    const payload = req.body || {};
    const db = await readDB();
    const row = db.todos.find((item) => item.id === todoId);
    if (!row) throw new HttpError(404, "TODO不存在");
    ensureDeviceAccess(db, req.auth, row.deviceId);

    let updated = null;
    await updateDB((draft) => {
      const target = draft.todos.find((item) => item.id === todoId);
      if (!target) throw new HttpError(404, "TODO不存在");
      if (payload.content !== undefined) target.content = String(payload.content);
      if (payload.done !== undefined) target.done = Boolean(payload.done);
      if (payload.priority !== undefined) {
        target.priority = payload.priority === null || payload.priority === "" ? null : Number(payload.priority);
      }
      target.updatedAt = new Date().toISOString();
      updated = target;
    });

    publishDeviceEvent({
      type: "todo.changed",
      deviceId: row.deviceId,
      payload: { action: "update", todo: updated },
    });

    await logOperation({
      actorId: req.auth.userId || req.auth.deviceId,
      actorRole: req.auth.role,
      action: "todo.update",
      targetType: "todo",
      targetId: todoId,
    });

    res.success(updated, "TODO已更新");
  })
);

router.post(
  "/:todoId/delete",
  asyncHandler(async (req, res) => {
    const { todoId } = req.params;
    const db = await readDB();
    const row = db.todos.find((item) => item.id === todoId);
    if (!row) throw new HttpError(404, "TODO不存在");
    ensureDeviceAccess(db, req.auth, row.deviceId);

    await updateDB((draft) => {
      draft.todos = draft.todos.filter((item) => item.id !== todoId);
    });

    publishDeviceEvent({
      type: "todo.changed",
      deviceId: row.deviceId,
      payload: { action: "delete", todoId },
    });

    await logOperation({
      actorId: req.auth.userId || req.auth.deviceId,
      actorRole: req.auth.role,
      action: "todo.delete",
      targetType: "todo",
      targetId: todoId,
    });

    res.success({ id: todoId }, "TODO已删除");
  })
);

router.post(
  "/batch-delete",
  asyncHandler(async (req, res) => {
    const { ids = [] } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, "ids不能为空");

    const db = await readDB();
    const visible = getVisibleDeviceIds(db, req.auth);
    const removableRows = db.todos.filter((item) => ids.includes(item.id) && visible.has(item.deviceId));
    const removableIds = removableRows.map((item) => item.id);

    await updateDB((draft) => {
      draft.todos = draft.todos.filter((item) => !removableIds.includes(item.id));
    });

    const grouped = new Map();
    removableRows.forEach((row) => {
      const list = grouped.get(row.deviceId) || [];
      list.push(row.id);
      grouped.set(row.deviceId, list);
    });
    grouped.forEach((todoIds, deviceId) => {
      publishDeviceEvent({
        type: "todo.changed",
        deviceId,
        payload: { action: "batch_delete", todoIds },
      });
    });

    await logOperation({
      actorId: req.auth.userId || req.auth.deviceId,
      actorRole: req.auth.role,
      action: "todo.batch_delete",
      targetType: "todo_batch",
      targetId: `count:${removableIds.length}`,
    });

    res.success({ deletedIds: removableIds }, "批量删除完成");
  })
);

module.exports = router;
