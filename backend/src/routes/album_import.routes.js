const express = require("express");
const crypto = require("crypto");
const path = require("path");
const multer = require("multer");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDBOptimistic } = require("../db/store");
const { getGridBucket } = require("../utils/mongo");
const { createConcurrencyLimiter } = require("../utils/concurrency");
const { createAlbumImportService } = require("../services/album/album_import.service");
const {
  DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC,
  createPlayCollectionService,
} = require("../services/play_collection.service");
const { mimeFromName, isImageName } = require("../services/album/openlist_provider.service");
const { previewE6Images } = require("../services/e6/e6_asset_retry.service");
const {
  convertImageBufferToE6P4,
  previewE6Buffer,
  DEFAULT_E6_DITHER_MODE,
  E6_CONVERTER_VERSION,
  e6ConverterEngineForMode,
  E6_PACKED4_SIZE,
  E6_DITHER_MODES,
  normalizeE6DitherMode,
  normalizeE6ImageTransform,
  e6TransformKey,
} = require("../services/e6/e6_converter.service");

const router = express.Router();
router.use(allowRoles("admin", "user"));

const importService = createAlbumImportService();
const collectionService = createPlayCollectionService();
const uploadConvertLimit = createConcurrencyLimiter(2);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 80,
    fileSize: 40 * 1024 * 1024,
  },
});

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function saveTfBuffer({ ownerId, category = "photo", originalName, mime, buffer, meta = {}, persist = true }) {
  const recordId = createId("tf");
  const filename = `${recordId}_${originalName || "file"}`;
  const hash = sha256Hex(buffer);
  const bucket = await getGridBucket("tf_files");
  const uploadStream = bucket.openUploadStream(filename, {
    contentType: mime || "application/octet-stream",
    metadata: {
      ownerId,
      category,
      originalName: originalName || filename,
      sha256: hash,
      ...meta,
    },
  });
  const gridId = await new Promise((resolve, reject) => {
    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(uploadStream.id));
    uploadStream.end(buffer);
  });
  const now = new Date().toISOString();
  const record = {
    id: recordId,
    ownerId,
    category,
    name: filename,
    originalName: originalName || filename,
    size: buffer.length,
    mime: mime || "application/octet-stream",
    gridId: String(gridId),
    url: `/api/tf/${recordId}/download`,
    sha256: hash,
    meta,
    createdAt: now,
    updatedAt: now,
  };
  if (persist) {
    await updateDBOptimistic((draft) => {
      draft.tfFiles = Array.isArray(draft.tfFiles) ? draft.tfFiles : [];
      draft.tfFiles.unshift(record);
    });
  }
  return record;
}

function e6AssetDitherMode(item) {
  return String(item?.ditherMode || item?.meta?.ditherMode || "legacy_unknown");
}

function e6AssetConverterVersion(item) {
  return String(item?.converterVersion || item?.meta?.converterVersion || "");
}

function e6AssetConverterEngine(item) {
  return String(item?.converterEngine || item?.meta?.converterEngine || "");
}

function e6AssetTransformKey(item) {
  return String(item?.transformKey || item?.meta?.transformKey || "");
}

function readyE6Key(imageId, ditherMode, imageTransform = {}) {
  return `${String(imageId || "")}:${String(ditherMode || DEFAULT_E6_DITHER_MODE)}:${e6TransformKey(imageTransform)}`;
}

function hasReadyE6Asset(draft, imageId, ditherMode = DEFAULT_E6_DITHER_MODE, imageTransform = {}) {
  draft.e6RenderedAssets = Array.isArray(draft.e6RenderedAssets) ? draft.e6RenderedAssets : [];
  const expectedEngine = e6ConverterEngineForMode(ditherMode);
  const expectedTransformKey = e6TransformKey(imageTransform);
  return draft.e6RenderedAssets.some(
    (item) => {
      const status = String(item.convertStatus || "").toLowerCase();
      return (
        item.imageId === imageId &&
        e6AssetDitherMode(item) === ditherMode &&
        e6AssetConverterVersion(item) === E6_CONVERTER_VERSION &&
        e6AssetConverterEngine(item) === expectedEngine &&
        e6AssetTransformKey(item) === expectedTransformKey &&
        (!status || status === "ready" || status === "success") &&
        item.binaryTfFileId &&
        item.previewTfFileId
      );
    }
  );
}

