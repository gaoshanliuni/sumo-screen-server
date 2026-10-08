const HttpError = require("./httpError");

function ensureDeviceAccess(db, auth, deviceId) {
  const device = db.devices.find((item) => item.id === deviceId);
  if (!device) {
    throw new HttpError(404, "设备不存在");
  }

  if (auth.role === "admin") {
    return device;
  }

  if (auth.role === "user" && device.ownerId === auth.userId) {
    return device;
  }

  if (auth.role === "device" && auth.deviceId === deviceId) {
    return device;
  }

  throw new HttpError(403, "无权限访问该设备");
}

function getVisibleDeviceIds(db, auth) {
  if (auth.role === "admin") {
    return new Set(db.devices.map((item) => item.id));
  }

  if (auth.role === "user") {
    return new Set(db.devices.filter((item) => item.ownerId === auth.userId).map((item) => item.id));
  }

  if (auth.role === "device") {
    return new Set([auth.deviceId]);
  }

  return new Set();
}

function resolveTargetDeviceIds(db, deviceIds = [], clusterIds = []) {
  const targetSet = new Set(deviceIds || []);
  (clusterIds || []).forEach((clusterId) => {
    const cluster = db.clusters.find((item) => item.id === clusterId);
    if (cluster) {
      (cluster.deviceIds || []).forEach((id) => targetSet.add(id));
    }
  });
  return [...targetSet];
}

module.exports = {
  ensureDeviceAccess,
  getVisibleDeviceIds,
  resolveTargetDeviceIds,
};
