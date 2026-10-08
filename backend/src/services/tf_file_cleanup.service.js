const config = require("../config");
const { readDB, updateDB } = require("../db/store");
const { getGridBucket, getMongoDb, ObjectId } = require("../utils/mongo");

const PAGE_TYPES = ["homepage", "badgepage", "weatherpage"];
const PAGE_TYPE_SET = new Set(PAGE_TYPES);
const PAGE_IMAGE_KEYS = ["homepageImages", "badgepageImages", "weatherpageImages"];
const TF_REF_KEYS = new Set([
  "tfFileId",
  "originalTfFileId",
  "thumbnailTfFileId",
  "previewTfFileId",
  "binaryTfFileId",
  "imageFileId",
  "previewFileId",
  "e6PreviewTfFileId",
  "fileId",
  "imageId",
  "image_id",
  "image_key",
  "preview_id",
]);
const TF_REF_ARRAY_KEYS = new Set(["fileIds", "tfFileIds"]);
const ACTIVE_REMOTE_ACK_STATUSES = new Set(["pending", "ack_pending", "running", "processing", "in_progress"]);
const PAGE_CACHE_NAME_RE =
  /^(homepage|badgepage|weatherpage)_(preview_)?(.+)_([0-9]{10,})-[a-f0-9]{8}\.(png|epd4|e6p4)$/i;
const TF_FILE_NAME_PREFIX_RE = /^tf_[0-9a-f]{16}_/i;

function normalizeId(value) {
  return String(value || "").trim();
}

function addId(out, value) {
  const id = normalizeId(value);
  if (id) out.add(id);
}

function normalizeIdSet(input) {
  const out = new Set();
  if (input instanceof Set) {
    input.forEach((item) => addId(out, item));
    return out;
  }
  if (Array.isArray(input)) {
    input.forEach((item) => addId(out, item));
    return out;
  }
  addId(out, input);
  return out;
}

function metadataOf(file = {}) {
  const meta = file.meta && typeof file.meta === "object" && !Array.isArray(file.meta) ? file.meta : {};
  const metadata =
    file.metadata && typeof file.metadata === "object" && !Array.isArray(file.metadata) ? file.metadata : {};
  return { ...metadata, ...meta };
}

function candidateNames(file = {}) {
  const names = [file.originalName, file.name, file.filename, metadataOf(file).originalName]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const out = [];
  names.forEach((name) => {
    const normalized = name.replace(/\\/g, "/").split("/").pop() || name;
    out.push(normalized);
    out.push(normalized.replace(TF_FILE_NAME_PREFIX_RE, ""));
  });
  return [...new Set(out.filter(Boolean))];
}

function parsePageCacheName(file = {}) {
  for (const name of candidateNames(file)) {
    const match = PAGE_CACHE_NAME_RE.exec(name);
    if (match) {
      return {
        pageType: String(match[1] || "").toLowerCase(),
        preview: Boolean(match[2]),
        extension: String(match[5] || "").toLowerCase(),
        name,
      };
    }
  }
  return null;
}

function isPreviewLike(file, parsed) {
  const category = String(file?.category || metadataOf(file).category || "").toLowerCase();
  const mime = String(file?.mime || file?.contentType || "").toLowerCase();
  return parsed.preview && (category === "photo" || mime === "image/png" || parsed.extension === "png");
}

function isBinaryLike(file, parsed) {
  const category = String(file?.category || metadataOf(file).category || "").toLowerCase();
  const mime = String(file?.mime || file?.contentType || "").toLowerCase();
  return (
    !parsed.preview &&
    (category === "background" ||
      mime === "application/x-epd4" ||
      mime === "application/x-e6p4" ||
      parsed.extension === "epd4" ||
      parsed.extension === "e6p4")
  );
}

function pageSourceOf(file = {}) {
  const meta = metadataOf(file);
  return String(file.source || file.pageType || meta.source || meta.pageType || "").trim().toLowerCase();
}

function isSystemPageCacheTfFile(file = {}) {
  const parsed = parsePageCacheName(file);
  const source = pageSourceOf(file);
  const generatedBy = String(file.generatedBy || metadataOf(file).generatedBy || "").trim().toLowerCase();

  if (PAGE_TYPE_SET.has(source)) {
    if (!parsed) return generatedBy === "page-render";
    return source === parsed.pageType && (isPreviewLike(file, parsed) || isBinaryLike(file, parsed));
  }

  if (!parsed) return false;
  return isPreviewLike(file, parsed) || isBinaryLike(file, parsed);
}

