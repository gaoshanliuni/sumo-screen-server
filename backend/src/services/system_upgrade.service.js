const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");
const { pipeline } = require("stream/promises");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { logOperation } = require("../utils/logging");
const {
  REPO_ROOT,
  PATHS,
  readUpgradeConfig,
  saveUpgradeConfig,
  getPackageMeta,
  savePackageMeta,
  listPackages,
  listBuilds,
  listSourceUploads,
  readTask,
  listHistory,
  appendHistory,
  patchUpgradeStatus,
  saveInstallMeta,
  listInstalls,
  exists,
} = require("./system_upgrade_storage.service");
const { getUpgradeRuntimeSummary, isContainerRuntime } = require("./system_upgrade_env.service");
const { consumePackageBuildToken } = require("./system_upgrade_auth.service");
const { createAndStartTask, listTaskSummary } = require("./system_upgrade_task.service");
const { saveUploadedSourceZip, createUpgradePackageFromSource, sanitizeFilename, ensureCleanDir } = require("./system_upgrade_build.service");
const {
  inspectStandardUpgradePackage,
  extractZipSafe,
} = require("./system_upgrade_package.service");
const { scheduleWindowsInstall, buildLinuxManualInstructions } = require("./system_upgrade_windows.service");

function pickConfigPatch(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const out = {};
  const boolKeys = [
    "enabled",
    "allowDevPackageInstall",
    "allowDevDowngrade",
    "allowUnsignedDevPackage",
    "allowSameVersionDevReplace",
  ];
  boolKeys.forEach((key) => {
    if (src[key] !== undefined) out[key] = Boolean(src[key]);
  });
  const numKeys = ["maxUploadBytes", "maxPackageBytes", "maxSourceBytes", "maxFileCount", "maxSingleFileBytes"];
  numKeys.forEach((key) => {
    if (src[key] !== undefined && Number.isFinite(Number(src[key]))) out[key] = Number(src[key]);
  });
  if (src.channel !== undefined) out.channel = String(src.channel || "stable");
  if (src.upgradeServer && typeof src.upgradeServer === "object") {
    out.upgradeServer = {
      enabled: src.upgradeServer.enabled !== undefined ? Boolean(src.upgradeServer.enabled) : undefined,
      baseUrl: src.upgradeServer.baseUrl !== undefined ? String(src.upgradeServer.baseUrl || "") : undefined,
      token: src.upgradeServer.token !== undefined ? String(src.upgradeServer.token || "") : undefined,
      latestPath: src.upgradeServer.latestPath !== undefined ? String(src.upgradeServer.latestPath || "/latest") : undefined,
      packagePath: src.upgradeServer.packagePath !== undefined ? String(src.upgradeServer.packagePath || "") : undefined,
    };
  }
  if (src.signing && typeof src.signing === "object") {
    out.signing = {
      publicKeyPem: src.signing.publicKeyPem !== undefined ? String(src.signing.publicKeyPem || "") : undefined,
      privateKeyPem: src.signing.privateKeyPem !== undefined ? String(src.signing.privateKeyPem || "") : undefined,
      publicKeyPath: src.signing.publicKeyPath !== undefined ? String(src.signing.publicKeyPath || "") : undefined,
      privateKeyPath: src.signing.privateKeyPath !== undefined ? String(src.signing.privateKeyPath || "") : undefined,
    };
  }
  return out;
}

async function assertSubsystemEnabled() {
  const cfg = await readUpgradeConfig();
  if (cfg.enabled === false || String(process.env.SYSTEM_UPGRADE_ENABLED || "1") === "0") {
    throw new HttpError(503, "系统升级子系统已禁用");
  }
  return cfg;
}

function sanitizePackageForList(row = {}) {
  return {
    id: String(row.id || ""),
    type: String(row.type || ""),
    fileName: String(row.fileName || ""),
    size: Number(row.size || 0),
    createdAt: String(row.createdAt || ""),
    updatedAt: String(row.updatedAt || ""),
    manifest: row.manifest || null,
    signature: row.signature || null,
    checksum: row.checksum || null,
    installPolicy: row.installPolicy || null,
    verifyStatus: String(row.verifyStatus || ""),
    verifyReason: String(row.verifyReason || ""),
    verifyAt: String(row.verifyAt || ""),
    sourceType: String(row.sourceType || ""),
    sourceOriginalName: String(row.sourceOriginalName || ""),
  };
}

