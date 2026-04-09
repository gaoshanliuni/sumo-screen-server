const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");

const router = express.Router();
router.use(allowRoles("admin"));

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SAFE_DIRS = [
  { dir: path.join(REPO_ROOT, "log"), source: "repo/log" },
  { dir: path.join(REPO_ROOT, "logs"), source: "repo/logs" },
  { dir: path.join(REPO_ROOT, "backend", "logs"), source: "backend/logs" },
  { dir: path.join(REPO_ROOT, "docs", "epd4_backend_dump"), source: "docs/epd4_backend_dump" },
  { dir: path.join(REPO_ROOT, "docs", "epd4_samples"), source: "docs/epd4_samples" },
];

const ROOT_FILE_PATTERNS = [
  /^serial_.*\.log$/i,
  /^live_serial\.log$/i,
  /^backend_.*\.log$/i,
  /^backend_.*\.err\.log$/i,
  /^backend_.*\.stdout\.log$/i,
  /^backend_.*\.stderr\.log$/i,
  /^server\.out\.log$/i,
  /^after_fix_boot\.log$/i,
  /^autostart_check\.log$/i,
  /^rolling_boot\.log$/i,
  /^now_boot\.log$/i,
  /^joint_result_.*\.json$/i,
  /^tmp_.*\.(log|txt|json|png|jpg|jpeg|webp|ps1)$/i,
];

function parseTimeMs(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const ms = Date.parse(String(value));
  if (Number.isNaN(ms)) {
    throw new HttpError(400, `${fieldName} 不是合法时间`);
  }
  return ms;
}

function inTimeRange(ms, startMs, endMs) {
  if (!Number.isFinite(ms)) return false;
  if (startMs != null && ms < startMs) return false;
  if (endMs != null && ms > endMs) return false;
  return true;
}

function logTimeMs(row) {
  if (!row || typeof row !== "object") return NaN;
  const raw = row.createdAt || row.updatedAt || "";
  const ms = Date.parse(String(raw));
  return ms;
}

function shouldDeleteByMode(mode, tsMs, startMs, endMs) {
  if (mode === "all") return true;
  return inTimeRange(tsMs, startMs, endMs);
}

async function collectFilesFromDir(baseDir, source, acc) {
  let entries = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      await collectFilesFromDir(fullPath, source, acc);
      continue;
    }
    if (!entry.isFile()) continue;

    try {
      const st = await fs.stat(fullPath);
      acc.push({
        path: fullPath,
        name: entry.name,
        source,
        size: Number(st.size || 0),
        mtimeMs: Number(st.mtimeMs || 0),
      });
    } catch (_) {
      // ignore stat errors
    }
  }
}

async function collectCleanupFileCandidates() {
  const map = new Map();

  try {
    const rootEntries = await fs.readdir(REPO_ROOT, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!ROOT_FILE_PATTERNS.some((re) => re.test(name))) continue;
      const fullPath = path.join(REPO_ROOT, name);
      try {
        const st = await fs.stat(fullPath);
        map.set(fullPath, {
          path: fullPath,
          name,
          source: "repo/root",
          size: Number(st.size || 0),
          mtimeMs: Number(st.mtimeMs || 0),
        });
      } catch (_) {
        // ignore stat errors
      }
    }
  } catch (_) {
    // ignore root scan failures
  }

  const nested = [];
  for (const item of SAFE_DIRS) {
    await collectFilesFromDir(item.dir, item.source, nested);
  }
  for (const row of nested) {
    map.set(row.path, row);
  }

  return Array.from(map.values());
}

async function cleanupFiles({ mode, startMs, endMs, dryRun }) {
  const candidates = await collectCleanupFileCandidates();
  const selected = candidates.filter((item) => shouldDeleteByMode(mode, item.mtimeMs, startMs, endMs));

  const summary = {
    scanned: candidates.length,
    selected: selected.length,
    removed: 0,
    failed: 0,
    scannedBytes: candidates.reduce((sum, item) => sum + (item.size || 0), 0),
    selectedBytes: selected.reduce((sum, item) => sum + (item.size || 0), 0),
    removedBytes: 0,
    failedItems: [],
    sample: selected.slice(0, 20).map((item) => ({
      name: item.name,
      source: item.source,
      size: item.size,
      mtime: item.mtimeMs ? new Date(item.mtimeMs).toISOString() : "",
    })),
  };

  if (dryRun) return summary;

  for (const item of selected) {
    try {
      await fs.unlink(item.path);
      summary.removed += 1;
      summary.removedBytes += item.size || 0;
    } catch (error) {
      summary.failed += 1;
      if (summary.failedItems.length < 20) {
        summary.failedItems.push({
          path: item.path,
          error: error && error.message ? error.message : String(error),
        });
      }
    }
  }

  return summary;
}