function isSystemPageCacheGridFile(fileDoc = {}) {
  const meta = metadataOf(fileDoc);
  const source = String(meta.source || meta.pageType || fileDoc.source || "").trim().toLowerCase();
  if (!PAGE_TYPE_SET.has(source)) return false;

  const parsed = parsePageCacheName({
    originalName: meta.originalName,
    name: fileDoc.filename,
    filename: fileDoc.filename,
    category: meta.category,
    mime: fileDoc.contentType,
    metadata: meta,
  });
  if (!parsed) return true;
  return source === parsed.pageType;
}

function collectIdsFromObject(value, out, depth = 0) {
  if (!value || depth > 8) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectIdsFromObject(item, out, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  Object.entries(value).forEach(([key, child]) => {
    if (TF_REF_KEYS.has(key)) {
      addId(out, child);
      return;
    }
    if (TF_REF_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      child.forEach((item) => addId(out, item));
      return;
    }
    if (child && typeof child === "object") {
      collectIdsFromObject(child, out, depth + 1);
    }
  });
}

function collectPageImageFileIds(rows = []) {
  const out = new Set();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    addId(out, row?.imageFileId);
    addId(out, row?.previewFileId);
  });
  return [...out];
}

function collectReferencedTfFileIds(state = {}) {
  const out = new Set();

  PAGE_IMAGE_KEYS.forEach((key) => {
    (Array.isArray(state[key]) ? state[key] : []).forEach((row) => {
      addId(out, row?.imageFileId);
      addId(out, row?.previewFileId);
    });
  });

  (Array.isArray(state.imageAssets) ? state.imageAssets : []).forEach((row) => collectIdsFromObject(row, out));
  (Array.isArray(state.e6RenderedAssets) ? state.e6RenderedAssets : []).forEach((row) =>
    collectIdsFromObject(row, out)
  );
  (Array.isArray(state.remoteCommandAcks) ? state.remoteCommandAcks : [])
    .filter((row) => ACTIVE_REMOTE_ACK_STATUSES.has(String(row?.status || "pending").toLowerCase()))
    .forEach((row) => collectIdsFromObject(row, out));

  return out;
}

function normalizeMaxVersions(maxVersions) {
  const value = Math.floor(Number(maxVersions || 3));
  if (!Number.isFinite(value) || value < 1) return 3;
  return value;
}

function prunePageImageHistoryInDraft({ draft, imageKey, deviceId, maxVersions }) {
  const key = String(imageKey || "").trim();
  const targetDeviceId = normalizeId(deviceId);
  if (!key || !targetDeviceId) {
    return { removedRows: [], candidateFileIds: [] };
  }

  draft[key] = Array.isArray(draft[key]) ? draft[key] : [];
  const limit = normalizeMaxVersions(maxVersions);
  const keep = new Set();
  let seenForDevice = 0;

  draft[key].forEach((row) => {
    if (normalizeId(row?.deviceId) !== targetDeviceId) return;
    seenForDevice += 1;
    if (seenForDevice <= limit) {
      addId(keep, row?.id);
    }
  });

  const removedRows = [];
  draft[key] = draft[key].filter((row) => {
    if (normalizeId(row?.deviceId) !== targetDeviceId) return true;
    if (keep.has(normalizeId(row?.id))) return true;
    removedRows.push(row);
    return false;
  });

  return {
    removedRows,
    candidateFileIds: collectPageImageFileIds(removedRows),
  };
}

function isOldEnough(file = {}, now = new Date(), minAgeMs = 0) {
  const ageMs = Math.max(0, Number(minAgeMs || 0));
  if (ageMs <= 0) return true;
  const raw = file.createdAt || file.updatedAt || file.uploadDate || "";
  const ts = Date.parse(String(raw || ""));
  if (!Number.isFinite(ts)) return false;
  return ts <= now.getTime() - ageMs;
}

function toObjectId(value) {
  const raw = normalizeId(value);
  if (!raw) return null;
  try {
    return new ObjectId(raw);
  } catch (_) {
    return null;
  }
}

function buildDeleteJob(file = {}) {
  return {
    id: normalizeId(file.id),
    gridId: normalizeId(file.gridId || file._id),
    name: String(file.name || file.filename || ""),
    originalName: String(file.originalName || metadataOf(file).originalName || ""),
  };
}

