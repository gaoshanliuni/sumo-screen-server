const crypto = require("crypto");
const path = require("path");
const HttpError = require("../../utils/httpError");
const createId = require("../../utils/id");
const { readDB, updateDBOptimistic } = require("../../db/store");
const { getGridBucket, ObjectId } = require("../../utils/mongo");
const { createConcurrencyLimiter } = require("../../utils/concurrency");
const { canReadOwner, createPlayCollectionService } = require("../play_collection.service");
const {
  convertImageBufferToE6P4,
  previewE6Buffer,
  DEFAULT_E6_DITHER_MODE,
  E6_CONVERTER_VERSION,
  normalizeE6ImageTransform,
  e6TransformKey,
  e6ConverterEngineForMode,
  E6_PACKED4_SIZE,
} = require("./e6_converter.service");

const retryLimit = createConcurrencyLimiter(2);
const collectionService = createPlayCollectionService();

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isReadyE6Asset(asset = {}) {
  const status = String(asset.convertStatus || "").toLowerCase();
  return Boolean(asset.binaryTfFileId && (!status || status === "ready" || status === "success"));
}

function e6AssetCreatedAtMs(asset = {}) {
  const value = Date.parse(asset.updatedAt || asset.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

function findPlayableE6AssetByImageId(state, imageId) {
  const tfById = new Map((state.tfFiles || []).map((file) => [String(file.id || ""), file]));
  return (
    (state.e6RenderedAssets || [])
      .filter((asset) => String(asset.imageId || asset.meta?.imageAssetId || "") === String(imageId || ""))
      .filter(isReadyE6Asset)
      .filter((asset) => tfById.has(String(asset.binaryTfFileId || "")))
      .sort((a, b) => {
        const aCurrent = e6AssetConverterVersion(a) === E6_CONVERTER_VERSION ? 1 : 0;
        const bCurrent = e6AssetConverterVersion(b) === E6_CONVERTER_VERSION ? 1 : 0;
        if (aCurrent !== bCurrent) return bCurrent - aCurrent;
        return e6AssetCreatedAtMs(b) - e6AssetCreatedAtMs(a);
      })[0] || null
  );
}

function e6AssetDitherMode(asset = {}) {
  return String(asset.ditherMode || asset.meta?.ditherMode || "legacy_unknown");
}

function e6AssetConverterVersion(asset = {}) {
  return String(asset.converterVersion || asset.meta?.converterVersion || "");
}

function e6AssetConverterEngine(asset = {}) {
  return String(asset.converterEngine || asset.meta?.converterEngine || "");
}

function e6AssetTransformKey(asset = {}) {
  return String(asset.transformKey || asset.meta?.transformKey || "");
}

function desiredImageTransform(image = {}, override = null) {
  return normalizeE6ImageTransform(override || image.e6ImageTransform || image.e6Transform || image.imageTransform || {});
}

function isCurrentE6Asset(asset = {}) {
  if (!isReadyE6Asset(asset)) return false;
  if (e6AssetConverterVersion(asset) !== E6_CONVERTER_VERSION) return false;
  const mode = e6AssetDitherMode(asset);
  if (mode === "legacy_unknown") return false;
  try {
    return e6AssetConverterEngine(asset) === e6ConverterEngineForMode(mode);
  } catch (_) {
    return false;
  }
}

function e6AssetForImage(state, image = {}) {
  const desiredDitherMode = String(image.e6DitherMode || DEFAULT_E6_DITHER_MODE).trim();
  const desiredTransformKey = e6TransformKey(desiredImageTransform(image));
  const matchesImageMode = (asset = {}) => e6AssetDitherMode(asset) === desiredDitherMode;
  const matchesImageTransform = (asset = {}) => e6AssetTransformKey(asset) === desiredTransformKey;
  return (
    state.e6RenderedAssets.find((asset) => asset.id && asset.id === image.e6AssetId && isCurrentE6Asset(asset) && matchesImageMode(asset) && matchesImageTransform(asset)) ||
    state.e6RenderedAssets.find((asset) => asset.imageId === image.id && isCurrentE6Asset(asset) && matchesImageMode(asset) && matchesImageTransform(asset))
  );
}

function e6AssetForImageDither(state, image = {}, ditherMode = DEFAULT_E6_DITHER_MODE, imageTransform = null) {
  const desiredDitherMode = String(ditherMode || DEFAULT_E6_DITHER_MODE).trim();
  const desiredTransformKey = e6TransformKey(desiredImageTransform(image, imageTransform));
  return (
    state.e6RenderedAssets.find(
      (asset) => asset.id && asset.id === image.e6AssetId && isCurrentE6Asset(asset) && e6AssetDitherMode(asset) === desiredDitherMode && e6AssetTransformKey(asset) === desiredTransformKey
    ) ||
    state.e6RenderedAssets.find(
      (asset) => asset.imageId === image.id && isCurrentE6Asset(asset) && e6AssetDitherMode(asset) === desiredDitherMode && e6AssetTransformKey(asset) === desiredTransformKey
    )
  );
}

function assertDeviceCollectionAccess(state, auth, collectionId, deviceId) {
  const device = state.devices.find((item) => String(item.id || "") === String(deviceId || ""));
  if (!device) throw new HttpError(404, "设备不存在");
  if (auth?.role === "device" && String(auth.deviceId || "") !== String(device.id || "")) {
    throw new HttpError(403, "设备无权限访问该集合");
  }
  if (auth?.role !== "device" && !canReadOwner(device, auth)) {
    throw new HttpError(403, "无权限访问该设备");
  }
  const collection = state.playCollections.find((item) => String(item.id || "") === String(collectionId || ""));
  if (!collection) throw new HttpError(404, "播放集合不存在");
  if (auth?.role === "device") {
    const explicitIds = [
      ...(Array.isArray(collection.targetDeviceIds) ? collection.targetDeviceIds : []),
      ...(Array.isArray(collection.deviceIds) ? collection.deviceIds : []),
      ...(Array.isArray(collection.assignedDeviceIds) ? collection.assignedDeviceIds : []),
    ].map((item) => String(item || ""));
    const assignedToDevice =
      String(device.currentCollectionId || "") === String(collection.id || "") ||
      String(device.lastDisplayCollectionId || "") === String(collection.id || "") ||
      explicitIds.includes(String(device.id || ""));
    if (!collection.isPublic && String(collection.ownerId || "") !== String(device.ownerId || "") && !assignedToDevice) {
      throw new HttpError(403, "设备无权限访问该集合");
    }
  } else if (!canReadOwner(collection, auth)) {
    throw new HttpError(403, "无权限访问该集合");
  }
  return { device, collection };
}

function collectMissingE6Jobs(state, auth, collectionId, deviceIds = []) {
  state.playCollections = Array.isArray(state.playCollections) ? state.playCollections : [];
  state.playCollectionItems = Array.isArray(state.playCollectionItems) ? state.playCollectionItems : [];
  state.imageAssets = Array.isArray(state.imageAssets) ? state.imageAssets : [];
  state.e6RenderedAssets = Array.isArray(state.e6RenderedAssets) ? state.e6RenderedAssets : [];
  state.tfFiles = Array.isArray(state.tfFiles) ? state.tfFiles : [];
  state.devices = Array.isArray(state.devices) ? state.devices : [];

  const devices = [...new Set(deviceIds.map((id) => String(id || "").trim()).filter(Boolean))];
  devices.forEach((deviceId) => assertDeviceCollectionAccess(state, auth, collectionId, deviceId));
  const needsE6 = devices.some((deviceId) => {
    const device = state.devices.find((item) => String(item.id || "") === deviceId);
    return String(device?.type || "").toLowerCase() === "e6-color-frame";
  });
  const collection = state.playCollections.find((item) => String(item.id || "") === String(collectionId || ""));
  if (!needsE6 && String(collection?.targetDeviceType || "").toLowerCase() !== "e6-color-frame") return { jobs: [], brokenImages: [] };

  const imageById = new Map(state.imageAssets.map((item) => [String(item.id || ""), item]));
  const tfById = new Map(state.tfFiles.map((item) => [String(item.id || ""), item]));
  const jobs = [];
  const brokenImages = [];
  const seen = new Set();
  state.playCollectionItems
    .filter((item) => String(item.collectionId || "") === String(collectionId || "") && item.enabled !== false)
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
    .forEach((item) => {
      const image = imageById.get(String(item.imageId || ""));
      if (!image) {
        if (findPlayableE6AssetByImageId(state, item.imageId)) {
          return;
        }
        brokenImages.push({
          imageId: item.imageId,
          reason: "图片元数据缺失(imageAssets未找到；通常是旧版本迁移未回填，不代表用户删除了原图)",
          image: null,
        });
        return;
      }
      if (auth?.role !== "device" && !canReadOwner(image, auth)) {
        brokenImages.push({ imageId: image.id, reason: "无权限访问图片", image });
        return;
      }
      if (e6AssetForImage(state, image)) return;
      if (findPlayableE6AssetByImageId(state, image.id)) return;
      if (seen.has(image.id)) return;
      seen.add(image.id);
      const originalTfId = String(image.originalTfFileId || image.tfFileId || "");
      const originalTf = tfById.get(originalTfId);
      if (!originalTf || !originalTf.gridId) {
        brokenImages.push({
          imageId: image.id,
          originalName: image.originalName || "",
          reason: !originalTf ? `原图TF文件不存在(originalTfFileId=${originalTfId || "(空)"})` : "原图gridId为空(GridFS文件已丢失)",
          image,
        });
        return;
      }
      jobs.push({ image, originalTf });
    });
  return { jobs, brokenImages };
}

async function readTfBuffer(tfFile) {
  const bucket = await getGridBucket("tf_files");
  let gridObjectId = null;
  try {
    gridObjectId = new ObjectId(String(tfFile.gridId || ""));
  } catch (_) {
    throw new HttpError(409, `原图GridFS ID无效: ${tfFile.id || ""}`);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = bucket.openDownloadStream(gridObjectId);
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function saveTfBuffer({ ownerId, originalName, buffer, mime = "application/octet-stream", category = "photo", meta = {} }) {
  const recordId = createId("tf");
  const filename = `${recordId}_${originalName || "file.e6p4"}`;
  const hash = sha256Hex(buffer);
  const bucket = await getGridBucket("tf_files");
  const uploadStream = bucket.openUploadStream(filename, {
    contentType: mime,
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
    mime,
    gridId: String(gridId),
    url: `/api/tf/${recordId}/download`,
    sha256: hash,
    meta,
    createdAt: now,
    updatedAt: now,
  };
  return record;
}

async function convertMissingJob(job) {
  const originalBuffer = await readTfBuffer(job.originalTf);
  const converted = await convertImageBufferToE6P4(originalBuffer, {
    fit: "contain",
    ditherMode: job.image.e6DitherMode || DEFAULT_E6_DITHER_MODE,
    imageTransform: desiredImageTransform(job.image),
    preview: false,
  });
  const previewBuffer = await previewE6Buffer(converted.buffer);
  const e6Tf = await saveTfBuffer({
    ownerId: job.image.ownerId,
    originalName: `${path.parse(job.image.originalName || job.image.id).name || job.image.id}.e6p4`,
    buffer: converted.buffer,
    meta: {
      imageAssetId: job.image.id,
      deviceType: "e6-color-frame",
      format: "e6p4",
      ditherMode: converted.ditherMode,
      dither: converted.dither,
      converterVersion: E6_CONVERTER_VERSION,
      converterEngine: converted.converterEngine,
      imageTransform: converted.imageTransform,
      transformKey: converted.transformKey,
      retry: true,
    },
  });
  const previewTf = await saveTfBuffer({
    ownerId: job.image.ownerId,
    originalName: `${path.parse(job.image.originalName || job.image.id).name || job.image.id}.e6-preview.png`,
    mime: "image/png",
    buffer: previewBuffer,
    meta: {
      imageAssetId: job.image.id,
      deviceType: "e6-color-frame",
      format: "e6-preview-png",
      ditherMode: converted.ditherMode,
      dither: converted.dither,
      converterVersion: E6_CONVERTER_VERSION,
      converterEngine: converted.converterEngine,
      imageTransform: converted.imageTransform,
      transformKey: converted.transformKey,
      binarySha256: converted.sha256,
      retry: true,
    },
  });
  return {
    imageId: job.image.id,
    tfFile: e6Tf,
    previewTfFile: previewTf,
    e6Asset: {
      id: createId("e6asset"),
      imageId: job.image.id,
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
    },
  };
}

async function ensureImageE6AssetReady({ imageId, ditherMode = DEFAULT_E6_DITHER_MODE, imageTransform = null, auth, applyToImage = false }) {
  let snapshot = await readDB();
  snapshot.imageAssets = Array.isArray(snapshot.imageAssets) ? snapshot.imageAssets : [];
  snapshot.tfFiles = Array.isArray(snapshot.tfFiles) ? snapshot.tfFiles : [];
  snapshot.e6RenderedAssets = Array.isArray(snapshot.e6RenderedAssets) ? snapshot.e6RenderedAssets : [];
  const image = snapshot.imageAssets.find((item) => String(item.id || "") === String(imageId || ""));
  if (!image) throw new HttpError(404, `图片不存在: ${imageId}`);
  if (auth?.role !== "device" && !canReadOwner(image, auth)) throw new HttpError(403, "无权限访问图片");
  const normalizedDitherMode = String(ditherMode || DEFAULT_E6_DITHER_MODE).trim();
  const normalizedTransform = desiredImageTransform(image, imageTransform);
  const existingAsset = e6AssetForImageDither(snapshot, image, normalizedDitherMode, normalizedTransform);
  if (existingAsset) {
    const existingTf = snapshot.tfFiles.find((file) => file.id === existingAsset.binaryTfFileId);
    if (!existingTf) throw new HttpError(409, `E6文件不存在: ${image.id}`);
    return { image, e6Asset: existingAsset, tfFile: existingTf, generated: false };
  }

  const originalTfId = String(image.originalTfFileId || image.tfFileId || "");
  const originalTf = snapshot.tfFiles.find((file) => file.id === originalTfId);
  if (!originalTf || !originalTf.gridId) {
    throw new HttpError(409, `图片缺少可生成E6文件的原图: ${image.id}`);
  }
  const result = await convertMissingJobWithRetry({
    image: {
      ...image,
      e6DitherMode: normalizedDitherMode,
      e6ImageTransform: normalizedTransform,
    },
    originalTf,
  });

  await updateDBOptimistic((draft) => {
    draft.tfFiles = Array.isArray(draft.tfFiles) ? draft.tfFiles : [];
    draft.e6RenderedAssets = Array.isArray(draft.e6RenderedAssets) ? draft.e6RenderedAssets : [];
    draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
    if (!draft.tfFiles.some((file) => file.id === result.tfFile.id)) {
      draft.tfFiles.unshift(result.tfFile);
    }
    if (result.previewTfFile && !draft.tfFiles.some((file) => file.id === result.previewTfFile.id)) {
      draft.tfFiles.unshift(result.previewTfFile);
    }
    if (!draft.e6RenderedAssets.some((asset) => asset.id === result.e6Asset.id)) {
      draft.e6RenderedAssets.unshift(result.e6Asset);
    }
    if (applyToImage) {
      const draftImage = draft.imageAssets.find((item) => item.id === result.imageId);
      if (draftImage) {
        draftImage.e6AssetId = result.e6Asset.id;
        draftImage.e6ConvertStatus = "ready";
        draftImage.e6ConvertError = "";
        draftImage.e6DitherMode = result.e6Asset.ditherMode;
        draftImage.e6ImageTransform = result.e6Asset.imageTransform;
        draftImage.e6TransformKey = result.e6Asset.transformKey;
        draftImage.updatedAt = new Date().toISOString();
      }
    }
  });

  snapshot = await readDB();
  const e6Asset = (snapshot.e6RenderedAssets || []).find((asset) => asset.id === result.e6Asset.id) || result.e6Asset;
  const tfFile = (snapshot.tfFiles || []).find((file) => file.id === e6Asset.binaryTfFileId) || result.tfFile;
  return { image, e6Asset, tfFile, generated: true };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function convertMissingJobWithRetry(job, attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await convertMissingJob(job);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(250 * attempt);
      }
    }
  }
  throw lastError || new Error("E6转换失败");
}

async function ensureCollectionE6AssetsReady({ collectionId, deviceIds = [], auth }) {
  const snapshot = await readDB();
  const { jobs, brokenImages } = collectMissingE6Jobs(snapshot, auth, collectionId, deviceIds);

  if (brokenImages.length) {
    await updateDBOptimistic((draft) => {
      draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
      brokenImages.forEach((broken) => {
        const image = draft.imageAssets.find((item) => item.id === broken.imageId);
        if (!image) return;
        image.e6ConvertStatus = "failed";
        image.e6ConvertError = broken.reason;
        image.e6ConvertRetryAt = new Date().toISOString();
        image.updatedAt = image.e6ConvertRetryAt;
      });
    });
    const first = brokenImages[0];
    const reason = first.reason ? ` ${first.reason}` : "";
    throw new HttpError(409, `图片尚未生成E6文件且缺少可重试原图: ${first.imageId}${reason}`);
  }

  if (!jobs.length) {
    return {
      convertedCount: 0,
      brokenImageCount: brokenImages.length,
      brokenImages: brokenImages.map((b) => ({ imageId: b.imageId, originalName: b.originalName || "", reason: b.reason })),
    };
  }

  const imageIds = jobs.map((job) => job.image.id);
  await updateDBOptimistic((draft) => {
    draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
    draft.imageAssets
      .filter((image) => imageIds.includes(image.id))
      .forEach((image) => {
        image.e6ConvertStatus = "running";
        image.e6ConvertError = "";
        image.e6ConvertRetryAt = new Date().toISOString();
        image.updatedAt = image.e6ConvertRetryAt;
      });
  });

  const settled = await Promise.all(
    jobs.map((job) =>
      retryLimit(() => convertMissingJobWithRetry(job)).then(
        (result) => ({ ok: true, job, result }),
        (error) => ({ ok: false, job, error })
      )
    )
  );
  const results = settled.filter((item) => item.ok).map((item) => item.result);
  const failures = settled.filter((item) => !item.ok);
  await updateDBOptimistic((draft) => {
    draft.tfFiles = Array.isArray(draft.tfFiles) ? draft.tfFiles : [];
    draft.e6RenderedAssets = Array.isArray(draft.e6RenderedAssets) ? draft.e6RenderedAssets : [];
    draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
    results.forEach((result) => {
      if (!draft.tfFiles.some((file) => file.id === result.tfFile.id)) {
        draft.tfFiles.unshift(result.tfFile);
      }
      if (result.previewTfFile && !draft.tfFiles.some((file) => file.id === result.previewTfFile.id)) {
        draft.tfFiles.unshift(result.previewTfFile);
      }
      if (!draft.e6RenderedAssets.some((asset) => asset.id === result.e6Asset.id)) {
        draft.e6RenderedAssets.unshift(result.e6Asset);
      }
      const image = draft.imageAssets.find((item) => item.id === result.imageId);
      if (image) {
        image.e6AssetId = result.e6Asset.id;
        image.e6ConvertStatus = "ready";
        image.e6ConvertError = "";
        image.e6DitherMode = result.e6Asset.ditherMode;
        image.e6ImageTransform = result.e6Asset.imageTransform;
        image.e6TransformKey = result.e6Asset.transformKey;
        image.updatedAt = new Date().toISOString();
      }
    });
    failures.forEach((failure) => {
      const image = draft.imageAssets.find((item) => item.id === failure.job.image.id);
      if (!image) return;
      image.e6ConvertStatus = "failed";
      image.e6ConvertError = failure.error?.message || String(failure.error || "E6转换失败");
      image.updatedAt = new Date().toISOString();
    });
  });
  const allBroken = [
    ...brokenImages.map((b) => ({ imageId: b.imageId, originalName: b.originalName || "", reason: b.reason })),
    ...failures.map((f) => ({
      imageId: f.job.image.id,
      originalName: f.job.image.originalName || "",
      reason: f.error?.message || String(f.error || "E6转换失败"),
    })),
  ];

  return { convertedCount: results.length, brokenImageCount: allBroken.length, brokenImages: allBroken };
}

async function previewE6Images({ imageIds = [], ditherMode = DEFAULT_E6_DITHER_MODE, imageTransform = null, auth }) {
  const wanted = [...new Set((Array.isArray(imageIds) ? imageIds : []).map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 12);
  const previews = [];
  for (const imageId of wanted) {
    const { e6Asset, tfFile, generated } = await ensureImageE6AssetReady({ imageId, ditherMode, imageTransform, auth, applyToImage: false });
    const snapshot = await readDB();
    const previewTf = (snapshot.tfFiles || []).find((file) => file.id === e6Asset.previewTfFileId);
    let previewBuffer = null;
    if (previewTf) {
      previewBuffer = await readTfBuffer(previewTf);
    } else {
      const buffer = await readTfBuffer(tfFile);
      previewBuffer = await previewE6Buffer(buffer);
    }
    previews.push({
      imageId,
      ditherMode: e6Asset.ditherMode,
      binaryTfFileId: e6Asset.binaryTfFileId,
      previewTfFileId: e6Asset.previewTfFileId || "",
      converterVersion: e6Asset.converterVersion || "",
      converterEngine: e6Asset.converterEngine || "",
      imageTransform: e6Asset.imageTransform || normalizeE6ImageTransform({}),
      transformKey: e6Asset.transformKey || "",
      generated,
      previewUrl: e6Asset.previewTfFileId ? `/api/tf/${e6Asset.previewTfFileId}/download` : "",
      previewDataUrl: `data:image/png;base64,${previewBuffer.toString("base64")}`,
    });
  }
  return previews;
}

module.exports = {
  ensureCollectionE6AssetsReady,
  ensureImageE6AssetReady,
  collectMissingE6Jobs,
  previewE6Images,
};
