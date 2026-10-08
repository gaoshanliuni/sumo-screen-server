const fs = require("fs/promises");
const path = require("path");
const AdmZip = require("adm-zip");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { logOperation } = require("../utils/logging");
const {
  PATHS,
  ensureUpgradeRuntime,
  readUpgradeConfig,
  saveSourceUpload,
  getSourceUpload,
  savePackageMeta,
  saveBuildMeta,
  appendHistory,
  exists,
} = require("./system_upgrade_storage.service");
const { readSystemRelease } = require("./system_upgrade_env.service");
const {
  inspectSourceZip,
  extractZipSafe,
  computeChecksumsForDir,
  buildManifestForPackage,
  signManifestChecksums,
  inspectStandardUpgradePackage,
  normalizeZipEntryName,
  sha256Hex,
} = require("./system_upgrade_package.service");

function sanitizeFilename(input = "", fallback = "upload.zip") {
  const base = String(input || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return base || fallback;
}

async function ensureCleanDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true });
  await fs.mkdir(dirPath, { recursive: true });
}

async function saveUploadedSourceZip({ file, actor = {} }) {
  await ensureUpgradeRuntime();
  if (!file || !file.buffer) {
    throw new HttpError(400, "请上传源码压缩包");
  }
  const cfg = await readUpgradeConfig();
  const maxSourceBytes = Math.max(10 * 1024 * 1024, Number(cfg.maxSourceBytes || 1024 * 1024 * 1024));
  if (Number(file.size || file.buffer.length || 0) > maxSourceBytes) {
    throw new HttpError(400, `源码压缩包超过限制，最大 ${Math.floor(maxSourceBytes / 1024 / 1024)}MB`);
  }

  const sourceId = createId("susrc");
  const safeName = sanitizeFilename(file.originalname, `${sourceId}.zip`);
  const storedName = `${sourceId}_${safeName}`;
  const storedPath = path.join(PATHS.downloads, storedName);
  await fs.mkdir(PATHS.downloads, { recursive: true });
  await fs.writeFile(storedPath, file.buffer);

  const inspect = await inspectSourceZip(storedPath, cfg);
  const meta = {
    id: sourceId,
    kind: "source_zip",
    originalName: String(file.originalname || ""),
    fileName: safeName,
    storedName,
    filePath: storedPath,
    size: Number(file.size || file.buffer.length || 0),
    sha256: sha256Hex(file.buffer),
    valid: Boolean(inspect.valid),
    inspect,
    uploadedBy: {
      userId: String(actor.userId || ""),
      role: String(actor.role || ""),
      username: String(actor.username || ""),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveSourceUpload(meta);
  await appendHistory("source_upload", meta);
  logOperation({
    actorId: actor.userId || "system",
    actorRole: actor.role || "system",
    action: inspect.valid ? "system_upgrade.source_upload" : "system_upgrade.source_upload_reject",
    targetType: "system_upgrade_source",
    targetId: sourceId,
    detail: {
      fileName: safeName,
      valid: Boolean(inspect.valid),
      rejectReason: String(inspect.rejectReason || ""),
    },
    status: inspect.valid ? "success" : "failed",
  });

  if (!inspect.valid) {
    throw new HttpError(400, inspect.rejectReason || "源码压缩包校验失败", {
      sourceId,
      inspect,
    });
  }

  return meta;
}

async function writeSignatureFile(signatureFile, payload = {}) {
  await fs.writeFile(signatureFile, JSON.stringify(payload, null, 2), "utf8");
}

async function createUpgradePackageFromSource({
  sourceId = "",
  options = {},
  actor = {},
  taskId = "",
  progress = async () => {},
}) {
  await ensureUpgradeRuntime();
  const cfg = await readUpgradeConfig();
  const release = await readSystemRelease();
  const source = await getSourceUpload(sourceId);
  if (!source) {
    throw new HttpError(404, "源码压缩包不存在，请重新上传");
  }
  if (!source.valid) {
    throw new HttpError(400, "源码压缩包校验未通过，不能用于制作升级包");
  }
  if (!(await exists(source.filePath))) {
    throw new HttpError(404, "源码压缩包文件已不存在");
  }

  const workRoot = path.join(PATHS.tmp, `build_${taskId || createId("subuild")}`);
  const sourceExtractRoot = path.join(workRoot, "source");
  const packageStageRoot = path.join(workRoot, "package_stage");
  const payloadRoot = path.join(packageStageRoot, "payload");
  const payloadProjectRoot = path.join(payloadRoot, "dachicunhouduan");
  await progress(5, "准备临时目录");
  await ensureCleanDir(workRoot);

  await progress(12, "解压源码包");
  await extractZipSafe(source.filePath, sourceExtractRoot, cfg);

  const projectRoot = path.join(sourceExtractRoot, "dachicunhouduan");
  const backendDir = path.join(projectRoot, "backend");
  const frontendDir = path.join(projectRoot, "frontend-vue");
  const hasBackend = await exists(backendDir);
  const hasFrontend = await exists(frontendDir);
  if (!hasBackend || !hasFrontend) {
    throw new HttpError(400, "源码包不兼容：缺少 dachicunhouduan/backend 或 dachicunhouduan/frontend-vue");
  }

  await progress(20, "整理 payload");
  await fs.mkdir(payloadRoot, { recursive: true });
  await fs.cp(projectRoot, payloadProjectRoot, { recursive: true, errorOnExist: false });

  await progress(35, "生成 manifest");
  const manifest = buildManifestForPackage(
    {
      ...options,
      buildTime: options.buildTime || new Date().toISOString(),
      buildId: String(options.buildId || createId("build")),
      createdBy: String(options.createdBy || actor.username || actor.userId || "admin"),
      sourceRelease: String(options.sourceRelease || release.version || ""),
    },
    cfg,
    release
  );

  const requiredVersion = String(manifest.version || "").trim();
  if (!requiredVersion) {
    throw new HttpError(400, "version 不能为空");
  }

  await fs.mkdir(packageStageRoot, { recursive: true });
  const manifestFile = path.join(packageStageRoot, "upgrade-manifest.json");
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf8");

  await progress(50, "计算 checksums");
  const checksumsFiles = await computeChecksumsForDir(payloadRoot);
  const checksumsObj = {
    files: checksumsFiles,
    generatedAt: new Date().toISOString(),
  };
  const checksumsFile = path.join(packageStageRoot, "checksums.json");
  await fs.writeFile(checksumsFile, JSON.stringify(checksumsObj, null, 2), "utf8");

  await progress(62, "生成签名");
  const signatureFile = path.join(packageStageRoot, "signature.sig");
  let signatureState = {
    signed: false,
    algorithm: "ed25519",
    reason: "unsigned_dev",
  };
  const forceSigned = Boolean(options.signAsOfficial);
  const needSignForStable =
    Boolean(cfg?.packageRules?.requireSignatureForStable) &&
    !Boolean(manifest.developerOnly) &&
    String(manifest.channel || "").toLowerCase() !== "dev";
  if (forceSigned || needSignForStable) {
    const signature = await signManifestChecksums(manifest, checksumsObj, cfg);
    signatureState = {
      signed: true,
      algorithm: "ed25519",
      reason: "ok",
    };
    await writeSignatureFile(signatureFile, {
      algorithm: "ed25519",
      signature,
      createdAt: new Date().toISOString(),
    });
  } else {
    await writeSignatureFile(signatureFile, {
      algorithm: "ed25519",
      signature: "",
      createdAt: new Date().toISOString(),
      unsigned: true,
      reason: "developer_or_config_relaxed",
    });
  }

  await progress(76, "打包 zip");
  const packageId = createId("supkg");
  const packageName = sanitizeFilename(
    `upgrade_${manifest.version}_${manifest.channel}_${manifest.buildId || Date.now()}.zip`,
    `${packageId}.zip`
  );
  const packagePath = path.join(PATHS.packages, packageName);
  await fs.mkdir(PATHS.packages, { recursive: true });

  const zip = new AdmZip();
  zip.addLocalFile(manifestFile, "", "upgrade-manifest.json");
  zip.addLocalFile(checksumsFile, "", "checksums.json");
  zip.addLocalFile(signatureFile, "", "signature.sig");
  zip.addLocalFolder(payloadRoot, "payload");
  zip.writeZip(packagePath);

  await progress(86, "校验打包结果");
  const verifyResult = await inspectStandardUpgradePackage(packagePath, { packageId });

  const packageStat = await fs.stat(packagePath);
  const packageMeta = {
    id: packageId,
    sourceId: String(sourceId),
    type: "upgrade_package",
    fileName: packageName,
    filePath: packagePath,
    size: Number(packageStat.size || 0),
    uploadedBy: {
      userId: String(actor.userId || ""),
      role: String(actor.role || ""),
      username: String(actor.username || ""),
    },
    manifest: verifyResult.manifest,
    signature: verifyResult.signature,
    checksum: verifyResult.checksum,
    installPolicy: verifyResult.installPolicy,
    verifyStatus: verifyResult.installPolicy.allowInstall ? "pass" : "reject",
    verifyReason: verifyResult.installPolicy.reasons.join("；"),
    verifyAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceType: "build_from_source_zip",
    sourceOriginalName: String(source.originalName || ""),
  };

  await savePackageMeta(packageMeta);
  await saveBuildMeta({
    id: createId("subuild"),
    taskId: String(taskId || ""),
    packageId,
    sourceId: String(sourceId),
    status: "success",
    manifest: packageMeta.manifest,
    signature: packageMeta.signature,
    checksum: packageMeta.checksum,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: packageMeta.uploadedBy,
  });

  await appendHistory("build_package", {
    taskId: String(taskId || ""),
    packageId,
    status: "success",
    manifest: packageMeta.manifest,
    signature: packageMeta.signature,
    checksum: packageMeta.checksum,
  });

  logOperation({
    actorId: actor.userId || "system",
    actorRole: actor.role || "system",
    action: "system_upgrade.build_package_success",
    targetType: "system_upgrade_package",
    targetId: packageId,
    detail: {
      sourceId,
      version: manifest.version,
      channel: manifest.channel,
      signed: Boolean(signatureState.signed),
      fileName: packageName,
    },
  });

  await progress(100, "制作完成");

  return {
    packageMeta,
    verifyResult,
    signatureState,
    sourceSummary: {
      id: source.id,
      name: source.fileName,
      sha256: source.sha256,
    },
  };
}

module.exports = {
  saveUploadedSourceZip,
  createUpgradePackageFromSource,
  sanitizeFilename,
  ensureCleanDir,
};
