const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { logOperation } = require("../utils/logging");
const { ensureDeviceAccess, resolveTargetDeviceIds } = require("../utils/access");
const { getGridBucket, ObjectId } = require("../utils/mongo");
const { publishDeviceEvent } = require("../utils/realtime.hub");
const { previewE6Buffer } = require("../services/e6/e6_converter.service");

const router = express.Router();
router.use(allowRoles("admin", "user"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});

const CATEGORY_SET = new Set(["fonts", "read", "photo", "update", "background", "config"]);
const CATEGORY_ALIASES = {
  font: "fonts",
  ebook: "read",
  firmware: "update",
  wallpaper: "background",
  custom: "photo",
};

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeCategory(value) {
  const raw = String(value || "read");
  return CATEGORY_ALIASES[raw] || raw;
}

function normalizeNameVariants(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return [];
  const normalized = raw.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const base = parts[parts.length - 1] || normalized;
  const list = [normalized];
  if (base !== normalized) list.push(base);
  return list;
}

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
        // ignore
      }
    }
    return [...new Set(value.split(",").map((item) => String(item || "").trim()).filter(Boolean))];
  }
  return [];
}

function ensureOwner(db, ownerId) {
  return db.users.some((item) => item.id === ownerId && item.status !== "blocked");
}

function toObjectId(value) {
  if (!value) return null;
  try {
    return new ObjectId(String(value));
  } catch (_) {
    return null;
  }
}

async function getBucket() {
  try {
    return await getGridBucket("tf_files");
  } catch (error) {
    throw new HttpError(500, error.message || "MongoDB 未配置");
  }
}

async function streamTfFile(file, res) {
  const bucket = await getBucket();
  const objectId = toObjectId(file.gridId);
  if (!objectId) throw new HttpError(404, "文件数据不存在");

  const safeName = encodeURIComponent(file.originalName || file.name || file.id);
  res.setHeader("Content-Type", file.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename=\"${safeName}\"`);
  if (file.sha256) {
    res.setHeader("X-File-Sha256", file.sha256);
  }

  const downloadStream = bucket.openDownloadStream(objectId);
  downloadStream.on("error", () => {
    if (!res.headersSent) res.status(404).end();
    else res.end();
  });
  downloadStream.pipe(res);
}

async function readTfFileBuffer(file) {
  const bucket = await getBucket();
  const objectId = toObjectId(file.gridId);
  if (!objectId) throw new HttpError(404, "文件数据不存在");
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = bucket.openDownloadStream(objectId);
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function respondDeviceFiles(req, res, deviceId) {
  const db = await readDB();
  ensureDeviceAccess(db, req.auth, deviceId);
  const record = db.tfDeviceFiles.find((item) => item.deviceId === deviceId);
  res.success(
    {
      deviceId,
      reportedAt: record?.reportedAt || "",
      files: record?.files || [],
    },
    "ok"
  );
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { category, ownerId, deviceId } = req.query || {};
    const db = await readDB();
    let localFileSet = null;
    if (deviceId) {
      ensureDeviceAccess(db, req.auth, String(deviceId));
      const localRecord = db.tfDeviceFiles.find((item) => item.deviceId === String(deviceId));
      if (localRecord) {
        localFileSet = new Set();
        (localRecord.files || []).forEach((item) => {
          const itemCategory = String(item.category || "").toLowerCase();
          normalizeNameVariants(item.name || "").forEach((variant) => {
            localFileSet.add(`${itemCategory}|${variant}`);
          });
        });
      } else {
        localFileSet = new Set();
      }
    }
    let list = db.tfFiles;

    if (req.auth.role === "user") {
      list = list.filter((item) => item.ownerId === req.auth.userId);
    } else if (ownerId) {
      list = list.filter((item) => item.ownerId === ownerId);
    }

    if (category) list = list.filter((item) => item.category === category);
    const normalized = list.map((item) => {
      const itemCategory = String(item.category || "").toLowerCase();
      const nameVariants = [
        ...normalizeNameVariants(item.originalName || ""),
        ...normalizeNameVariants(item.name || ""),
      ];
      const deliverStatus = localFileSet
        ? nameVariants.some((variant) => localFileSet.has(`${itemCategory}|${variant}`))
          ? "delivered"
          : "pending"
        : "";
      return {
        ...item,
        url: `/api/tf/${item.id}/download`,
        deliverStatus,
      };
    });
    res.success(normalized, "ok");
  })
);