function cleanupUnusedPageCacheFilesInDraft(draft, options = {}) {
  draft.tfFiles = Array.isArray(draft.tfFiles) ? draft.tfFiles : [];
  const candidateSet = normalizeIdSet(options.candidateFileIds || []);
  const restrictToCandidates = candidateSet.size > 0;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const minAgeMs = Math.max(0, Number(options.minAgeMs || 0));
  const referencedIds = collectReferencedTfFileIds(draft);
  const removedFiles = [];
  const deleteJobs = [];

  draft.tfFiles = draft.tfFiles.filter((file) => {
    const id = normalizeId(file?.id);
    if (!id) return true;
    if (restrictToCandidates && !candidateSet.has(id)) return true;
    if (referencedIds.has(id)) return true;
    if (!isSystemPageCacheTfFile(file)) return true;
    if (!isOldEnough(file, now, minAgeMs)) return true;

    removedFiles.push(file);
    deleteJobs.push(buildDeleteJob(file));
    return false;
  });

  return {
    removedCount: removedFiles.length,
    removedFileIds: removedFiles.map((file) => normalizeId(file.id)).filter(Boolean),
    removedFiles,
    deleteJobs,
  };
}

async function deleteGridObjects(deleteJobs = [], options = {}) {
  const logger = options.logger || console;
  const uniqueJobs = [];
  const seenGridIds = new Set();
  (Array.isArray(deleteJobs) ? deleteJobs : []).forEach((job) => {
    const gridId = normalizeId(job?.gridId);
    if (!gridId || seenGridIds.has(gridId)) return;
    seenGridIds.add(gridId);
    uniqueJobs.push({ ...job, gridId });
  });

  const summary = {
    requested: uniqueJobs.length,
    deleted: 0,
    skippedInvalid: 0,
    failed: 0,
    failedJobs: [],
  };
  if (!uniqueJobs.length) return summary;

  const bucket = options.bucket || (await getGridBucket(options.bucketName || "tf_files"));
  for (const job of uniqueJobs) {
    const objectId = toObjectId(job.gridId);
    if (!objectId) {
      summary.skippedInvalid += 1;
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await bucket.delete(objectId);
      summary.deleted += 1;
    } catch (error) {
      summary.failed += 1;
      summary.failedJobs.push({
        ...job,
        error: String(error?.message || error),
      });
      if (logger && typeof logger.warn === "function") {
        logger.warn(`[tf-cleanup] GridFS delete failed gridId=${job.gridId}: ${String(error?.message || error)}`);
      }
    }
  }
  return summary;
}

function scheduleGridFileDeletion(deleteJobs = [], options = {}) {
  const jobs = Array.isArray(deleteJobs) ? deleteJobs.filter((job) => job && job.gridId) : [];
  if (!jobs.length) {
    return { scheduled: false, count: 0 };
  }
  const logger = options.logger || console;
  const run = () => {
    deleteGridObjects(jobs, options).catch((error) => {
      if (logger && typeof logger.warn === "function") {
        logger.warn(`[tf-cleanup] async GridFS cleanup failed: ${String(error?.message || error)}`);
      }
    });
  };
  if (typeof setImmediate === "function") {
    setImmediate(run);
  } else {
    Promise.resolve().then(run);
  }
  return { scheduled: true, count: jobs.length };
}

function cleanupPolicy() {
  const raw = config.tfCleanup || {};
  return {
    enabled: raw.enabled !== false,
    intervalMs: Math.max(60 * 1000, Number(raw.intervalMs || 60 * 60 * 1000)),
    orphanMinAgeMs: Math.max(0, Number(raw.orphanMinAgeMs || 10 * 60 * 1000)),
    maxGridOrphansPerRun: Math.max(1, Number(raw.maxGridOrphansPerRun || 500)),
  };
}

async function cleanupOrphanPageCacheGridFiles(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const policy = cleanupPolicy();
  const minAgeMs = Math.max(0, Number(options.minAgeMs ?? policy.orphanMinAgeMs));
  const limit = Math.max(1, Number(options.limit || policy.maxGridOrphansPerRun));
  const dbState = options.dbState || (await readDB());
  const liveGridIds = new Set(
    (Array.isArray(dbState.tfFiles) ? dbState.tfFiles : [])
      .map((file) => normalizeId(file.gridId))
      .filter(Boolean)
  );
  const collection =
    options.filesCollection ||
    (options.mongoDb || (await getMongoDb())).collection(`${options.bucketName || "tf_files"}.files`);
  const cutoff = new Date(now.getTime() - minAgeMs);
  const docs = await collection
    .find({
      uploadDate: { $lte: cutoff },
      "metadata.source": { $in: PAGE_TYPES },
    })
    .limit(limit)
    .toArray();
  const deleteJobs = docs
    .filter((doc) => isSystemPageCacheGridFile(doc))
    .filter((doc) => !liveGridIds.has(normalizeId(doc._id)))
    .map((doc) => ({
      id: "",
      gridId: normalizeId(doc._id),
      name: String(doc.filename || ""),
      originalName: String(metadataOf(doc).originalName || ""),
    }));
  const deleteSummary = await deleteGridObjects(deleteJobs, options);
  return {
    scanned: docs.length,
    orphanCount: deleteJobs.length,
    deleteJobs,
    deleteSummary,
  };
}

