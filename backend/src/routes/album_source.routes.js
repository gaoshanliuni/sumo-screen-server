const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDBOptimistic } = require("../db/store");
const { createAlbumSourceService } = require("../services/album/album_source.service");
const { createAlbumProvider } = require("../services/album/provider_registry.service");

const router = express.Router();
router.use(allowRoles("admin", "user"));

const sourceService = createAlbumSourceService();

function buildImportedMap(db, sourceId, auth = {}) {
  const ownerId = String(auth.userId || "");
  const isAdmin = auth.role === "admin";
  const map = new Map();
  (db.imageAssets || [])
    .filter((item) => item.sourceId === sourceId && item.sourcePath && (isAdmin || String(item.ownerId || "") === ownerId))
    .forEach((item) => {
      map.set(item.sourcePath, item);
    });
  return map;
}

async function sendSourceFile(req, res, mode) {
  const db = await readDB();
  const source = sourceService.getSource(db, req.params.id, req.auth);
  const credential = sourceService.getCredentialForProvider(db, source.id, req.auth);
  const provider = createAlbumProvider(source);
  const filePath = String(req.query.path || source.rootPath || "/");
  const result = await provider.openFileBuffer(source, credential, filePath, { mode });
  if (!result?.buffer) throw new HttpError(404, "文件不存在");
  res.setHeader("Content-Type", result.mime || "application/octet-stream");
  res.setHeader("Cache-Control", `private, max-age=${Number(source.config?.thumbnailCacheSec || 3600)}`);
  return res.send(result.buffer);
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(sourceService.listSources(db, req.auth), "ok");
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    let created = null;
    await updateDBOptimistic((draft) => {
      created = sourceService.createSource(draft, req.auth, req.body || {});
    });
    res.success(created, "相册来源已创建", 201);
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const source = sourceService.getSource(db, req.params.id, req.auth);
    res.success(sourceService.redactSource(source, (db.albumSourceCredentials || []).find((item) => item.sourceId === source.id)), "ok");
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    let updated = null;
    await updateDBOptimistic((draft) => {
      updated = sourceService.patchSource(draft, req.auth, req.params.id, req.body || {});
    });
    res.success(updated, "相册来源已更新");
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    let result = null;
    await updateDBOptimistic((draft) => {
      result = sourceService.deleteSource(draft, req.auth, req.params.id);
    });
    res.success(result, "相册来源已删除");
  })
);

router.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const source = sourceService.getWritableSource(db, req.params.id, req.auth);
    const credential = sourceService.getCredentialForProvider(db, source.id, req.auth);
    const provider = createAlbumProvider(source);
    try {
      const output = await provider.testConnection(source, credential);
      let updated = null;
      await updateDBOptimistic((draft) => {
        updated = sourceService.markTestResult(draft, req.auth, source.id, "success", output.message || "连接成功");
      });
      res.success(updated, output.message || "连接成功");
    } catch (error) {
      let updated = null;
      await updateDBOptimistic((draft) => {
        updated = sourceService.markTestResult(draft, req.auth, source.id, "failed", error?.message || "连接失败");
      });
      res.status(error instanceof HttpError ? error.status : 502).json({
        code: error instanceof HttpError ? error.status : 502,
        msg: error?.message || "连接失败",
        data: updated,
      });
    }
  })
);

router.get(
  "/:id/browse",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const source = sourceService.getSource(db, req.params.id, req.auth);
    const credential = sourceService.getCredentialForProvider(db, source.id, req.auth);
    const provider = createAlbumProvider(source);
    const output = await provider.listDir(source, credential, String(req.query.path || source.rootPath || "/"), {
      page: req.query.page,
      pageSize: req.query.pageSize,
      refresh: req.query.refresh === "1" || req.query.refresh === "true",
      importedMap: buildImportedMap(db, source.id, req.auth),
    });
    res.success(output, "ok");
  })
);

router.get(
  "/:id/thumbnail",
  asyncHandler(async (req, res) => sendSourceFile(req, res, "thumbnail"))
);

router.get(
  "/:id/preview",
  asyncHandler(async (req, res) => sendSourceFile(req, res, "preview"))
);

module.exports = router;