function normalizeUploadDitherMode(body = {}) {
  if (normalizeBool(body?.dither, true) === false) return "poster_clean";
  try {
    return normalizeE6DitherMode(body?.ditherMode || DEFAULT_E6_DITHER_MODE);
  } catch (error) {
    throw new HttpError(400, `不支持的抖动方式：${body?.ditherMode || ""}，可选：${E6_DITHER_MODES.join(", ")}`);
  }
}

function normalizeRequestImageTransform(body = {}) {
  let raw = body?.imageTransform || body?.transform || body || {};
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (_) {
      raw = {};
    }
  }
  return normalizeE6ImageTransform(raw);
}

async function convertUploadedE6Asset({ ownerId, imageId, originalName, buffer, ditherMode = DEFAULT_E6_DITHER_MODE, imageTransform = {} }) {
  const converted = await convertImageBufferToE6P4(buffer, { fit: "contain", ditherMode, imageTransform, preview: false });
  const previewBuffer = await previewE6Buffer(converted.buffer);
  const e6Tf = await saveTfBuffer({
    ownerId,
    category: "photo",
    originalName: `${path.parse(originalName).name || imageId}.e6p4`,
    mime: "application/octet-stream",
    buffer: converted.buffer,
    meta: {
      imageAssetId: imageId,
      deviceType: "e6-color-frame",
      format: "e6p4",
      ditherMode: converted.ditherMode,
      dither: converted.dither,
      converterVersion: E6_CONVERTER_VERSION,
      converterEngine: converted.converterEngine,
      imageTransform: converted.imageTransform,
      transformKey: converted.transformKey,
    },
  });
  const previewTf = await saveTfBuffer({
    ownerId,
    category: "photo",
    originalName: `${path.parse(originalName).name || imageId}.e6-preview.png`,
    mime: "image/png",
    buffer: previewBuffer,
    meta: {
      imageAssetId: imageId,
      deviceType: "e6-color-frame",
      format: "e6-preview-png",
      ditherMode: converted.ditherMode,
      dither: converted.dither,
      converterVersion: E6_CONVERTER_VERSION,
      converterEngine: converted.converterEngine,
      imageTransform: converted.imageTransform,
      transformKey: converted.transformKey,
      binarySha256: converted.sha256,
    },
  });
  const e6Asset = {
    id: createId("e6asset"),
    imageId,
    deviceType: "e6-color-frame",
    width: converted.width,
    height: converted.height,
    colorMode: "e6_6color",
    previewGridId: previewTf.gridId || "",
    previewTfFileId: previewTf.id,
    binaryGridId: e6Tf.gridId || "",
    binaryTfFileId: e6Tf.id,
    binarySha256: converted.sha256,
    binarySize: E6_PACKED4_SIZE,
    ditherMode: converted.ditherMode,
    dither: converted.dither,
    converterVersion: E6_CONVERTER_VERSION,
    converterEngine: converted.converterEngine,
    imageTransform: converted.imageTransform,
    transformKey: converted.transformKey,
    convertStatus: "ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await updateDBOptimistic((draft) => {
    draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
    draft.e6RenderedAssets = Array.isArray(draft.e6RenderedAssets) ? draft.e6RenderedAssets : [];
    const existingReady = draft.e6RenderedAssets.find(
      (item) => {
        const status = String(item.convertStatus || "").toLowerCase();
        return (
          item.imageId === imageId &&
          e6AssetDitherMode(item) === converted.ditherMode &&
          e6AssetConverterVersion(item) === E6_CONVERTER_VERSION &&
          e6AssetConverterEngine(item) === converted.converterEngine &&
          e6AssetTransformKey(item) === converted.transformKey &&
          item.binarySha256 === converted.sha256 &&
          item.previewTfFileId &&
          (!status || status === "ready" || status === "success")
        );
      }
    );
    const image = draft.imageAssets.find((item) => item.id === imageId);
    if (existingReady) {
      if (image) {
        image.e6AssetId = existingReady.id;
        image.e6ConvertStatus = "ready";
        image.e6ConvertError = "";
        image.e6DitherMode = converted.ditherMode;
        image.e6ImageTransform = converted.imageTransform;
        image.e6TransformKey = converted.transformKey;
        image.updatedAt = new Date().toISOString();
      }
      return;
    }
    draft.e6RenderedAssets.unshift(e6Asset);
    if (image) {
      image.e6AssetId = e6Asset.id;
      image.e6ConvertStatus = "ready";
      image.e6ConvertError = "";
      image.e6DitherMode = converted.ditherMode;
      image.e6ImageTransform = converted.imageTransform;
      image.e6TransformKey = converted.transformKey;
      image.updatedAt = new Date().toISOString();
    }
  });
}

