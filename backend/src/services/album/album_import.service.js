const crypto = require("crypto");
const path = require("path");
const HttpError = require("../../utils/httpError");
const createId = require("../../utils/id");
const { createAlbumSourceService } = require("./album_source.service");
const { createAlbumProvider } = require("./provider_registry.service");
const { mimeFromName, isImageName } = require("./openlist_provider.service");
const { createPlayCollectionService } = require("../play_collection.service");
const {
  convertImageBufferToE6P4,
  previewE6Buffer,
  DEFAULT_E6_DITHER_MODE,
  E6_CONVERTER_VERSION,
  E6_PACKED4_SIZE,
  E6_DITHER_MODES,
  normalizeE6DitherMode,
} = require("../e6/e6_converter.service");
const { createConcurrencyLimiter } = require("../../utils/concurrency");

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeItems(items) {
  const rawItems = Array.isArray(items) ? items : [];
  if (!rawItems.length) {
    throw new HttpError(400, "请选择要导入的图片");
  }
  return rawItems
    .map((item) => ({
      path: String(item?.path || "").trim(),
      name: String(item?.name || path.posix.basename(String(item?.path || ""))).trim(),
    }))
    .filter((item) => item.path);
}

function basenameFromPath(filePath) {
  return path.posix.basename(String(filePath || "").replace(/\\/g, "/")) || "image";
}

function resolveJobDitherMode(payload = {}) {
  if (payload.dither === false) return "poster_clean";
  try {
    return normalizeE6DitherMode(payload.ditherMode || DEFAULT_E6_DITHER_MODE);
  } catch (error) {
    throw new HttpError(400, `不支持的抖动方式：${payload.ditherMode || ""}，可选：${E6_DITHER_MODES.join(", ")}`);
  }
}

