const express = require("express");

const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { logOperation } = require("../utils/logging");
const {
  ACTION_TYPES,
  normalizeTaskPlan,
  computeNextRunAt,
  runTaskPlan,
} = require("../services/task_plan.service");

const router = express.Router();
router.use(allowRoles("admin", "user"));

function canEditPlan(auth, plan) {
  if (auth.role === "admin") return true;
  return String(plan.ownerId || "") === String(auth.userId || "");
}

function visiblePlans(db, auth) {
  const rows = Array.isArray(db.taskPlans) ? db.taskPlans : [];
  if (auth.role === "admin") return rows;
  return rows.filter((item) => String(item.ownerId || "") === String(auth.userId || ""));
}

router.get(
  "/actions",
  asyncHandler(async (_req, res) => {
    res.success(
      [...ACTION_TYPES].map((type) => ({
        type,
        label: {
          "device.variable.upsert": "修改基础变量",
          "api_template.refresh": "刷新 API 模板",
          "remote.update_backend_url": "下发后端地址",
          "remote.switch_view": "切换设备界面",
        }[type] || type,
      })),
      "ok"
    );
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(visiblePlans(db, req.auth).map((item) => normalizeTaskPlan(item)), "ok");
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const now = new Date().toISOString();
    const plan = normalizeTaskPlan(
      {
        ...(req.body || {}),
        ownerId: req.auth.userId,
        createdBy: req.auth.userId,
      },
      now
    );
    plan.ownerId = req.auth.userId;
    plan.createdBy = req.auth.userId;
    plan.nextRunAt = computeNextRunAt(plan, new Date(now));

    await updateDB((draft) => {
      draft.taskPlans = Array.isArray(draft.taskPlans) ? draft.taskPlans : [];
      draft.taskPlans.unshift(plan);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "task_plan.create",
      targetType: "task_plan",
      targetId: plan.id,
      detail: { name: plan.name },
    });

    res.success(plan, "计划任务已创建");
  })
);

router.post(
  "/:planId",
  asyncHandler(async (req, res) => {
    const now = new Date().toISOString();
    let updated = null;
    await updateDB((draft) => {
      draft.taskPlans = Array.isArray(draft.taskPlans) ? draft.taskPlans : [];
      const index = draft.taskPlans.findIndex((item) => String(item.id || "") === String(req.params.planId || ""));
      if (index < 0) throw new HttpError(404, "计划任务不存在");
      const existing = draft.taskPlans[index];
      if (!canEditPlan(req.auth, existing)) throw new HttpError(403, "无权限修改该计划任务");
      updated = normalizeTaskPlan(
        {
          ...existing,
          ...(req.body || {}),
          id: existing.id,
          ownerId: existing.ownerId || req.auth.userId,
          createdAt: existing.createdAt,
          updatedAt: now,
        },
        now
      );
      updated.ownerId = existing.ownerId || req.auth.userId;
      updated.createdBy = existing.createdBy || req.auth.userId;
      updated.nextRunAt = computeNextRunAt(updated, new Date(now));
      draft.taskPlans[index] = updated;
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "task_plan.update",
      targetType: "task_plan",
      targetId: updated.id,
      detail: { name: updated.name },
    });

    res.success(updated, "计划任务已更新");
  })
);

router.post(
  "/:planId/delete",
  asyncHandler(async (req, res) => {
    let deleted = null;
    await updateDB((draft) => {
      draft.taskPlans = Array.isArray(draft.taskPlans) ? draft.taskPlans : [];
      const index = draft.taskPlans.findIndex((item) => String(item.id || "") === String(req.params.planId || ""));
      if (index < 0) throw new HttpError(404, "计划任务不存在");
      const existing = draft.taskPlans[index];
      if (!canEditPlan(req.auth, existing)) throw new HttpError(403, "无权限删除该计划任务");
      deleted = draft.taskPlans.splice(index, 1)[0];
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "task_plan.delete",
      targetType: "task_plan",
      targetId: deleted.id,
      detail: { name: deleted.name },
    });

    res.success({ id: deleted.id }, "计划任务已删除");
  })
);

router.post(
  "/:planId/run",
  asyncHandler(async (req, res) => {
    const run = await runTaskPlan({
      auth: req.auth,
      planId: req.params.planId,
      triggerType: "manual",
      now: new Date().toISOString(),
    });
    res.success(run, "计划任务已执行");
  })
);

router.get(
  "/:planId/runs",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const plan = (db.taskPlans || []).find((item) => String(item.id || "") === String(req.params.planId || ""));
    if (!plan) throw new HttpError(404, "计划任务不存在");
    if (!canEditPlan(req.auth, plan)) throw new HttpError(403, "无权限查看该计划任务");
    const rows = (db.taskRuns || []).filter((item) => String(item.planId || "") === String(plan.id || ""));
    res.success(rows.slice(0, 100), "ok");
  })
);

module.exports = router;