async function getRuntimeInfo() {
  const [runtime, packages, tasks, builds, installs] = await Promise.all([
    getUpgradeRuntimeSummary(),
    listPackages(30),
    listTaskSummary(30),
    listBuilds(30),
    listInstalls(30),
  ]);
  const latestPackage = packages[0] ? sanitizePackageForList(packages[0]) : null;
  return {
    ...runtime,
    latestPackage,
    tasks,
    recentBuilds: builds.slice(0, 20),
    recentInstalls: installs.slice(0, 20),
  };
}

async function getConfigInfo() {
  const config = await readUpgradeConfig();
  return config;
}

async function saveConfigInfo(patch = {}, actor = {}) {
  const next = await saveUpgradeConfig(pickConfigPatch(patch));
  logOperation({
    actorId: actor.userId || "system",
    actorRole: actor.role || "system",
    action: "system_upgrade.config_update",
    targetType: "system_upgrade_config",
    targetId: "config",
    detail: {
      keys: Object.keys(pickConfigPatch(patch)),
    },
  });
  return next;
}

async function sourceUpload({ file, actor = {} }) {
  await assertSubsystemEnabled();
  return await saveUploadedSourceZip({ file, actor });
}

async function buildPackageTaskStart({
  sourceId = "",
  options = {},
  actor = {},
  packageBuildToken = "",
}) {
  await assertSubsystemEnabled();
  await consumePackageBuildToken({
    token: String(packageBuildToken || ""),
    userId: String(actor.userId || ""),
  });
  const task = await createAndStartTask({
    type: "build_package",
    payload: {
      sourceId: String(sourceId || ""),
      options: options || {},
    },
    actor,
  });
  logOperation({
    actorId: actor.userId || "system",
    actorRole: actor.role || "system",
    action: "system_upgrade.build_package_start",
    targetType: "system_upgrade_task",
    targetId: String(task.id || ""),
    detail: {
      sourceId: String(sourceId || ""),
      version: String(options?.version || ""),
      channel: String(options?.channel || ""),
      signAsOfficial: Boolean(options?.signAsOfficial),
    },
  });
  return task;
}

async function uploadStandardPackage({ file, actor = {} }) {
  const cfg = await assertSubsystemEnabled();
  if (!file || !file.buffer) {
    throw new HttpError(400, "请上传升级包文件");
  }
  const maxBytes = Math.max(10 * 1024 * 1024, Number(cfg.maxPackageBytes || cfg.maxUploadBytes || 800 * 1024 * 1024));
  if (Number(file.size || file.buffer.length || 0) > maxBytes) {
    throw new HttpError(400, `升级包超过限制，最大 ${Math.floor(maxBytes / 1024 / 1024)}MB`);
  }
  const packageId = createId("supkg");
  const safeName = sanitizeFilename(file.originalname, `${packageId}.zip`);
  const storedName = `${packageId}_${safeName}`;
  const storedPath = path.join(PATHS.packages, storedName);
  await fs.mkdir(PATHS.packages, { recursive: true });
  await fs.writeFile(storedPath, file.buffer);

  const meta = {
    id: packageId,
    type: "uploaded_upgrade_package",
    fileName: safeName,
    storedName,
    filePath: storedPath,
    size: Number(file.size || file.buffer.length || 0),
    uploadedBy: {
      userId: String(actor.userId || ""),
      role: String(actor.role || ""),
      username: String(actor.username || ""),
    },
    verifyStatus: "uploaded",
    verifyReason: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceType: "manual_upload",
  };
  await savePackageMeta(meta);
  await appendHistory("upload_package", {
    packageId,
    fileName: safeName,
    actor: meta.uploadedBy,
    status: "uploaded",
  });
  logOperation({
    actorId: actor.userId || "system",
    actorRole: actor.role || "system",
    action: "system_upgrade.upload",
    targetType: "system_upgrade_package",
    targetId: packageId,
    detail: {
      fileName: safeName,
      size: meta.size,
    },
  });
  return meta;
}