function queueUploadedE6Conversion(params) {
  uploadConvertLimit(() => convertUploadedE6Asset(params)).catch((error) => {
    const message = error?.message || String(error || "E6转码失败");
    console.warn(`[album-upload] async E6 conversion failed image=${params.imageId}: ${message}`);
    updateDBOptimistic((draft) => {
      draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
      const image = draft.imageAssets.find((item) => item.id === params.imageId);
      if (!image) return;
      image.e6ConvertStatus = "failed";
      image.e6ConvertError = message;
      image.updatedAt = new Date().toISOString();
    }).catch(() => {});
  });
}

function normalizeBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return Boolean(value);
}

function ownerIdFromReq(req) {
  return req.auth.role === "admin" && req.body?.ownerId ? String(req.body.ownerId) : String(req.auth.userId || "");
}

function canWriteImage(auth, image = {}) {
  if (auth?.role === "admin") return true;
  return String(image.ownerId || "") === String(auth?.userId || "");
}

function sanitizeOriginalName(name) {
  const base = path.basename(String(name || "").replace(/\\/g, "/"));
  return base || "upload-image";
}

async function ensureUploadCollection(req, ownerId) {
  let collectionId = String(req.body?.targetCollectionId || "").trim();
  const collectionName = String(req.body?.createCollectionName || req.body?.newCollectionName || "").trim();
  const slideIntervalSec = Math.max(
    5,
    Math.min(86400, Number(req.body?.slideIntervalSec || DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC))
  );
  await updateDBOptimistic((draft) => {
    if (collectionId) {
      collectionService.getWritableCollection(draft, req.auth, collectionId);
      return;
    }
    if (!collectionName) {
      return;
    }
    const created = collectionService.createCollection(draft, req.auth, {
      ownerId,
      name: collectionName,
      description: String(req.body?.description || "").trim(),
      playMode: "slideshow",
      slideIntervalSec,
      offlineSyncEnabled: true,
      targetDeviceType: "e6-color-frame",
    });
    collectionId = created.id;
  });
  return collectionId;
}

