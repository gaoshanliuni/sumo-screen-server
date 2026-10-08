const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { allowRoles } = require("../middleware/auth");
const { getTaskService } = require("../tasks/queue");

const router = express.Router();
router.use(allowRoles("admin", "user"));

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const type = String(body.type || "").trim();
    if (!type) throw new HttpError(400, "type不能为空");
    const task = await getTaskService().enqueue(type, body.payload || {}, async ({ payload, updateProgress }) => {
      await updateProgress(50, "accepted");
      return { accepted: true, payload };
    });
    res.success(task, "任务已创建");
  })
);

router.get(
  "/:taskId",
  asyncHandler(async (req, res) => {
    const task = await getTaskService().get(req.params.taskId);
    if (!task) throw new HttpError(404, "任务不存在");
    res.success(task, "ok");
  })
);

router.post(
  "/:taskId/cancel",
  asyncHandler(async (req, res) => {
    const task = await getTaskService().cancel(req.params.taskId, "user_cancelled");
    if (!task) throw new HttpError(404, "任务不存在");
    res.success(task, "任务已取消");
  })
);

module.exports = router;
