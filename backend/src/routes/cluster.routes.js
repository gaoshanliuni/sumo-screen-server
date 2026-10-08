const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { getVisibleDeviceIds } = require("../utils/access");
const { logOperation } = require("../utils/logging");

const router = express.Router();

router.use(allowRoles("admin", "user"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    if (req.auth.role === "admin") {
      return res.success(db.clusters, "ok");
    }
    const visible = getVisibleDeviceIds(db, req.auth);
    const rows = (db.clusters || [])
      .map((cluster) => ({
        ...cluster,
        deviceIds: (cluster.deviceIds || []).filter((id) => visible.has(id)),
      }))
      .filter((cluster) => (cluster.deviceIds || []).length > 0);
    res.success(rows, "ok");
  })
);

router.post(
  "/",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { name, description = "", rule = "", deviceIds = [] } = req.body || {};
    if (!name) {
      throw new HttpError(400, "集群名称不能为空");
    }

    const db = await readDB();
    const duplicate = db.clusters.find((item) => item.name === name);
    if (duplicate) {
      throw new HttpError(409, "集群名称已存在");
    }

    const validDeviceIds = (deviceIds || []).filter((id) => db.devices.some((d) => d.id === id));
    const now = new Date().toISOString();
    const cluster = {
      id: createId("cluster"),
      name,
      description,
      rule,
      deviceIds: [...new Set(validDeviceIds)],
      createdAt: now,
      updatedAt: now,
    };

    await updateDB((draft) => {
      draft.clusters.push(cluster);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "cluster.create",
      targetType: "cluster",
      targetId: cluster.id,
      detail: { name: cluster.name },
    });

    res.success(cluster, "集群创建成功");
  })
);

router.post(
  "/:clusterId",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { clusterId } = req.params;
    const payload = req.body || {};
    let updated = null;

    await updateDB((draft) => {
      const cluster = draft.clusters.find((item) => item.id === clusterId);
      if (!cluster) {
        throw new HttpError(404, "集群不存在");
      }

      if (payload.name !== undefined) cluster.name = String(payload.name);
      if (payload.description !== undefined) cluster.description = String(payload.description);
      if (payload.rule !== undefined) cluster.rule = String(payload.rule);
      if (payload.deviceIds && Array.isArray(payload.deviceIds)) {
        const validIds = payload.deviceIds.filter((id) => draft.devices.some((d) => d.id === id));
        cluster.deviceIds = [...new Set(validIds)];
      }
      cluster.updatedAt = new Date().toISOString();
      updated = cluster;
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "cluster.update",
      targetType: "cluster",
      targetId: clusterId,
      detail: payload,
    });

    res.success(updated, "集群已更新");
  })
);

router.post(
  "/:clusterId/devices",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { clusterId } = req.params;
    const { deviceIds = [], mode = "append" } = req.body || {};
    if (!Array.isArray(deviceIds)) {
      throw new HttpError(400, "deviceIds必须是数组");
    }
    if (!["append", "remove", "replace"].includes(mode)) {
      throw new HttpError(400, "mode仅支持 append/remove/replace");
    }

    let updated = null;
    await updateDB((draft) => {
      const cluster = draft.clusters.find((item) => item.id === clusterId);
      if (!cluster) throw new HttpError(404, "集群不存在");

      const validIds = deviceIds.filter((id) => draft.devices.some((d) => d.id === id));
      const set = new Set(cluster.deviceIds || []);

      if (mode === "replace") {
        cluster.deviceIds = [...new Set(validIds)];
      } else if (mode === "append") {
        validIds.forEach((id) => set.add(id));
        cluster.deviceIds = [...set];
      } else {
        validIds.forEach((id) => set.delete(id));
        cluster.deviceIds = [...set];
      }
      cluster.updatedAt = new Date().toISOString();
      updated = cluster;
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "cluster.manage_devices",
      targetType: "cluster",
      targetId: clusterId,
      detail: { mode, count: deviceIds.length },
    });

    res.success(updated, "集群设备列表已更新");
  })
);

router.post(
  "/:clusterId/delete",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { clusterId } = req.params;
    let removed = null;

    await updateDB((draft) => {
      const index = draft.clusters.findIndex((item) => item.id === clusterId);
      if (index < 0) throw new HttpError(404, "集群不存在");
      removed = draft.clusters[index];
      draft.clusters.splice(index, 1);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "cluster.delete",
      targetType: "cluster",
      targetId: clusterId,
      detail: { name: removed?.name || "" },
    });

    res.success({ id: clusterId }, "集群已删除");
  })
);

module.exports = router;
