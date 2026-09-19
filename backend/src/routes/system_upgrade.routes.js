const express = require("express");
const multer = require("multer");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { allowRoles } = require("../middleware/auth");
const { logOperation } = require("../utils/logging");
const { verifyAdminPassword, issuePackageBuildToken } = require("../services/system_upgrade_auth.service");
const {
  getRuntimeInfo,
  getConfigInfo,
  saveConfigInfo,
  sourceUpload,
  buildPackageTaskStart,
  uploadStandardPackage,
  startVerifyTask,
  startFetchRemoteTask,
  startInstallTask,
  listPackagesForUI,
  listBuildsForUI,
  listSourceUploadsForUI,
  listHistoryForUI,
  getTaskById,
  getPackageDownloadMeta,
} = require("../services/system_upgrade.service");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

router.get(
  "/runtime",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const data = await getRuntimeInfo();
    return res.success(data, "ok");
  })
);

router.get(
  "/config",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const data = await getConfigInfo();
    return res.success(data, "ok");
  })
);

router.post(
  "/config",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const data = await saveConfigInfo(req.body || {}, {
      userId: req.auth.userId,
      role: req.auth.role,
      username: req.auth.username || "",
    });
    return res.success(data, "配置已更新");
  })
);

router.post(
  "/admin-verify",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    try {
      const password = String(req.body?.password || "");
      const user = await verifyAdminPassword({
        userId: req.auth.userId,
        password,
      });
      const token = await issuePackageBuildToken({
        userId: String(user.id || req.auth.userId || ""),
        username: String(user.username || req.auth.username || ""),
        ttlMs: 5 * 60 * 1000,
      });
      logOperation({
        actorId: req.auth.userId || "system",
        actorRole: req.auth.role || "system",
        action: "system_upgrade.admin_verify_success",
        targetType: "system_upgrade_auth",
        targetId: String(req.auth.userId || ""),
      });
      return res.success(
        {
          packageBuildToken: token.token,
          expireAt: token.expireAt,
          ttlMs: token.ttlMs,
        },
        "管理员二次校验通过"
      );
    } catch (error) {
      logOperation({
        actorId: req.auth.userId || "system",
        actorRole: req.auth.role || "system",
        action: "system_upgrade.admin_verify_failed",
        targetType: "system_upgrade_auth",
        targetId: String(req.auth.userId || ""),
        detail: {
          reason: String(error?.message || "verify failed"),
        },
        status: "failed",
      });
      throw error;
    }
  })
);

router.post(
  "/source-upload",
  allowRoles("admin"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const data = await sourceUpload({
      file: req.file,
      actor: {
        userId: req.auth.userId,
        role: req.auth.role,
        username: req.auth.username || "",
      },
    });
    return res.success(data, "源码压缩包上传并校验成功");
  })
);

router.post(
  "/build-package",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const sourceId = String(req.body?.sourceId || "");
    const packageBuildToken = String(req.body?.packageBuildToken || "");
    if (!sourceId) throw new HttpError(400, "sourceId 不能为空");
    if (!packageBuildToken) throw new HttpError(401, "缺少 packageBuildToken");
    const options = req.body?.options && typeof req.body.options === "object" ? req.body.options : req.body || {};
    const task = await buildPackageTaskStart({
      sourceId,
      packageBuildToken,
      options,
      actor: {
        userId: req.auth.userId,
        role: req.auth.role,
        username: req.auth.username || "",
      },
    });
    return res.success(task, "制作升级包任务已创建");
  })
);

router.get(
  "/build-task/:taskId",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const task = await getTaskById(req.params.taskId);
    return res.success(task, "ok");
  })
);

router.get(
  "/built-packages",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const [items, builds, sources] = await Promise.all([
      listPackagesForUI(120),
      listBuildsForUI(120),
      listSourceUploadsForUI(120),
    ]);
    return res.success(
      {
        packages: items,
        builds,
        sources,
      },
      "ok"
    );
  })
);

router.get(
  "/built-packages/:id/download",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const meta = await getPackageDownloadMeta(req.params.id);
    logOperation({
      actorId: req.auth.userId || "system",
      actorRole: req.auth.role || "system",
      action: "system_upgrade.download_package",
      targetType: "system_upgrade_package",
      targetId: String(meta.id || ""),
      detail: { via: "built-packages" },
    });
    return res.download(meta.filePath, meta.fileName || meta.storedName || `${meta.id}.zip`);
  })
);

router.post(
  "/upload",
  allowRoles("admin"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const meta = await uploadStandardPackage({
      file: req.file,
      actor: {
        userId: req.auth.userId,
        role: req.auth.role,
        username: req.auth.username || "",
      },
    });
    return res.success(meta, "升级包上传成功");
  })
);

router.post(
  "/fetch-remote",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const task = await startFetchRemoteTask({
      actor: {
        userId: req.auth.userId,
        role: req.auth.role,
        username: req.auth.username || "",
      },
      url: String(req.body?.url || ""),
      packageName: String(req.body?.packageName || ""),
    });
    return res.success(task, "远程拉取任务已创建");
  })
);

router.post(
  "/verify/:packageId",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const task = await startVerifyTask({
      packageId: String(req.params.packageId || ""),
      actor: {
        userId: req.auth.userId,
        role: req.auth.role,
        username: req.auth.username || "",
      },
    });
    return res.success(task, "校验任务已创建");
  })
);

router.post(
  "/install/:packageId",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const task = await startInstallTask({
      packageId: String(req.params.packageId || ""),
      actor: {
        userId: req.auth.userId,
        role: req.auth.role,
        username: req.auth.username || "",
      },
    });
    return res.success(task, "安装任务已创建");
  })
);

router.get(
  "/packages",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const rows = await listPackagesForUI(200);
    return res.success(rows, "ok");
  })
);

router.get(
  "/packages/:packageId/download",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const meta = await getPackageDownloadMeta(req.params.packageId);
    logOperation({
      actorId: req.auth.userId || "system",
      actorRole: req.auth.role || "system",
      action: "system_upgrade.download_package",
      targetType: "system_upgrade_package",
      targetId: String(meta.id || ""),
      detail: { via: "packages" },
    });
    return res.download(meta.filePath, meta.fileName || meta.storedName || `${meta.id}.zip`);
  })
);

router.get(
  "/history",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const rows = await listHistoryForUI(260);
    return res.success(rows, "ok");
  })
);

router.get(
  "/task/:taskId",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const task = await getTaskById(req.params.taskId);
    return res.success(task, "ok");
  })
);

module.exports = router;
