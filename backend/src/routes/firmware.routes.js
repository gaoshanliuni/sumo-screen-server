const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess, resolveTargetDeviceIds, getVisibleDeviceIds } = require("../utils/access");
const { logOperation } = require("../utils/logging");
const { publishDeviceEvent } = require("../utils/realtime.hub");
const { getGridBucket, ObjectId } = require("../utils/mongo");
const { validateFullFirmwareZip } = require("../services/firmware/full_firmware_bundle.service");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 120 * 1024 * 1024 },
});

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function toObjectId(value) {
  if (!value) return null;
  try {
    return new ObjectId(String(value));
  } catch (_) {
    return null;
  }
}

async function getFirmwareBucket() {
  return await getGridBucket("firmware_files");
}

async function getFullFirmwareBucket() {
  return await getGridBucket("firmware_full_bundles");
}

function createJob({ deviceId, firmwareId, force = false, scheduledAt = "" }, actor) {
  const now = new Date().toISOString();
  const future = scheduledAt && new Date(scheduledAt).getTime() > Date.now();
  return {
    id: createId("upg"),
    deviceId,
    firmwareId,
    force: Boolean(force),
    scheduledAt: scheduledAt || "",
    status: future ? "scheduled" : "pending",
    progress: 0,
    result: future ? "等待调度" : "等待设备执行",
    createdBy: {
      role: actor.role,
      id: actor.userId || actor.deviceId || "",
    },
    createdAt: now,
    finishedAt: "",
  };
}

function buildUpgradeEventPayload({ action, job, firmware }) {
  return {
    action,
    jobId: job.id,
    status: job.status,
    progress: Number(job.progress || 0),
    firmwareId: firmware.id,
    version: firmware.version,
    firmwareVersion: firmware.version,
    downloadUrl: `/api/firmware/${firmware.id}/download`,
    sha256: firmware.sha256 || "",
    size: Number(firmware.fileSize || 0),
    force: Boolean(job.force),
    scheduledAt: job.scheduledAt || "",
  };
}

router.get(
  "/",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(db.firmwares, "ok");
  })
);

router.post(
  "/",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { version, releaseNote = "", deviceType = "ink-screen", fileName = "", fileUrl = "", sha256 = "" } = req.body || {};
    if (!version) throw new HttpError(400, "version不能为空");

    const db = await readDB();
    if (db.firmwares.some((item) => item.version === version)) {
      throw new HttpError(409, "固件版本已存在");
    }

    const now = new Date().toISOString();
    const firmware = {
      id: createId("fw"),
      version,
      releaseNote,
      deviceType,
      fileName,
      fileUrl,
      gridId: "",
      fileSize: 0,
      mime: "",
      sha256: String(sha256 || ""),
      createdAt: now,
      updatedAt: now,
    };

    await updateDB((draft) => {
      draft.firmwares.push(firmware);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "firmware.create",
      targetType: "firmware",
      targetId: firmware.id,
      detail: { version, deviceType },
    });

    res.success(firmware, "固件创建成功");
  })
);

router.post(
  "/upload",
  allowRoles("admin"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const { version, releaseNote = "", deviceType = "ink-screen" } = req.body || {};
    if (!version) throw new HttpError(400, "version不能为空");
    if (!req.file) throw new HttpError(400, "请先选择文件");

    const db = await readDB();
    if (db.firmwares.some((item) => item.version === version)) {
      throw new HttpError(409, "固件版本已存在");
    }

    const now = new Date().toISOString();
    const firmwareId = createId("fw");
    const safeName = req.file.originalname || `${firmwareId}.bin`;
    const filename = `${firmwareId}_${safeName}`;
    const hash = sha256Hex(req.file.buffer);
    const bucket = await getFirmwareBucket();
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: req.file.mimetype,
      metadata: {
        firmwareId,
        version,
        deviceType,
        originalName: safeName,
        sha256: hash,
      },
    });

    const gridId = await new Promise((resolve, reject) => {
      uploadStream.on("error", reject);
      uploadStream.on("finish", () => resolve(uploadStream.id));
      uploadStream.end(req.file.buffer);
    });

    const firmware = {
      id: firmwareId,
      version,
      releaseNote,
      deviceType,
      fileName: safeName,
      fileUrl: `/api/firmware/${firmwareId}/download`,
      gridId: String(gridId),
      fileSize: req.file.size,
      mime: req.file.mimetype,
      sha256: hash,
      createdAt: now,
      updatedAt: now,
    };

    await updateDB((draft) => {
      draft.firmwares.push(firmware);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "firmware.upload",
      targetType: "firmware",
      targetId: firmware.id,
      detail: { version, deviceType, fileName: safeName },
    });

    res.success(firmware, "固件上传成功");
  })
);

router.get(
  "/full-bundles",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(db.fullFirmwareBundles || [], "ok");
  })
);