async function startVerifyTask({ packageId = "", actor = {} }) {
  await assertSubsystemEnabled();
  const meta = await getPackageMeta(packageId);
  if (!meta) throw new HttpError(404, "升级包不存在");
  return await createAndStartTask({
    type: "verify_package",
    payload: {
      packageId: String(packageId || ""),
    },
    actor,
  });
}

async function startFetchRemoteTask({ actor = {}, url = "", packageName = "" }) {
  const cfg = await assertSubsystemEnabled();
  const base = String(cfg?.upgradeServer?.baseUrl || "").trim();
  const latestPath = String(cfg?.upgradeServer?.latestPath || "/latest").trim() || "/latest";
  const packagePath = String(cfg?.upgradeServer?.packagePath || "").trim();
  const resolvedUrl = String(url || "").trim();
  if (!resolvedUrl && !base) {
    throw new HttpError(400, "未配置升级服务器地址");
  }
  const task = await createAndStartTask({
    type: "fetch_remote_package",
    payload: {
      url: resolvedUrl,
      packageName: String(packageName || ""),
      baseUrl: base,
      latestPath,
      packagePath,
      token: String(cfg?.upgradeServer?.token || ""),
    },
    actor,
  });
  logOperation({
    actorId: actor.userId || "system",
    actorRole: actor.role || "system",
    action: "system_upgrade.fetch_remote",
    targetType: "system_upgrade_task",
    targetId: String(task.id || ""),
    detail: {
      url: resolvedUrl || `${base}${latestPath}`,
    },
  });
  return task;
}

async function startInstallTask({ packageId = "", actor = {} }) {
  await assertSubsystemEnabled();
  const meta = await getPackageMeta(packageId);
  if (!meta) throw new HttpError(404, "升级包不存在");
  const task = await createAndStartTask({
    type: "install_package",
    payload: {
      packageId: String(packageId || ""),
    },
    actor,
  });
  await patchUpgradeStatus({
    pendingPackageId: String(packageId || ""),
  });
  logOperation({
    actorId: actor.userId || "system",
    actorRole: actor.role || "system",
    action: process.platform === "win32" ? "system_upgrade.install_windows" : "system_upgrade.manual_linux",
    targetType: "system_upgrade_task",
    targetId: String(task.id || ""),
    detail: {
      packageId: String(packageId || ""),
    },
  });
  return task;
}

async function listPackagesForUI(limit = 120) {
  const items = await listPackages(limit);
  return items.map(sanitizePackageForList);
}

async function listBuildsForUI(limit = 120) {
  return await listBuilds(limit);
}

async function listSourceUploadsForUI(limit = 120) {
  return await listSourceUploads(limit);
}

async function listHistoryForUI(limit = 200) {
  return await listHistory("", limit);
}

async function getTaskById(taskId = "") {
  const task = await readTask(taskId);
  if (!task) throw new HttpError(404, "任务不存在");
  return task;
}

async function getPackageDownloadMeta(packageId = "") {
  const meta = await getPackageMeta(packageId);
  if (!meta) throw new HttpError(404, "升级包不存在");
  if (!(await exists(meta.filePath))) throw new HttpError(404, "升级包文件不存在");
  return meta;
}

async function workerDoBuildTask({ task, progress }) {
  const sourceId = String(task?.payload?.sourceId || "");
  if (!sourceId) {
    throw new HttpError(400, "build task 缺少 sourceId");
  }
  const result = await createUpgradePackageFromSource({
    sourceId,
    options: task.payload?.options || {},
    actor: task.actor || {},
    taskId: task.id,
    progress,
  });
  return {
    kind: "build_package",
    package: sanitizePackageForList(result.packageMeta),
    verify: {
      signature: result.verifyResult.signature,
      checksum: result.verifyResult.checksum,
      installPolicy: result.verifyResult.installPolicy,
    },
  };
}