router.get(
  "/device",
  asyncHandler(async (req, res) => {
    const deviceId = String(req.query?.deviceId || "");
    if (!deviceId) throw new HttpError(400, "deviceId不能为空");
    await respondDeviceFiles(req, res, deviceId);
  })
);

router.get(
  "/device/:deviceId",
  asyncHandler(async (req, res) => {
    const { deviceId } = req.params;
    await respondDeviceFiles(req, res, deviceId);
  })
);

router.post(
  "/device/:deviceId/delete",
  asyncHandler(async (req, res) => {
    const { deviceId } = req.params;
    const name = String(req.body?.name || "").trim();
    const category = String(req.body?.category || "").trim();
    if (!name) throw new HttpError(400, "name不能为空");

    const db = await readDB();
    ensureDeviceAccess(db, req.auth, deviceId);

    let removed = 0;
    await updateDB((draft) => {
      const record = draft.tfDeviceFiles.find((item) => item.deviceId === deviceId);
      if (!record) throw new HttpError(404, "本地文件不存在");
      const before = record.files.length;
      const targetName = name.toLowerCase();
      record.files = record.files.filter((item) => {
        const sameName = String(item.name || "").toLowerCase() === targetName;
        const sameCategory = category ? item.category === category : true;
        return !(sameName && sameCategory);
      });
      removed = before - record.files.length;
      record.updatedAt = new Date().toISOString();
      if (removed === 0) throw new HttpError(404, "本地文件不存在");
    });

    publishDeviceEvent({
      type: "tf.remote_delete",
      deviceId,
      payload: { name, category, removed },
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "tf.remote_delete",
      targetType: "device",
      targetId: deviceId,
      detail: { name, category, removed },
    });

    res.success({ removed }, "远程删除完成");
  })
);

router.get(
  "/device/:deviceId/download",
  asyncHandler(async (req, res) => {
    const { deviceId } = req.params;
    const name = String(req.query?.name || "").trim();
    const category = String(req.query?.category || "").trim();
    if (!name) throw new HttpError(400, "name不能为空");

    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, deviceId);
    const targetName = name.toLowerCase();

    let list = db.tfFiles;
    if (req.auth.role === "user") {
      list = list.filter((item) => item.ownerId === req.auth.userId);
    } else if (device.ownerId) {
      list = list.filter((item) => item.ownerId === device.ownerId);
    }
    if (category) list = list.filter((item) => item.category === category);

    const file = list.find((item) => {
      const original = String(item.originalName || "").toLowerCase();
      const stored = String(item.name || "").toLowerCase();
      return original === targetName || stored === targetName;
    });
    if (!file) throw new HttpError(404, "云端未找到同名文件");

    await streamTfFile(file, res);
  })
);

router.post(
  "/upload",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const category = normalizeCategory(req.body?.category || "read");
    if (!CATEGORY_SET.has(category)) {
      throw new HttpError(400, "category不合法");
    }

    const db = await readDB();
    let ownerId = req.auth.userId;
    if (req.auth.role === "admin" && req.body?.ownerId) {
      ownerId = String(req.body.ownerId);
    }
    if (!ensureOwner(db, ownerId)) {
      throw new HttpError(400, "ownerId不存在或已封禁");
    }

    if (!req.file) throw new HttpError(400, "请先选择文件");

    const bucket = await getBucket();
    const now = new Date().toISOString();
    const recordId = createId("tf");
    const filename = `${recordId}_${req.file.originalname || "file"}`;
    const hash = sha256Hex(req.file.buffer);
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: req.file.mimetype,
      metadata: {
        ownerId,
        category,
        originalName: req.file.originalname || filename,
        sha256: hash,
      },
    });

    const gridId = await new Promise((resolve, reject) => {
      uploadStream.on("error", reject);
      uploadStream.on("finish", () => resolve(uploadStream.id));
      uploadStream.end(req.file.buffer);
    });

    const record = {
      id: recordId,
      ownerId,
      category,
      name: filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype,
      gridId: String(gridId),
      url: `/api/tf/${recordId}/download`,
      sha256: hash,
      createdAt: now,
      updatedAt: now,
    };

    await updateDB((draft) => {
      draft.tfFiles.unshift(record);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "tf.upload",
      targetType: "tf_file",
      targetId: record.id,
      detail: { category: record.category, ownerId: record.ownerId },
    });

    res.success(record, "文件已上传");
  })
);