router.post(
  "/full/upload",
  allowRoles("admin"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "请先选择完整固件ZIP包");
    const validation = validateFullFirmwareZip(req.file.buffer);
    const manifest = validation.manifest;
    const now = new Date().toISOString();
    const bundleId = createId("fwfull");
    const safeName = req.file.originalname || `${bundleId}.zip`;
    const hash = sha256Hex(req.file.buffer);

    const bucket = await getFullFirmwareBucket();
    const uploadStream = bucket.openUploadStream(`${bundleId}_${safeName}`, {
      contentType: req.file.mimetype || "application/zip",
      metadata: {
        bundleId,
        version: manifest.version,
        deviceType: manifest.deviceType,
        chip: manifest.chip,
        flashSize: manifest.flashSize,
        sha256: hash,
      },
    });
    const gridId = await new Promise((resolve, reject) => {
      uploadStream.on("error", reject);
      uploadStream.on("finish", () => resolve(uploadStream.id));
      uploadStream.end(req.file.buffer);
    });

    const bundle = {
      id: bundleId,
      version: String(req.body?.version || manifest.version || ""),
      releaseNote: String(req.body?.releaseNote || manifest.notes || ""),
      deviceType: String(req.body?.deviceType || manifest.deviceType || "ink-screen"),
      packageType: manifest.packageType,
      chip: manifest.chip,
      flashSize: manifest.flashSize,
      flashSizeBytes: manifest.flashSizeBytes,
      fileName: safeName,
      fileUrl: `/api/firmware/full/${bundleId}/download`,
      manifestUrl: `/api/firmware/full/${bundleId}/manifest`,
      gridId: String(gridId),
      fileSize: req.file.size,
      mime: req.file.mimetype || "application/zip",
      sha256: hash,
      manifest,
      files: validation.files,
      createdAt: now,
      updatedAt: now,
    };

    await updateDB((draft) => {
      draft.fullFirmwareBundles = Array.isArray(draft.fullFirmwareBundles) ? draft.fullFirmwareBundles : [];
      draft.fullFirmwareBundles.unshift(bundle);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "firmware.full_upload",
      targetType: "firmware_full_bundle",
      targetId: bundle.id,
      detail: { version: bundle.version, deviceType: bundle.deviceType, chip: bundle.chip, flashSize: bundle.flashSize },
    });

    res.success(bundle, "完整固件包上传成功", 201);
  })
);

router.get(
  "/full/:bundleId/manifest",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const bundle = (db.fullFirmwareBundles || []).find((item) => item.id === req.params.bundleId);
    if (!bundle) throw new HttpError(404, "完整固件包不存在");
    res.success(bundle.manifest || {}, "ok");
  })
);

router.get(
  "/full/:bundleId/download",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const bundle = (db.fullFirmwareBundles || []).find((item) => item.id === req.params.bundleId);
    if (!bundle) throw new HttpError(404, "完整固件包不存在");
    if (!bundle.gridId) throw new HttpError(404, "完整固件文件不存在");
    const objectId = toObjectId(bundle.gridId);
    if (!objectId) throw new HttpError(404, "完整固件文件不存在");
    const safeName = encodeURIComponent(bundle.fileName || `${bundle.id}.zip`);
    res.setHeader("Content-Type", bundle.mime || "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=\"${safeName}\"`);
    res.setHeader("Content-Length", String(bundle.fileSize || 0));
    const bucket = await getFullFirmwareBucket();
    const downloadStream = bucket.openDownloadStream(objectId);
    downloadStream.on("error", () => {
      if (!res.headersSent) res.status(404).end();
      else res.end();
    });
    downloadStream.pipe(res);
  })
);

router.get(
  "/upgrades",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const { deviceId, status } = req.query || {};
    const db = await readDB();
    const visible = getVisibleDeviceIds(db, req.auth);

    let jobs = db.upgradeJobs.filter((item) => visible.has(item.deviceId));
    if (deviceId) jobs = jobs.filter((item) => item.deviceId === deviceId);
    if (status) jobs = jobs.filter((item) => item.status === status);
    res.success(jobs, "ok");
  })
);

router.get(
  "/:firmwareId/download",
  allowRoles("admin", "user", "device"),
  asyncHandler(async (req, res) => {
    const { firmwareId } = req.params;
    const db = await readDB();
    const firmware = db.firmwares.find((item) => item.id === firmwareId);
    if (!firmware) throw new HttpError(404, "固件不存在");
    if (!firmware.gridId) throw new HttpError(404, "固件文件不存在");

    const bucket = await getFirmwareBucket();
    const objectId = toObjectId(firmware.gridId);
    if (!objectId) throw new HttpError(404, "固件文件不存在");

    const safeName = encodeURIComponent(firmware.fileName || firmware.id);
    res.setHeader("Content-Type", firmware.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename=\"${safeName}\"`);

    const downloadStream = bucket.openDownloadStream(objectId);
    downloadStream.on("error", () => {
      if (!res.headersSent) res.status(404).end();
      else res.end();
    });
    downloadStream.pipe(res);
  })
);

router.post(
  "/upgrade",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const { deviceId, firmwareId, force = false, scheduledAt = "" } = req.body || {};
    if (!deviceId || !firmwareId) throw new HttpError(400, "deviceId和firmwareId不能为空");

    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, deviceId);
    const firmware = db.firmwares.find((item) => item.id === firmwareId);
    if (!firmware) throw new HttpError(404, "固件不存在");
    if (firmware.deviceType && device.type && firmware.deviceType !== device.type) {
      throw new HttpError(400, "固件与设备类型不兼容");
    }

    const job = createJob({ deviceId, firmwareId, force, scheduledAt }, req.auth);
    await updateDB((draft) => {
      draft.upgradeJobs.unshift(job);
    });

    publishDeviceEvent({
      type: "firmware.changed",
      deviceId,
      payload: buildUpgradeEventPayload({ action: "upgrade_create", job, firmware }),
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "firmware.manual_upgrade",
      targetType: "device",
      targetId: deviceId,
      detail: { firmwareId, force, scheduledAt },
    });

    res.success(job, "升级任务已创建");
  })
);