async function saveUploadedImage({ req, ownerId, file, collectionId, sortOrder, autoConvert, dedupe, ditherMode = DEFAULT_E6_DITHER_MODE, imageTransform = {} }) {
  const originalName = sanitizeOriginalName(file.originalname || file.name);
  const mime = file.mimetype || mimeFromName(originalName);
  const hash = sha256Hex(file.buffer);
  let imageAsset = null;
  let e6Ready = false;

  await updateDBOptimistic((draft) => {
    draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
    imageAsset = dedupe
      ? draft.imageAssets.find((item) => item.ownerId === ownerId && item.sha256 === hash && item.status === "ready")
      : null;
    e6Ready = imageAsset ? hasReadyE6Asset(draft, imageAsset.id, ditherMode, imageTransform) : false;
  });

  if (!imageAsset) {
    const originalTf = await saveTfBuffer({
      ownerId,
      category: "photo",
      originalName,
      mime,
      buffer: file.buffer,
      meta: {
        sourceType: "local_upload",
        sourcePath: originalName,
      },
    });
    imageAsset = {
      id: createId("img"),
      ownerId,
      sourceType: "local_upload",
      sourceId: "local_upload",
      sourcePath: originalName,
      originalName,
      mime,
      size: Number(file.size || file.buffer.length),
      sha256: hash,
      tfFileId: originalTf.id,
      originalTfFileId: originalTf.id,
      gridId: originalTf.gridId || "",
      thumbnailGridId: "",
      previewGridId: "",
      width: 0,
      height: 0,
      status: "ready",
      e6ConvertStatus: "",
      e6ConvertError: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const shouldQueueE6Conversion = Boolean(autoConvert && isImageName(originalName) && !e6Ready);
  if (shouldQueueE6Conversion) {
    imageAsset.e6ConvertStatus = "queued";
    imageAsset.e6ConvertError = "";
    imageAsset.e6DitherMode = ditherMode;
    imageAsset.e6ImageTransform = imageTransform;
    imageAsset.e6TransformKey = e6TransformKey(imageTransform);
  } else if (e6Ready) {
    imageAsset.e6ConvertStatus = "ready";
    imageAsset.e6ConvertError = "";
    imageAsset.e6DitherMode = ditherMode;
    imageAsset.e6ImageTransform = imageTransform;
    imageAsset.e6TransformKey = e6TransformKey(imageTransform);
  }

  await updateDBOptimistic((draft) => {
    draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
    draft.playCollectionItems = Array.isArray(draft.playCollectionItems) ? draft.playCollectionItems : [];

    const existingImage = draft.imageAssets.find((item) => item.id === imageAsset.id);
    if (existingImage) {
      Object.assign(existingImage, imageAsset, { updatedAt: new Date().toISOString() });
    } else {
      draft.imageAssets.unshift(imageAsset);
    }

    if (collectionId) {
      const exists = draft.playCollectionItems.some((item) => item.collectionId === collectionId && item.imageId === imageAsset.id);
      if (!exists) {
        draft.playCollectionItems.push({
          id: createId("coli"),
          collectionId,
          imageId: imageAsset.id,
          sortOrder,
          durationSec: 0,
          enabled: true,
          createdAt: new Date().toISOString(),
        });
      }
      const collection = draft.playCollections.find((item) => item.id === collectionId);
      if (collection) {
        collection.coverImageId = collection.coverImageId || imageAsset.id;
        collection.version = Number(collection.version || 1) + 1;
        collection.updatedAt = new Date().toISOString();
      }
    }
  });

  if (shouldQueueE6Conversion) {
    queueUploadedE6Conversion({
      ownerId,
      imageId: imageAsset.id,
      originalName,
      buffer: Buffer.from(file.buffer),
      ditherMode,
      imageTransform,
    });
  }

  return {
    imageId: imageAsset.id,
    originalName,
    size: Number(file.size || file.buffer.length),
    mime,
    e6Ready,
    e6Status: shouldQueueE6Conversion ? "queued" : e6Ready ? "ready" : "",
  };
}

function existingImageKey(ownerId, hash) {
  return `${String(ownerId || "")}:${String(hash || "")}`;
}

function stageUploadedImage({ ownerId, file, snapshot, existingByHash, readyE6Keys, autoConvert, dedupe, sortOrder, ditherMode = DEFAULT_E6_DITHER_MODE, imageTransform = {} }) {
  const originalName = sanitizeOriginalName(file.originalname || file.name);
  const mime = file.mimetype || mimeFromName(originalName);
  const hash = sha256Hex(file.buffer);
  const key = existingImageKey(ownerId, hash);
  let imageAsset = dedupe ? existingByHash.get(key) : null;
  const e6Ready = imageAsset ? readyE6Keys.has(readyE6Key(imageAsset.id, ditherMode, imageTransform)) : false;
  let originalTf = null;
  let isNewImage = false;

  if (imageAsset) {
    imageAsset = { ...imageAsset };
  } else {
    isNewImage = true;
    imageAsset = {
      id: createId("img"),
      ownerId,
      sourceType: "local_upload",
      sourceId: "local_upload",
      sourcePath: originalName,
      originalName,
      mime,
      size: Number(file.size || file.buffer.length),
      sha256: hash,
      tfFileId: "",
      originalTfFileId: "",
      gridId: "",
      thumbnailGridId: "",
      previewGridId: "",
      width: 0,
      height: 0,
      status: "ready",
      e6ConvertStatus: "",
      e6ConvertError: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    existingByHash.set(key, imageAsset);
  }

  const shouldQueueE6Conversion = Boolean(autoConvert && isImageName(originalName) && !e6Ready);
  if (shouldQueueE6Conversion) {
    imageAsset.e6ConvertStatus = "queued";
    imageAsset.e6ConvertError = "";
    imageAsset.e6DitherMode = ditherMode;
    imageAsset.e6ImageTransform = imageTransform;
    imageAsset.e6TransformKey = e6TransformKey(imageTransform);
  } else if (e6Ready) {
    imageAsset.e6ConvertStatus = "ready";
    imageAsset.e6ConvertError = "";
    imageAsset.e6DitherMode = ditherMode;
    imageAsset.e6ImageTransform = imageTransform;
    imageAsset.e6TransformKey = e6TransformKey(imageTransform);
  }

  return {
    file,
    originalName,
    mime,
    hash,
    imageAsset,
    originalTf,
    isNewImage,
    shouldQueueE6Conversion,
    e6Ready,
    sortOrder,
    snapshotGeneration: snapshot?.meta?.updatedAt || "",
  };
}

async function prepareUploadedImageStage(params) {
  const staged = stageUploadedImage(params);
  if (staged.isNewImage) {
    const originalTf = await saveTfBuffer({
      ownerId: params.ownerId,
      category: "photo",
      originalName: staged.originalName,
      mime: staged.mime,
      buffer: staged.file.buffer,
      meta: {
        sourceType: "local_upload",
        sourcePath: staged.originalName,
      },
      persist: false,
    });
    staged.originalTf = originalTf;
    staged.imageAsset.tfFileId = originalTf.id;
    staged.imageAsset.originalTfFileId = originalTf.id;
    staged.imageAsset.gridId = originalTf.gridId || "";
  }
  return staged;
}

async function saveUploadedImagesBatch({ req, ownerId, files, autoConvert, dedupe, ditherMode = DEFAULT_E6_DITHER_MODE, imageTransform = {} }) {
  const snapshot = await readDB();
  const requestedCollectionId = String(req.body?.targetCollectionId || "").trim();
  if (requestedCollectionId) {
    collectionService.getWritableCollection(snapshot, req.auth, requestedCollectionId);
  }
  const existingByHash = new Map();
  (snapshot.imageAssets || [])
    .filter((item) => item.ownerId === ownerId && item.sha256 && item.status === "ready")
    .forEach((item) => {
      existingByHash.set(existingImageKey(ownerId, item.sha256), item);
    });
  const readyE6Keys = new Set(
    (snapshot.e6RenderedAssets || [])
      .filter((item) => item.imageId && item.binaryTfFileId)
      .filter((item) => {
        const status = String(item.convertStatus || "").toLowerCase();
        return !status || status === "ready" || status === "success";
      })
      .filter((item) => e6AssetConverterVersion(item) === E6_CONVERTER_VERSION)
      .filter((item) => {
        try {
          return e6AssetConverterEngine(item) === e6ConverterEngineForMode(e6AssetDitherMode(item));
        } catch (_) {
          return false;
        }
      })
      .filter((item) => item.previewTfFileId)
      .map((item) => readyE6Key(item.imageId, e6AssetDitherMode(item), item.imageTransform || item.meta?.imageTransform || {}))
  );

  const staged = [];
  const failed = [];
  for (const [index, file] of files.entries()) {
    try {
      staged.push(
        await prepareUploadedImageStage({
          req,
          ownerId,
          file,
          snapshot,
          existingByHash,
          readyE6Keys,
          autoConvert,
          dedupe,
          sortOrder: index + 1,
          ditherMode,
          imageTransform,
        })
      );
    } catch (error) {
      failed.push({
        originalName: sanitizeOriginalName(file.originalname || file.name),
        error: error?.message || String(error || "上传失败"),
      });
    }
  }

  if (!staged.length) {
    throw new HttpError(400, failed[0]?.error || "图片上传失败");
  }

  let collectionId = requestedCollectionId;
  const collectionName = String(req.body?.createCollectionName || req.body?.newCollectionName || "").trim();
  const slideIntervalSec = Math.max(
    5,
    Math.min(86400, Number(req.body?.slideIntervalSec || DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC))
  );

  await updateDBOptimistic((draft) => {
    draft.tfFiles = Array.isArray(draft.tfFiles) ? draft.tfFiles : [];
    draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
    draft.playCollectionItems = Array.isArray(draft.playCollectionItems) ? draft.playCollectionItems : [];
    draft.playCollections = Array.isArray(draft.playCollections) ? draft.playCollections : [];

    if (collectionId) {
      collectionService.getWritableCollection(draft, req.auth, collectionId);
    } else if (collectionName) {
      const created = collectionService.createCollection(draft, req.auth, {
        ownerId,
        name: collectionName,
        description: String(req.body?.description || "").trim(),
        playMode: "slideshow",
        slideIntervalSec,
        offlineSyncEnabled: true,
        targetDeviceType: "e6-color-frame",
      });
      collectionId = created.id;
    }

    staged
      .filter((item) => item.originalTf)
      .slice()
      .reverse()
      .forEach((item) => {
        if (!draft.tfFiles.some((row) => row.id === item.originalTf.id)) {
          draft.tfFiles.unshift(item.originalTf);
        }
      });

    let collectionChanged = false;
    for (const item of staged) {
      const existingImage = draft.imageAssets.find((row) => row.id === item.imageAsset.id);
      if (existingImage) {
        Object.assign(existingImage, item.imageAsset, { updatedAt: new Date().toISOString() });
      } else {
        draft.imageAssets.unshift(item.imageAsset);
      }

      if (collectionId) {
        const exists = draft.playCollectionItems.some(
          (row) => row.collectionId === collectionId && row.imageId === item.imageAsset.id
        );
        if (!exists) {
          draft.playCollectionItems.push({
            id: createId("coli"),
            collectionId,
            imageId: item.imageAsset.id,
            sortOrder: item.sortOrder,
            durationSec: 0,
            enabled: true,
            createdAt: new Date().toISOString(),
          });
          collectionChanged = true;
        }
      }
    }

    if (collectionId) {
      const collection = draft.playCollections.find((row) => row.id === collectionId);
      if (collection) {
        collection.coverImageId = collection.coverImageId || staged[0]?.imageAsset?.id || "";
        if (collectionChanged) collection.version = Number(collection.version || 1) + 1;
        collection.updatedAt = new Date().toISOString();
      }
    }
  });

  staged
    .filter((item) => item.shouldQueueE6Conversion)
    .forEach((item) => {
      queueUploadedE6Conversion({
        ownerId,
        imageId: item.imageAsset.id,
        originalName: item.originalName,
        buffer: Buffer.from(item.file.buffer),
        ditherMode,
        imageTransform,
      });
    });

  return {
    collectionId,
    files: staged.map((item) => ({
      imageId: item.imageAsset.id,
      originalName: item.originalName,
      size: Number(item.file.size || item.file.buffer.length),
      mime: item.mime,
      e6Ready: item.e6Ready,
      e6Status: item.shouldQueueE6Conversion ? "queued" : item.e6Ready ? "ready" : "",
    })),
    failed,
  };
}

async function markJobFailed(jobId, message) {
  await updateDBOptimistic((draft) => {
    const job = (draft.imageImportJobs || []).find((item) => item.id === jobId);
    if (!job) return;
    job.status = "failed";
    job.lastError = String(message || "导入失败");
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
  });
}

router.post(
  "/images",
  asyncHandler(async (req, res) => {
    let created = null;
    await updateDBOptimistic((draft) => {
      created = importService.createJob(draft, req.auth, req.body || {});
    });
    setImmediate(() => {
      importService
        .processJob({ jobId: created.job.id, auth: req.auth, readDB, updateDB: updateDBOptimistic, saveTfBuffer })
        .catch((error) => markJobFailed(created.job.id, error?.message || String(error || "导入失败")));
    });
    res.success(created.job, "导入任务已创建", 202);
  })
);

router.post(
  "/e6-preview",
  asyncHandler(async (req, res) => {
    const imageTransform = normalizeRequestImageTransform(req.body || {});
    const previews = await previewE6Images({
      imageIds: req.body?.imageIds || [],
      ditherMode: req.body?.ditherMode || DEFAULT_E6_DITHER_MODE,
      imageTransform,
      auth: req.auth,
    });
    res.success({ previews }, "ok");
  })
);

router.post(
  "/e6-dither",
  asyncHandler(async (req, res) => {
    const imageIds = [...new Set((Array.isArray(req.body?.imageIds) ? req.body.imageIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean))]
      .slice(0, 120);
    if (!imageIds.length) throw new HttpError(400, "请选择要设置抖动方式的图片");
    const ditherMode = normalizeE6DitherMode(req.body?.ditherMode || DEFAULT_E6_DITHER_MODE);
    const expectedEngine = e6ConverterEngineForMode(ditherMode);
    const imageTransform = normalizeRequestImageTransform(req.body || {});
    const expectedTransformKey = e6TransformKey(imageTransform);
    const updated = [];
    await updateDBOptimistic((draft) => {
      draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
      draft.e6RenderedAssets = Array.isArray(draft.e6RenderedAssets) ? draft.e6RenderedAssets : [];
      imageIds.forEach((imageId) => {
        const image = draft.imageAssets.find((item) => String(item.id || "") === imageId);
        if (!image) throw new HttpError(404, `图片不存在: ${imageId}`);
        if (!canWriteImage(req.auth, image)) throw new HttpError(403, "无权限修改图片");
        const readyAsset = draft.e6RenderedAssets.find(
          (asset) => {
            const status = String(asset.convertStatus || "").toLowerCase();
            return (
              String(asset.imageId || "") === imageId &&
              e6AssetDitherMode(asset) === ditherMode &&
              e6AssetConverterVersion(asset) === E6_CONVERTER_VERSION &&
              e6AssetConverterEngine(asset) === expectedEngine &&
              e6AssetTransformKey(asset) === expectedTransformKey &&
              (!status || status === "ready" || status === "success") &&
              asset.binaryTfFileId &&
              asset.previewTfFileId
            );
          }
        );
        image.e6DitherMode = ditherMode;
        image.e6ImageTransform = imageTransform;
        image.e6TransformKey = expectedTransformKey;
        image.e6AssetId = readyAsset?.id || "";
        image.e6ConvertStatus = readyAsset ? "ready" : "queued";
        image.e6ConvertError = "";
        image.updatedAt = new Date().toISOString();
        updated.push({
          imageId,
          ditherMode,
          imageTransform,
          e6Status: image.e6ConvertStatus,
        });
      });
      const affectedCollectionIds = new Set(
        (draft.playCollectionItems || [])
          .filter((item) => imageIds.includes(String(item.imageId || "")))
          .map((item) => String(item.collectionId || ""))
          .filter(Boolean)
      );
      (draft.playCollections || []).forEach((collection) => {
        if (!affectedCollectionIds.has(String(collection.id || ""))) return;
        collection.version = Number(collection.version || 1) + 1;
        collection.updatedAt = new Date().toISOString();
      });
    });
    res.success({ updated, count: updated.length }, "抖动方式已更新，缺失的E6文件会在推送前自动生成");
  })
);

const handleAlbumUpload = asyncHandler(async (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) {
    throw new HttpError(400, "请先选择要上传的图片");
  }

  const ownerId = ownerIdFromReq(req);
  const autoConvert = normalizeBool(req.body?.autoConvert, true);
  const dedupe = normalizeBool(req.body?.dedupe, true);
  const ditherMode = normalizeUploadDitherMode(req.body || {});
  const imageTransform = normalizeRequestImageTransform(req.body || {});
  const output = await saveUploadedImagesBatch({
    req,
    ownerId,
    files,
    autoConvert,
    dedupe,
    ditherMode,
    imageTransform,
  });

  res.success(
    {
      collectionId: output.collectionId,
      files: output.files,
      failed: output.failed,
      successCount: output.files.length,
      failedCount: output.failed.length,
    },
    output.failed.length ? "部分图片上传完成" : "图片上传完成",
    201
  );
});

router.post(
  "/uploads",
  upload.array("files", 80),
  handleAlbumUpload
);

router.post(
  "/upload",
  upload.array("files", 80),
  handleAlbumUpload
);

router.get(
  "/:jobId",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(importService.getJob(db, req.auth, req.params.jobId), "ok");
  })
);