async function workerDoVerifyTask({ task, progress }) {
  const packageId = String(task?.payload?.packageId || "");
  if (!packageId) throw new HttpError(400, "verify task 缺少 packageId");
  const meta = await getPackageMeta(packageId);
  if (!meta) throw new HttpError(404, "升级包不存在");
  await progress(25, "读取升级包并校验结构");
  const verifyResult = await inspectStandardUpgradePackage(meta.filePath, { packageId });
  await progress(85, "写入校验结果");
  const nextMeta = {
    ...meta,
    manifest: verifyResult.manifest,
    signature: verifyResult.signature,
    checksum: verifyResult.checksum,
    installPolicy: verifyResult.installPolicy,
    verifyStatus: verifyResult.installPolicy.allowInstall ? "pass" : "reject",
    verifyReason: verifyResult.installPolicy.reasons.join("；"),
    verifyAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await savePackageMeta(nextMeta);
  await appendHistory("verify_package", {
    packageId,
    status: nextMeta.verifyStatus,
    reason: nextMeta.verifyReason,
  });
  logOperation({
    actorId: task?.actor?.userId || "system",
    actorRole: task?.actor?.role || "system",
    action: nextMeta.verifyStatus === "pass" ? "system_upgrade.verify_pass" : "system_upgrade.verify_reject",
    targetType: "system_upgrade_package",
    targetId: packageId,
    detail: {
      reason: nextMeta.verifyReason,
    },
    status: nextMeta.verifyStatus === "pass" ? "success" : "failed",
  });
  await progress(100, "校验完成");
  return {
    kind: "verify_package",
    package: sanitizePackageForList(nextMeta),
  };
}

async function resolveRemotePackageUrl(payload = {}) {
  const explicit = String(payload.url || "").trim();
  if (explicit) return explicit;
  const baseUrl = String(payload.baseUrl || "").trim().replace(/\/+$/, "");
  const latestPath = String(payload.latestPath || "/latest").trim();
  if (!baseUrl) {
    throw new HttpError(400, "远程升级服务器地址为空");
  }
  return `${baseUrl}${latestPath.startsWith("/") ? latestPath : `/${latestPath}`}`;
}

async function workerDoFetchRemoteTask({ task, progress }) {
  const payload = task?.payload || {};
  const cfg = await readUpgradeConfig();
  const maxPackageBytes = Math.max(10 * 1024 * 1024, Number(cfg.maxPackageBytes || 800 * 1024 * 1024));
  const fetchUrl = await resolveRemotePackageUrl(payload);
  const headers = {};
  const token = String(payload.token || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  await progress(10, "请求远程升级包");
  const response = await axios.get(fetchUrl, {
    responseType: "stream",
    timeout: 90_000,
    maxRedirects: 3,
    headers,
    validateStatus: () => true,
  });
  if (Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) {
    throw new HttpError(400, `远程下载失败: HTTP ${response.status}`);
  }

  const packageId = createId("supkg");
  const fileName = sanitizeFilename(payload.packageName || path.basename(fetchUrl) || `${packageId}.zip`, `${packageId}.zip`);
  const storedName = `${packageId}_${fileName}`;
  const storedPath = path.join(PATHS.packages, storedName);
  await fs.mkdir(PATHS.packages, { recursive: true });
  const writer = await fs.open(storedPath, "w");
  try {
    await progress(30, "下载中");
    await pipeline(response.data, writer.createWriteStream());
  } finally {
    await writer.close();
  }
  const stat = await fs.stat(storedPath);
  if (Number(stat.size || 0) > maxPackageBytes) {
    throw new HttpError(400, `远程升级包超限，最大 ${Math.floor(maxPackageBytes / 1024 / 1024)}MB`);
  }

  await progress(65, "写入包元数据");
  const meta = {
    id: packageId,
    type: "fetched_upgrade_package",
    fileName,
    storedName,
    filePath: storedPath,
    size: Number(stat.size || 0),
    uploadedBy: {
      userId: String(task?.actor?.userId || ""),
      role: String(task?.actor?.role || ""),
      username: String(task?.actor?.username || ""),
    },
    verifyStatus: "uploaded",
    verifyReason: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceType: "remote_fetch",
    sourceUrl: fetchUrl,
  };
  await savePackageMeta(meta);
  await appendHistory("fetch_remote_package", {
    packageId,
    sourceUrl: fetchUrl,
    status: "uploaded",
  });

  await progress(75, "自动启动校验");
  const verifyTask = await createAndStartTask({
    type: "verify_package",
    payload: {
      packageId,
    },
    actor: task.actor || {},
  });
  await progress(100, "远程升级包已入库并触发校验");
  return {
    kind: "fetch_remote_package",
    packageId,
    verifyTaskId: verifyTask.id,
    sourceUrl: fetchUrl,
  };
}

function resolveProjectRootByManifest(manifest = {}) {
  const targetName = String(manifest?.targetAppRootName || "dachicunhouduan").trim();
  if (!targetName) return REPO_ROOT;
  const currentBase = path.basename(REPO_ROOT);
  if (currentBase === targetName) return REPO_ROOT;
  return path.join(path.dirname(REPO_ROOT), targetName);
}

async function workerDoInstallTask({ task, progress }) {
  const packageId = String(task?.payload?.packageId || "");
  if (!packageId) throw new HttpError(400, "install task 缺少 packageId");
  const meta = await getPackageMeta(packageId);
  if (!meta) throw new HttpError(404, "升级包不存在");

  await progress(20, "校验升级包");
  const verifyResult = await inspectStandardUpgradePackage(meta.filePath, { packageId });
  const installPolicy = verifyResult.installPolicy || { allowInstall: false, reasons: ["missing_policy"] };
  if (!installPolicy.allowInstall) {
    throw new HttpError(400, `升级包不允许安装: ${installPolicy.reasons.join("；")}`);
  }

  const platform = process.platform;
  const container = await isContainerRuntime();
  if (platform !== "win32" || container) {
    await progress(70, "生成 Linux/容器手动安装说明");
    const instructions = buildLinuxManualInstructions({
      packageId,
      packagePath: meta.filePath,
      projectRootName: String(verifyResult?.manifest?.targetAppRootName || "dachicunhouduan"),
      runtimeDir: path.dirname(resolveProjectRootByManifest(verifyResult.manifest)),
    });
    await saveInstallMeta({
      id: createId("suinst"),
      taskId: task.id,
      packageId,
      status: "manual_required",
      platform: platform === "win32" ? "Windows(container)" : "Linux",
      message: "当前环境建议手动应用升级包",
      instructions,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await appendHistory("install_manual_required", {
      taskId: task.id,
      packageId,
      platform,
      container,
      instructions,
    });
    await patchUpgradeStatus({
      pendingPackageId: packageId,
    });
    return {
      kind: "install_package",
      mode: "manual_required",
      packageId,
      instructions,
    };
  }

  await progress(50, "准备 Windows staging");
  const stageRoot = path.join(PATHS.staging, `install_${task.id}`);
  await ensureCleanDir(stageRoot);
  await extractZipSafe(meta.filePath, stageRoot, await readUpgradeConfig());
  const payloadProjectRoot = path.join(
    stageRoot,
    "payload",
    String(verifyResult?.manifest?.targetAppRootName || "dachicunhouduan")
  );
  if (!(await exists(payloadProjectRoot))) {
    throw new HttpError(400, "升级包 payload 缺少目标目录");
  }
  const projectRoot = resolveProjectRootByManifest(verifyResult.manifest);
  const backupRoot = `${projectRoot}.backup.${Date.now()}`;
  await progress(75, "启动 Windows helper");
  const taskFile = path.join(PATHS.tasks, `${task.id}.json`);
  const helper = await scheduleWindowsInstall({
    taskId: task.id,
    taskFile,
    payloadProjectRoot,
    projectRoot,
    backupRoot,
  });
  await saveInstallMeta({
    id: createId("suinst"),
    taskId: task.id,
    packageId,
    status: "running",
    platform: "Windows",
    message: "已启动 detached helper，等待覆盖完成",
    helper,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await appendHistory("install_windows_schedule", {
    taskId: task.id,
    packageId,
    helper,
  });
  await patchUpgradeStatus({
    pendingPackageId: packageId,
  });
  await progress(100, "Windows helper 已启动");
  return {
    kind: "install_package",
    mode: "windows_helper_started",
    packageId,
    helper,
    message: "升级完成后请刷新页面，必要时重启服务",
  };
}

async function executeTaskByType({ task, progress = async () => {} }) {
  const type = String(task?.type || "");
  if (type === "build_package") return await workerDoBuildTask({ task, progress });
  if (type === "verify_package") return await workerDoVerifyTask({ task, progress });
  if (type === "fetch_remote_package") return await workerDoFetchRemoteTask({ task, progress });
  if (type === "install_package") return await workerDoInstallTask({ task, progress });
  throw new HttpError(400, `未知任务类型: ${type}`);
}

module.exports = {
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
  executeTaskByType,
};
