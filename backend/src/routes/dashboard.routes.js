const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { allowRoles } = require("../middleware/auth");
const { readDB } = require("../db/store");

const router = express.Router();
router.use(allowRoles("admin"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = await readDB();

    const boundDevices = db.devices.filter((item) => item.bindState === "bound" || item.ownerId);
    const deviceTotal = boundDevices.length;
    const blockedDevices = boundDevices.filter((item) => item.status === "blocked").length;

    const firmwareDistribution = {};
    boundDevices.forEach((item) => {
      const version = item.firmwareVersion || "未安装";
      firmwareDistribution[version] = (firmwareDistribution[version] || 0) + 1;
    });

    const apiStats = {};
    db.apiLogs.forEach((item) => {
      const key = item.templateSlug || "unknown";
      if (!apiStats[key]) {
        apiStats[key] = {
          total: 0,
          success: 0,
          failed: 0,
        };
      }
      apiStats[key].total += 1;
      if (item.success) apiStats[key].success += 1;
      else apiStats[key].failed += 1;
    });

    res.success(
      {
        deviceTotal,
        blockedDevices,
        userTotal: db.users.filter((item) => item.role === "user").length,
        clusterTotal: db.clusters.length,
        firmwareTotal: db.firmwares.length,
        apiStats,
        firmwareDistribution,
      },
      "ok"
    );
  })
);

module.exports = router;