router.post(
  "/:jobId/retry",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const job = importService.getJob(db, req.auth, req.params.jobId);
    if (!["failed", "partial_failed"].includes(job.status)) {
      throw new HttpError(409, "只有失败任务可以重试");
    }
    await updateDBOptimistic((draft) => {
      const draftJob = (draft.imageImportJobs || []).find((item) => item.id === job.id);
      if (draftJob) {
        draftJob.status = "queued";
        draftJob.processed = 0;
        draftJob.successCount = 0;
        draftJob.failureCount = 0;
        draftJob.lastError = "";
        draftJob.updatedAt = new Date().toISOString();
      }
      (draft.imageImportJobItems || [])
        .filter((item) => item.jobId === job.id && item.status === "failed")
        .forEach((item) => {
          item.status = "queued";
          item.error = "";
          item.updatedAt = new Date().toISOString();
        });
    });
    setImmediate(() => {
      importService
        .processJob({ jobId: job.id, auth: req.auth, readDB, updateDB: updateDBOptimistic, saveTfBuffer })
        .catch((error) => markJobFailed(job.id, error?.message || String(error || "导入失败")));
    });
    res.success({ id: job.id }, "导入任务已重试", 202);
  })
);

router.post(
  "/:jobId/cancel",
  asyncHandler(async (req, res) => {
    let output = null;
    await updateDBOptimistic((draft) => {
      const job = importService.getJob(draft, req.auth, req.params.jobId);
      const draftJob = (draft.imageImportJobs || []).find((item) => item.id === job.id);
      if (!draftJob) return;
      if (["success", "failed", "partial_failed"].includes(draftJob.status)) {
        throw new HttpError(409, "任务已结束");
      }
      draftJob.status = "cancelled";
      draftJob.finishedAt = new Date().toISOString();
      draftJob.updatedAt = draftJob.finishedAt;
      output = draftJob;
    });
    res.success(output, "导入任务已取消");
  })
);

module.exports = router;