router.get(
  "/:fileId/e6-preview",
  asyncHandler(async (req, res) => {
    const { fileId } = req.params;
    const db = await readDB();
    const file = db.tfFiles.find((item) => item.id === fileId);
    if (!file) throw new HttpError(404, "文件不存在");
    if (req.auth.role === "user" && file.ownerId !== req.auth.userId) {
      throw new HttpError(403, "无权限预览该文件");
    }
    const buffer = await readTfFileBuffer(file);
    const png = await previewE6Buffer(buffer);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.end(png);
  })
);

router.get(
  "/:fileId/download",
  asyncHandler(async (req, res) => {
    const { fileId } = req.params;
    const db = await readDB();
    const file = db.tfFiles.find((item) => item.id === fileId);
    if (!file) throw new HttpError(404, "文件不存在");
    if (req.auth.role === "user" && file.ownerId !== req.auth.userId) {
      throw new HttpError(403, "无权限下载该文件");
    }
    await streamTfFile(file, res);
  })
);

router.post(
  "/:fileId/delete",
  asyncHandler(async (req, res) => {
    const { fileId } = req.params;
    const db = await readDB();
    const file = db.tfFiles.find((item) => item.id === fileId);
    if (!file) throw new HttpError(404, "文件不存在");
    if (req.auth.role === "user" && file.ownerId !== req.auth.userId) {
      throw new HttpError(403, "无权限删除该文件");
    }

    await updateDB((draft) => {
      draft.tfFiles = draft.tfFiles.filter((item) => item.id !== fileId);
    });

    const objectId = toObjectId(file.gridId);
    if (objectId) {
      const bucket = await getBucket();
      try {
        await bucket.delete(objectId);
      } catch (_) {
        // ignore missing data
      }
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "tf.delete",
      targetType: "tf_file",
      targetId: fileId,
      detail: { ownerId: file.ownerId, category: file.category },
    });

    res.success({ id: fileId }, "文件已删除");
  })
);

router.post(
  "/dispatch",
  asyncHandler(async (req, res) => {
    const fileIds = normalizeIdList(req.body?.fileIds);
    const deviceIds = normalizeIdList(req.body?.deviceIds);
    const clusterIds = normalizeIdList(req.body?.clusterIds);
    if (!fileIds.length) throw new HttpError(400, "fileIds不能为空");

    const db = await readDB();
    const requestedIds = resolveTargetDeviceIds(db, deviceIds, clusterIds);
    if (!requestedIds.length) throw new HttpError(400, "至少提供一个目标设备");

    const files = fileIds
      .map((id) => db.tfFiles.find((item) => item.id === id))
      .filter(Boolean);
    if (!files.length) throw new HttpError(404, "文件不存在");

    if (req.auth.role === "user") {
      const deniedFile = files.find((item) => String(item.ownerId || "") !== String(req.auth.userId || ""));
      if (deniedFile) throw new HttpError(403, "包含无权限下发的文件");
    }

    const success = [];
    const failed = [];
    requestedIds.forEach((deviceId) => {
      try {
        const device = ensureDeviceAccess(db, req.auth, deviceId);
        const validFiles = files.filter((file) => {
          if (req.auth.role === "admin") {
            if (!device.ownerId) return true;
            return String(file.ownerId || "") === String(device.ownerId || "");
          }
          return true;
        });
        if (!validFiles.length) {
          failed.push({ deviceId, reason: "目标设备无可下发文件" });
          return;
        }
        publishDeviceEvent({
          type: "tf.sync_request",
          deviceId,
          payload: {
            requestedAt: new Date().toISOString(),
            fileIds: validFiles.map((item) => item.id),
            categories: [...new Set(validFiles.map((item) => item.category))],
          },
        });
        success.push({ deviceId, fileCount: validFiles.length });
      } catch (error) {
        failed.push({ deviceId, reason: error?.message || "下发失败" });
      }
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "tf.dispatch",
      targetType: "device_batch",
      targetId: `count:${requestedIds.length}`,
      detail: { fileIds, successCount: success.length, failedCount: failed.length },
    });

    res.success({
      total: requestedIds.length,
      successCount: success.length,
      failedCount: failed.length,
      successDeviceIds: success.map((item) => item.deviceId),
      failed,
      results: success,
    }, success.length ? "下发通知已发送" : "无可下发目标");
  })
);

module.exports = router;