async function runTfFileCleanupSchedulerTick(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const policy = cleanupPolicy();
  const minAgeMs = Math.max(0, Number(options.minAgeMs ?? policy.orphanMinAgeMs));
  let dbCleanup = { removedCount: 0, removedFileIds: [], deleteJobs: [] };

  await updateDB((draft) => {
    dbCleanup = cleanupUnusedPageCacheFilesInDraft(draft, {
      minAgeMs,
      now,
    });
  });

  const gridDeleteSummary = await deleteGridObjects(dbCleanup.deleteJobs, options);
  let orphanGridCleanup = null;
  try {
    orphanGridCleanup = await cleanupOrphanPageCacheGridFiles({
      ...options,
      minAgeMs,
      now,
    });
  } catch (error) {
    const logger = options.logger || console;
    orphanGridCleanup = {
      failed: true,
      error: String(error?.message || error),
    };
    if (logger && typeof logger.warn === "function") {
      logger.warn(`[tf-cleanup] orphan GridFS cleanup failed: ${String(error?.message || error)}`);
    }
  }

  return {
    tickAt: now.toISOString(),
    dbRemovedCount: dbCleanup.removedCount,
    dbRemovedFileIds: dbCleanup.removedFileIds,
    gridDeleteSummary,
    orphanGridCleanup,
  };
}

function getTfFileCleanupSchedulerRuntime() {
  const state = global.__tfFileCleanupScheduler || null;
  if (!state) {
    return {
      started: false,
      enabled: cleanupPolicy().enabled,
      intervalMs: 0,
      startedAt: "",
      lastTickAt: "",
      running: false,
      lastTickResult: null,
    };
  }
  return {
    started: true,
    enabled: Boolean(state.enabled),
    intervalMs: Number(state.intervalMs || 0),
    startedAt: String(state.startedAt || ""),
    lastTickAt: String(state.lastTickAt || ""),
    running: Boolean(state.running),
    lastTickResult: state.lastTickResult || null,
  };
}

function startTfFileCleanupScheduler() {
  if (global.__tfFileCleanupScheduler) return global.__tfFileCleanupScheduler;
  const policy = cleanupPolicy();
  const state = {
    enabled: Boolean(policy.enabled),
    startedAt: new Date().toISOString(),
    intervalMs: policy.intervalMs,
    timer: null,
    running: false,
    lastTickAt: "",
    lastTickResult: null,
  };
  global.__tfFileCleanupScheduler = state;

  if (!policy.enabled) {
    // eslint-disable-next-line no-console
    console.info("[tf-cleanup] scheduler disabled");
    return state;
  }

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    state.lastTickAt = new Date().toISOString();
    try {
      state.lastTickResult = await runTfFileCleanupSchedulerTick();
    } catch (error) {
      state.lastTickResult = {
        failed: true,
        error: String(error?.message || error),
      };
      // eslint-disable-next-line no-console
      console.warn(`[tf-cleanup] tick failed: ${String(error?.message || error)}`);
    } finally {
      state.running = false;
    }
  };

  tick().catch((error) => {
    // eslint-disable-next-line no-console
    console.warn(`[tf-cleanup] initial tick failed: ${String(error?.message || error)}`);
  });

  state.timer = setInterval(() => {
    tick().catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(`[tf-cleanup] scheduler tick crash: ${String(error?.message || error)}`);
    });
  }, policy.intervalMs);
  if (typeof state.timer.unref === "function") {
    state.timer.unref();
  }
  // eslint-disable-next-line no-console
  console.info(`[tf-cleanup] scheduler started intervalMs=${policy.intervalMs}`);
  return state;
}

function stopTfFileCleanupScheduler() {
  const state = global.__tfFileCleanupScheduler;
  if (state?.timer) clearInterval(state.timer);
  delete global.__tfFileCleanupScheduler;
}

module.exports = {
  PAGE_TYPES,
  PAGE_IMAGE_KEYS,
  collectPageImageFileIds,
  collectReferencedTfFileIds,
  prunePageImageHistoryInDraft,
  cleanupUnusedPageCacheFilesInDraft,
  deleteGridObjects,
  scheduleGridFileDeletion,
  cleanupOrphanPageCacheGridFiles,
  runTfFileCleanupSchedulerTick,
  startTfFileCleanupScheduler,
  stopTfFileCleanupScheduler,
  getTfFileCleanupSchedulerRuntime,
  isSystemPageCacheTfFile,
  isSystemPageCacheGridFile,
};
