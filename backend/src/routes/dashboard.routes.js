const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { allowRoles } = require("../middleware/auth");
const { readDBView } = require("../db/store");
const { getVisibleDeviceIds } = require("../utils/access");
const { getDevicePresence } = require("../utils/realtime.hub");

const router = express.Router();
router.use(allowRoles("admin", "user"));

function safeRows(value) {
  return Array.isArray(value) ? value : [];
}

function buildDashboardOverview(db, auth, presenceGetter = getDevicePresence) {
  const visibleDeviceIds = getVisibleDeviceIds(db, auth);
  const devices = safeRows(db.devices).filter((item) => visibleDeviceIds.has(item.id));
  const deviceBound = devices.filter((item) => item.bindState === "bound").length;
  const deviceOnline = devices.filter((item) => presenceGetter(item.id).online).length;
  const todos = safeRows(db.todos).filter((item) => visibleDeviceIds.has(item.deviceId));
  const schedules = safeRows(db.schedules).filter((item) => visibleDeviceIds.has(item.deviceId));
  const firmwares = safeRows(db.firmwares);
  const visibleClusters = safeRows(db.clusters).filter((cluster) => {
    if (auth.role === "admin") return true;
    return safeRows(cluster.deviceIds).some((deviceId) => visibleDeviceIds.has(deviceId));
  });

  const firmwareDistribution = {};
  devices.forEach((item) => {
    const version = item.firmwareVersion || "未安装";
    firmwareDistribution[version] = (firmwareDistribution[version] || 0) + 1;
  });

  const apiStats = {};
  if (auth.role === "admin") {
    safeRows(db.apiLogs).forEach((item) => {
      const key = item.templateSlug || "unknown";
      if (!apiStats[key]) apiStats[key] = { total: 0, success: 0, failed: 0 };
      apiStats[key].total += 1;
      if (item.success) apiStats[key].success += 1;
      else apiStats[key].failed += 1;
    });
  }

  const result = {
    role: auth.role,
    deviceTotal: devices.length,
    deviceBound,
    deviceUnbound: devices.length - deviceBound,
    deviceOnline,
    deviceOffline: devices.length - deviceOnline,
    blockedDevices: devices.filter((item) => item.status === "blocked").length,
    todoCount: todos.length,
    scheduleCount: schedules.length,
    firmwareCount: firmwares.length,
    // Legacy fields retained for the original administrator dashboard.
    clusterTotal: visibleClusters.length,
    firmwareTotal: firmwares.length,
    apiStats,
    firmwareDistribution,
  };
  if (auth.role === "admin") {
    result.userTotal = safeRows(db.users).filter((item) => item.role === "user").length;
  }
  result.counts = {
    devices: result.deviceTotal,
    devicesBound: result.deviceBound,
    devicesUnbound: result.deviceUnbound,
    devicesOnline: result.deviceOnline,
    devicesOffline: result.deviceOffline,
    todos: result.todoCount,
    schedules: result.scheduleCount,
    firmwares: result.firmwareCount,
  };
  return result;
}

const overviewHandler = asyncHandler(async (req, res) => {
  const db = await readDBView([
    "devices",
    "todos",
    "schedules",
    "firmwares",
    "clusters",
    "apiLogs",
    "users",
  ]);
  res.success(buildDashboardOverview(db, req.auth), "ok");
});

router.get(["/", "/overview"], overviewHandler);

module.exports = router;
module.exports.buildDashboardOverview = buildDashboardOverview;
