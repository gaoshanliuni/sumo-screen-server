const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { allowRoles } = require("../middleware/auth");
const { readDB } = require("../db/store");

const router = express.Router();
router.use(allowRoles("admin"));

router.get(
  "/operations",
  asyncHandler(async (req, res) => {
    const { action, targetType, status, actorId, keyword, limit = 200 } = req.query || {};
    const db = await readDB();
    let list = db.operationLogs;

    if (action) list = list.filter((item) => item.action === action);
    if (targetType) list = list.filter((item) => item.targetType === targetType);
    if (status) list = list.filter((item) => item.status === status);
    if (actorId) list = list.filter((item) => item.actorId === actorId);
    if (keyword) {
      const text = String(keyword).toLowerCase();
      list = list.filter(
        (item) =>
          item.action.toLowerCase().includes(text) ||
          item.targetId.toLowerCase().includes(text) ||
          JSON.stringify(item.detail || {}).toLowerCase().includes(text)
      );
    }

    list = list.slice(0, Number(limit));
    res.success(list, "ok");
  })
);

router.get(
  "/apis",
  asyncHandler(async (req, res) => {
    const { templateSlug, success, deviceId, limit = 300 } = req.query || {};
    const db = await readDB();
    let list = db.apiLogs;

    if (templateSlug) list = list.filter((item) => item.templateSlug === templateSlug);
    if (deviceId) list = list.filter((item) => item.deviceId === deviceId);
    if (success !== undefined) {
      const expectSuccess = String(success) === "true";
      list = list.filter((item) => item.success === expectSuccess);
    }

    list = list.slice(0, Number(limit));
    res.success(list, "ok");
  })
);

module.exports = router;