router.post(
  "/batch-upgrade",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { deviceIds = [], clusterIds = [], firmwareId = "", force = false, scheduledAt = "" } = req.body || {};

    const db = await readDB();
    const latest = [...db.firmwares].sort((a, b) => {
      const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return tb - ta;
    })[0];
    if (!latest) throw new HttpError(404, "暂无可用固件");
    if (firmwareId && firmwareId !== latest.id) {
      throw new HttpError(400, "已禁用指定固件版本升级，请使用最新版本");
    }
    const firmware = latest;

    const targets = resolveTargetDeviceIds(db, deviceIds, clusterIds);
    if (targets.length === 0) throw new HttpError(400, "未找到目标设备");

    const result = { success: [], failed: [] };
    const jobs = [];

    targets.forEach((id) => {
      const device = db.devices.find((item) => item.id === id);
      if (!device) {
        result.failed.push({ deviceId: id, reason: "设备不存在" });
        return;
      }
      if (firmware.deviceType && device.type && firmware.deviceType !== device.type) {
        result.failed.push({ deviceId: id, reason: "固件不兼容" });
        return;
      }
      const job = createJob({ deviceId: id, firmwareId: firmware.id, force, scheduledAt }, req.auth);
      jobs.push(job);
      result.success.push({ deviceId: id, jobId: job.id, status: job.status });
    });

    await updateDB((draft) => {
      jobs.forEach((job) => draft.upgradeJobs.unshift(job));
    });

    jobs.forEach((job) => {
      publishDeviceEvent({
        type: "firmware.changed",
        deviceId: job.deviceId,
        payload: buildUpgradeEventPayload({ action: "batch_upgrade_create", job, firmware }),
      });
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "firmware.batch_upgrade",
      targetType: "device_batch",
      targetId: `count:${result.success.length}`,
      detail: {
        firmwareId: firmware.id,
        requestedFirmwareId: firmwareId || "",
        clusterIds,
        deviceIds,
        scheduledAt,
      },
    });

    res.success(result, "批量升级任务已创建");
  })
);

router.post(
  "/upgrades/:jobId/run",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { jobId } = req.params;
    const db = await readDB();
    const existing = db.upgradeJobs.find((item) => item.id === jobId);
    if (!existing) throw new HttpError(404, "升级任务不存在");
    if (existing.status === "success") throw new HttpError(400, "任务已完成");

    const firmware = db.firmwares.find((item) => item.id === existing.firmwareId);
    if (!firmware) throw new HttpError(404, "固件不存在");

    let updated = null;
    await updateDB((draft) => {
      const job = draft.upgradeJobs.find((item) => item.id === jobId);
      if (!job) throw new HttpError(404, "升级任务不存在");
      job.status = "pending";
      job.progress = 0;
      job.result = "调度触发，等待设备执行";
      job.finishedAt = "";
      updated = job;
    });

    publishDeviceEvent({
      type: "firmware.changed",
      deviceId: updated.deviceId,
      payload: buildUpgradeEventPayload({ action: "upgrade_run", job: updated, firmware }),
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "firmware.run_scheduled_upgrade",
      targetType: "upgrade_job",
      targetId: jobId,
    });

    res.success(updated, "升级任务已触发");
  })
);

router.post(
  "/:firmwareId/delete",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { firmwareId } = req.params;
    let removedGridId = "";
    let removedFileName = "";
    let removedVersion = "";
    await updateDB((draft) => {
      const index = draft.firmwares.findIndex((item) => item.id === firmwareId);
      if (index < 0) throw new HttpError(404, "固件不存在");
      const removed = draft.firmwares[index];
      removedGridId = removed?.gridId || "";
      removedFileName = removed?.fileName || "";
      removedVersion = removed?.version || "";
      draft.firmwares.splice(index, 1);
    });

    if (removedGridId) {
      const objectId = toObjectId(removedGridId);
      if (objectId) {
        try {
          const bucket = await getFirmwareBucket();
          await bucket.delete(objectId);
        } catch (_) {
          // ignore delete errors
        }
      }
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "firmware.delete",
      targetType: "firmware",
      targetId: firmwareId,
      detail: { version: removedVersion, fileName: removedFileName },
    });

    res.success({ id: firmwareId }, "固件已删除");
  })
);

module.exports = router;