router.get(
  "/operations",
  asyncHandler(async (req, res) => {
    const { action, targetType, status, actorId, keyword, limit = 200 } = req.query || {};
    const db = await readDB();
    let list = db.operationLogs;

    if (action) list = list.filter((item) => item.action === action);
    if (targetType) list = list.filter((item) => item.targetType === targetType);
    if (status) list = list.filter((item) => item.status === status);
    if (actorId) list = list.filter((item) => item.actorId === actorId);
    if (keyword) {
      const text = String(keyword).toLowerCase();
      list = list.filter(
        (item) =>
          item.action.toLowerCase().includes(text) ||
          item.targetId.toLowerCase().includes(text) ||
          JSON.stringify(item.detail || {}).toLowerCase().includes(text)
      );
    }

    list = list.slice(0, Number(limit));
    res.success(list, "ok");
  })
);

router.get(
  "/apis",
  asyncHandler(async (req, res) => {
    const { templateSlug, success, deviceId, limit = 300 } = req.query || {};
    const db = await readDB();
    let list = db.apiLogs;

    if (templateSlug) list = list.filter((item) => item.templateSlug === templateSlug);
    if (deviceId) list = list.filter((item) => item.deviceId === deviceId);
    if (success !== undefined) {
      const expectSuccess = String(success) === "true";
      list = list.filter((item) => item.success === expectSuccess);
    }

    list = list.slice(0, Number(limit));
    res.success(list, "ok");
  })
);

router.post(
  "/cleanup",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const mode = String(body.mode || "range").toLowerCase();
    if (!["all", "range"].includes(mode)) {
      throw new HttpError(400, "mode 仅支持 all/range");
    }

    const startMs = parseTimeMs(body.startAt, "startAt");
    const endMs = parseTimeMs(body.endAt, "endAt");
    if (mode === "range" && (startMs == null || endMs == null)) {
      throw new HttpError(400, "range 模式必须提供 startAt 和 endAt");
    }
    if (startMs != null && endMs != null && startMs > endMs) {
      throw new HttpError(400, "startAt 不能晚于 endAt");
    }

    const includeOperationLogs = body.includeOperationLogs !== false;
    const includeApiLogs = body.includeApiLogs !== false;
    const includeFiles = body.includeFiles !== false;
    const dryRun = body.dryRun === true;

    let dbSummary = {
      operationRemoved: 0,
      apiRemoved: 0,
      operationRemain: 0,
      apiRemain: 0,
    };

    if (includeOperationLogs || includeApiLogs) {
      if (dryRun) {
        const db = await readDB();
        const operationBefore = Array.isArray(db.operationLogs) ? db.operationLogs.length : 0;
        const apiBefore = Array.isArray(db.apiLogs) ? db.apiLogs.length : 0;
        const operationRemain = includeOperationLogs
          ? (db.operationLogs || []).filter((item) => !shouldDeleteByMode(mode, logTimeMs(item), startMs, endMs)).length
          : operationBefore;
        const apiRemain = includeApiLogs
          ? (db.apiLogs || []).filter((item) => !shouldDeleteByMode(mode, logTimeMs(item), startMs, endMs)).length
          : apiBefore;
        dbSummary = {
          operationRemoved: includeOperationLogs ? operationBefore - operationRemain : 0,
          apiRemoved: includeApiLogs ? apiBefore - apiRemain : 0,
          operationRemain,
          apiRemain,
        };
      } else {
        dbSummary = await updateDB((db) => {
        let operationRemoved = 0;
        let apiRemoved = 0;

        if (includeOperationLogs) {
          const before = Array.isArray(db.operationLogs) ? db.operationLogs.length : 0;
          if (mode === "all") {
            if (!dryRun) db.operationLogs = [];
            operationRemoved = before;
          } else {
            const next = (db.operationLogs || []).filter((item) => !shouldDeleteByMode(mode, logTimeMs(item), startMs, endMs));
            operationRemoved = before - next.length;
            if (!dryRun) db.operationLogs = next;
          }
        }

        if (includeApiLogs) {
          const before = Array.isArray(db.apiLogs) ? db.apiLogs.length : 0;
          if (mode === "all") {
            if (!dryRun) db.apiLogs = [];
            apiRemoved = before;
          } else {
            const next = (db.apiLogs || []).filter((item) => !shouldDeleteByMode(mode, logTimeMs(item), startMs, endMs));
            apiRemoved = before - next.length;
            if (!dryRun) db.apiLogs = next;
          }
        }

        return {
          operationRemoved,
          apiRemoved,
          operationRemain: Array.isArray(db.operationLogs) ? db.operationLogs.length : 0,
          apiRemain: Array.isArray(db.apiLogs) ? db.apiLogs.length : 0,
        };
      });
      }
    }

    const fileSummary = includeFiles
      ? await cleanupFiles({ mode, startMs, endMs, dryRun })
      : {
          scanned: 0,
          selected: 0,
          removed: 0,
          failed: 0,
          scannedBytes: 0,
          selectedBytes: 0,
          removedBytes: 0,
          failedItems: [],
          sample: [],
        };

    res.success(
      {
        mode,
        dryRun,
        range: {
          startAt: startMs != null ? new Date(startMs).toISOString() : "",
          endAt: endMs != null ? new Date(endMs).toISOString() : "",
        },
        db: dbSummary,
        files: fileSummary,
      },
      dryRun ? "清理预览完成" : "清理完成"
    );
  })
);

module.exports = router;