function createAlbumImportService(options = {}) {
  const clock = options.now || nowIso;
  const idFactory = options.idFactory || createId;
  const limit = createConcurrencyLimiter(options.maxConcurrent || 4);
  const sourceService = options.sourceService || createAlbumSourceService({ now: clock, idFactory });
  const collectionService = options.collectionService || createPlayCollectionService({ now: clock, idFactory });

  function createJob(state, auth, payload = {}) {
    state.imageImportJobs = Array.isArray(state.imageImportJobs) ? state.imageImportJobs : [];
    state.imageImportJobItems = Array.isArray(state.imageImportJobItems) ? state.imageImportJobItems : [];
    state.imageAssets = Array.isArray(state.imageAssets) ? state.imageAssets : [];
    state.playCollections = Array.isArray(state.playCollections) ? state.playCollections : [];
    state.playCollectionItems = Array.isArray(state.playCollectionItems) ? state.playCollectionItems : [];

    const source = sourceService.getSource(state, String(payload.sourceId || ""), auth);
    const items = normalizeItems(
      Array.isArray(payload.items) && payload.items.length
        ? payload.items
        : (Array.isArray(payload.paths) ? payload.paths.map((item) => ({ path: item })) : [])
    );
    let targetCollectionId = String(payload.targetCollectionId || "");
    if (!targetCollectionId && payload.createCollection) {
      const collection = collectionService.createCollection(state, auth, payload.createCollection);
      targetCollectionId = collection.id;
    }
    if (targetCollectionId) {
      collectionService.getWritableCollection(state, auth, targetCollectionId);
    }

    const now = clock();
    const job = {
      id: idFactory("ijob"),
      ownerId: auth.role === "admin" && payload.ownerId ? String(payload.ownerId) : String(auth.userId || ""),
      sourceId: source.id,
      targetFolderId: String(payload.targetFolderId || ""),
      targetCollectionId,
      dedupe: payload.dedupe !== false,
      autoConvert: payload.autoConvert !== false,
      ditherMode: resolveJobDitherMode(payload),
      status: "queued",
      total: items.length,
      processed: 0,
      successCount: 0,
      failureCount: 0,
      lastError: "",
      createdAt: now,
      updatedAt: now,
      startedAt: "",
      finishedAt: "",
    };
    const rows = items.map((item, index) => ({
      id: idFactory("ijobi"),
      jobId: job.id,
      sourceId: source.id,
      sourcePath: item.path,
      originalName: item.name || basenameFromPath(item.path),
      status: "queued",
      imageId: "",
      error: "",
      sortOrder: index + 1,
      createdAt: now,
      updatedAt: now,
    }));
    state.imageImportJobs.unshift(job);
    state.imageImportJobItems.push(...rows);
    return { job, items: rows };
  }

  function getJob(state, auth, jobId) {
    const job = (state.imageImportJobs || []).find((item) => item.id === jobId);
    if (!job) throw new HttpError(404, "导入任务不存在");
    if (auth.role !== "admin" && String(job.ownerId || "") !== String(auth.userId || "")) {
      throw new HttpError(403, "无权限访问该导入任务");
    }
    const items = (state.imageImportJobItems || []).filter((item) => item.jobId === job.id);
    return { ...job, items };
  }

  async function processJob({ jobId, auth, readDB, updateDB, saveTfBuffer }) {
    if (typeof readDB !== "function" || typeof updateDB !== "function") {
      throw new Error("readDB/updateDB are required");
    }
    if (typeof saveTfBuffer !== "function") {
      throw new Error("saveTfBuffer is required");
    }

    await updateDB((draft) => {
      const job = (draft.imageImportJobs || []).find((item) => item.id === jobId);
      if (!job) throw new HttpError(404, "导入任务不存在");
      job.status = "running";
      job.startedAt = job.startedAt || clock();
      job.updatedAt = clock();
    });

    const snapshot = await readDB();
    const job = (snapshot.imageImportJobs || []).find((item) => item.id === jobId);
    if (!job) throw new HttpError(404, "导入任务不存在");
    const source = sourceService.getSource(snapshot, job.sourceId, auth);
    const credential = sourceService.getCredentialForProvider(snapshot, source.id, auth);
    const provider = createAlbumProvider(source);
    const rows = (snapshot.imageImportJobItems || []).filter((item) => item.jobId === job.id);

    await Promise.all(
      rows.map((row) =>
        limit(async () => {
          try {
            const download = await provider.openFileBuffer(source, credential, row.sourcePath);
            const originalName = row.originalName || basenameFromPath(row.sourcePath);
            const mime = download.mime || mimeFromName(originalName);
            const hash = sha256Hex(download.buffer);
            let imageAsset = null;

            await updateDB((draft) => {
              draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
              imageAsset = job.dedupe
                ? draft.imageAssets.find(
                    (item) =>
                      item.ownerId === job.ownerId &&
                      item.sha256 === hash &&
                      item.status === "ready"
                  )
                : null;
            });

            let originalTf = null;
            if (!imageAsset) {
              originalTf = await saveTfBuffer({
                ownerId: job.ownerId,
                category: "photo",
                originalName,
                mime,
                buffer: download.buffer,
                meta: {
                  sourceType: source.providerType,
                  sourceId: source.id,
                  sourcePath: row.sourcePath,
                },
              });

              imageAsset = {
                id: idFactory("img"),
                ownerId: job.ownerId,
                sourceType: source.providerType,
                sourceId: source.id,
                sourcePath: row.sourcePath,
                originalName,
                mime,
                size: Number(download.size || download.buffer.length),
                sha256: hash,
                tfFileId: originalTf.id,
                originalTfFileId: originalTf.id,
                gridId: originalTf.gridId || "",
                thumbnailGridId: "",
                previewGridId: "",
                width: 0,
                height: 0,
                status: "ready",
                createdAt: clock(),
                updatedAt: clock(),
              };
            }

            let e6Asset = null;
            if (job.autoConvert && isImageName(originalName)) {
              const converted = await convertImageBufferToE6P4(download.buffer, { fit: "contain", ditherMode: job.ditherMode, preview: false });
              const previewBuffer = await previewE6Buffer(converted.buffer);
              const e6Tf = await saveTfBuffer({
                ownerId: job.ownerId,
                category: "photo",
                originalName: `${path.parse(originalName).name || imageAsset.id}.e6p4`,
                mime: "application/octet-stream",
                buffer: converted.buffer,
                meta: {
                  imageAssetId: imageAsset.id,
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
                ownerId: job.ownerId,
                category: "photo",
                originalName: `${path.parse(originalName).name || imageAsset.id}.e6-preview.png`,
                mime: "image/png",
                buffer: previewBuffer,
                meta: {
                  imageAssetId: imageAsset.id,
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
              e6Asset = {
                id: idFactory("e6asset"),
                imageId: imageAsset.id,
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
                createdAt: clock(),
                updatedAt: clock(),
              };
            }

            await updateDB((draft) => {
              draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
              draft.e6RenderedAssets = Array.isArray(draft.e6RenderedAssets) ? draft.e6RenderedAssets : [];
              draft.playCollectionItems = Array.isArray(draft.playCollectionItems) ? draft.playCollectionItems : [];
              const existingImage = draft.imageAssets.find((item) => item.id === imageAsset.id);
              if (!existingImage) {
                draft.imageAssets.unshift(imageAsset);
              } else {
                Object.assign(existingImage, imageAsset, { updatedAt: clock() });
              }
              if (e6Asset && !draft.e6RenderedAssets.some((item) => item.binaryTfFileId === e6Asset.binaryTfFileId)) {
                draft.e6RenderedAssets.unshift(e6Asset);
                const targetImage = draft.imageAssets.find((item) => item.id === imageAsset.id);
                if (targetImage) {
                  targetImage.e6AssetId = e6Asset.id;
                  targetImage.e6ConvertStatus = "ready";
                  targetImage.e6ConvertError = "";
                  targetImage.e6DitherMode = e6Asset.ditherMode;
                  targetImage.updatedAt = clock();
                }
              }
              if (job.targetCollectionId) {
                const exists = draft.playCollectionItems.some(
                  (item) => item.collectionId === job.targetCollectionId && item.imageId === imageAsset.id
                );
                if (!exists) {
                  draft.playCollectionItems.push({
                    id: idFactory("coli"),
                    collectionId: job.targetCollectionId,
                    imageId: imageAsset.id,
                    sortOrder: Number(row.sortOrder || 0),
                    durationSec: 0,
                    enabled: true,
                    createdAt: clock(),
                  });
                }
              }
              const draftRow = (draft.imageImportJobItems || []).find((item) => item.id === row.id);
              if (draftRow) {
                draftRow.status = "success";
                draftRow.imageId = imageAsset.id;
                draftRow.updatedAt = clock();
              }
              const draftJob = (draft.imageImportJobs || []).find((item) => item.id === job.id);
              if (draftJob) {
                draftJob.processed = Number(draftJob.processed || 0) + 1;
                draftJob.successCount = Number(draftJob.successCount || 0) + 1;
                draftJob.updatedAt = clock();
              }
            });
          } catch (error) {
            await updateDB((draft) => {
              const draftRow = (draft.imageImportJobItems || []).find((item) => item.id === row.id);
              if (draftRow) {
                draftRow.status = "failed";
                draftRow.error = error?.message || String(error || "导入失败");
                draftRow.updatedAt = clock();
              }
              const draftJob = (draft.imageImportJobs || []).find((item) => item.id === job.id);
              if (draftJob) {
                draftJob.processed = Number(draftJob.processed || 0) + 1;
                draftJob.failureCount = Number(draftJob.failureCount || 0) + 1;
                draftJob.lastError = error?.message || String(error || "导入失败");
                draftJob.updatedAt = clock();
              }
            });
          }
        })
      )
    );

    await updateDB((draft) => {
      const draftJob = (draft.imageImportJobs || []).find((item) => item.id === job.id);
      if (!draftJob) return;
      draftJob.status = Number(draftJob.failureCount || 0) > 0 ? "partial_failed" : "success";
      if (Number(draftJob.successCount || 0) === 0 && Number(draftJob.failureCount || 0) > 0) {
        draftJob.status = "failed";
      }
      draftJob.finishedAt = clock();
      draftJob.updatedAt = clock();
    });
  }

  return {
    createJob,
    getJob,
    processJob,
  };
}

module.exports = {
  createAlbumImportService,
};
