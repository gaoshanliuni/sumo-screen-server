const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { PATHS, ensureUpgradeRuntime, readUpgradeConfig, REPO_ROOT, exists } = require("./system_upgrade_storage.service");
const { readSystemRelease } = require("./system_upgrade_env.service");

const REQUIRED_UPGRADE_FILES = ["upgrade-manifest.json", "checksums.json", "signature.sig"];

function normalizeZipEntryName(name = "") {
  return String(name || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
}

function isUnsafeZipPath(name = "") {
  const n = normalizeZipEntryName(name);
  if (!n) return true;
  if (n.startsWith("/")) return true;
  if (/^[a-zA-Z]:\//.test(n)) return true;
  if (n.includes("../")) return true;
  if (n.endsWith("/..")) return true;
  return false;
}

function toSemverTuple(input = "") {
  const raw = String(input || "").trim();
  const match = raw.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a, b) {
  const av = toSemverTuple(a);
  const bv = toSemverTuple(b);
  if (!av || !bv) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function getKeyPem(type, config) {
  const cfg = config || (await readUpgradeConfig());
  const envPath = String(process.env[type === "public" ? "SYSTEM_UPGRADE_PUBLIC_KEY_PATH" : "SYSTEM_UPGRADE_PRIVATE_KEY_PATH"] || "").trim();
  const envPem = String(process.env[type === "public" ? "SYSTEM_UPGRADE_PUBLIC_KEY" : "SYSTEM_UPGRADE_PRIVATE_KEY"] || "").trim();
  const cfgPath = String(type === "public" ? cfg?.signing?.publicKeyPath || "" : cfg?.signing?.privateKeyPath || "").trim();
  const cfgPem = String(type === "public" ? cfg?.signing?.publicKeyPem || "" : cfg?.signing?.privateKeyPem || "").trim();

  const candidatePaths = [envPath, cfgPath].filter(Boolean).map((p) => (path.isAbsolute(p) ? p : path.join(REPO_ROOT, p)));
  for (const p of candidatePaths) {
    try {
      const raw = await fs.readFile(p, "utf8");
      if (String(raw || "").trim()) return String(raw);
    } catch (_) {
      // ignore
    }
  }
  if (envPem) return envPem;
  if (cfgPem) return cfgPem;
  return "";
}

function createSignPayload(manifest, checksums) {
  const payload = {
    manifest,
    checksums,
  };
  return Buffer.from(JSON.stringify(payload), "utf8");
}

async function signManifestChecksums(manifest, checksums, config) {
  const privateKeyPem = await getKeyPem("private", config);
  if (!privateKeyPem) {
    throw new HttpError(400, "未配置升级私钥，无法签名");
  }
  const data = createSignPayload(manifest, checksums);
  const keyObject = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, data, keyObject);
  return signature.toString("base64");
}

async function verifyManifestChecksumsSignature(manifest, checksums, signatureText, config) {
  const publicKeyPem = await getKeyPem("public", config);
  if (!publicKeyPem) {
    return {
      valid: false,
      reason: "public_key_missing",
    };
  }
  const rawSig = String(signatureText || "").trim();
  if (!rawSig) {
    return {
      valid: false,
      reason: "signature_missing",
    };
  }
  const data = createSignPayload(manifest, checksums);
  let sigBuffer = null;
  try {
    const parsed = JSON.parse(rawSig);
    if (parsed && typeof parsed === "object" && parsed.signature) {
      sigBuffer = Buffer.from(String(parsed.signature), "base64");
    }
  } catch (_) {
    // ignore
  }
  if (!sigBuffer) {
    try {
      sigBuffer = Buffer.from(rawSig, "base64");
    } catch (_) {
      return {
        valid: false,
        reason: "signature_invalid_base64",
      };
    }
  }
  try {
    const keyObject = crypto.createPublicKey(publicKeyPem);
    const ok = crypto.verify(null, data, keyObject, sigBuffer);
    return {
      valid: Boolean(ok),
      reason: ok ? "ok" : "signature_mismatch",
    };
  } catch (error) {
    return {
      valid: false,
      reason: `verify_error:${error?.message || "unknown"}`,
    };
  }
}

async function ensureCleanDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true });
  await fs.mkdir(dirPath, { recursive: true });
}

async function extractZipSafe(zipPath, targetDir, limits = {}) {
  await ensureUpgradeRuntime();
  const maxFileCount = Math.max(1, Number(limits.maxFileCount || 20000));
  const maxSingleFileBytes = Math.max(1024, Number(limits.maxSingleFileBytes || 200 * 1024 * 1024));

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length > maxFileCount) {
    throw new HttpError(400, `压缩包文件数超限，最多 ${maxFileCount}`);
  }
  await ensureCleanDir(targetDir);

  for (const entry of entries) {
    const normalized = normalizeZipEntryName(entry.entryName);
    if (isUnsafeZipPath(normalized)) {
      throw new HttpError(400, `压缩包路径非法: ${entry.entryName}`);
    }
    const outputPath = path.join(targetDir, normalized);
    const resolved = path.resolve(outputPath);
    if (!resolved.startsWith(path.resolve(targetDir))) {
      throw new HttpError(400, `压缩包路径越界: ${entry.entryName}`);
    }
    if (entry.isDirectory) {
      await fs.mkdir(resolved, { recursive: true });
      continue;
    }
    const size = Number(entry.header?.size || entry.header?.compressedSize || 0);
    if (size > maxSingleFileBytes) {
      throw new HttpError(400, `文件过大: ${entry.entryName}`);
    }
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    const content = entry.getData();
    if (content.length > maxSingleFileBytes) {
      throw new HttpError(400, `文件过大: ${entry.entryName}`);
    }
    await fs.writeFile(resolved, content);
  }
  return { fileCount: entries.length };
}

async function listAllFiles(rootDir) {
  const files = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await walk(rootDir);
  return files;
}

async function computeChecksumsForDir(rootDir) {
  const files = await listAllFiles(rootDir);
  const map = {};
  for (const full of files) {
    const rel = normalizeZipEntryName(path.relative(rootDir, full));
    const data = await fs.readFile(full);
    map[rel] = sha256Hex(data);
  }
  return map;
}

function normalizeManifest(manifest = {}, config = {}) {
  return {
    packageType: String(manifest.packageType || config?.packageRules?.packageType || "ink-screen-platform-upgrade"),
    appId: String(manifest.appId || config?.packageRules?.appId || "ink-screen-platform"),
    version: String(manifest.version || ""),
    channel: String(manifest.channel || "stable"),
    buildTime: String(manifest.buildTime || ""),
    buildId: String(manifest.buildId || ""),
    developerOnly: Boolean(manifest.developerOnly),
    allowDowngrade: Boolean(manifest.allowDowngrade),
    minCompatibleUpdaterVersion: String(manifest.minCompatibleUpdaterVersion || ""),
    payloadRoot: String(manifest.payloadRoot || "payload"),
    packageFormatVersion: Number(manifest.packageFormatVersion || config?.packageRules?.defaultPackageFormatVersion || 1),
    notes: String(manifest.notes || ""),
    createdBy: String(manifest.createdBy || ""),
    sourceRelease: String(manifest.sourceRelease || ""),
    sourceFolderName: String(manifest.sourceFolderName || config?.packageRules?.targetAppRootName || "dachicunhouduan"),
    payloadLayout: String(
      manifest.payloadLayout || config?.packageRules?.payloadLayout || "payload_contains_project_root_folder"
    ),
    targetAppRootName: String(manifest.targetAppRootName || config?.packageRules?.targetAppRootName || "dachicunhouduan"),
  };
}

function evaluateInstallPolicy({ release, manifest, config, signatureValid, signatureReason }) {
  const reasons = [];
  const currentVersion = String(release?.version || "");
  const targetVersion = String(manifest?.version || "");
  const semverCmp = compareSemver(targetVersion, currentVersion);
  const isDevPkg = Boolean(manifest?.developerOnly) || String(manifest?.channel || "").toLowerCase() === "dev";
  const requireSignature = Boolean(config?.packageRules?.requireSignatureForStable);
  if (manifest.packageType !== String(config?.packageRules?.packageType || "ink-screen-platform-upgrade")) {
    reasons.push("packageType 不匹配");
  }
  if (manifest.appId !== String(config?.packageRules?.appId || "ink-screen-platform")) {
    reasons.push("appId 不匹配");
  }
  if (manifest.targetAppRootName !== String(config?.packageRules?.targetAppRootName || "dachicunhouduan")) {
    reasons.push("targetAppRootName 不匹配");
  }
  if (
    manifest.payloadLayout !== String(config?.packageRules?.payloadLayout || "payload_contains_project_root_folder")
  ) {
    reasons.push("payloadLayout 不匹配");
  }
  if (!targetVersion) {
    reasons.push("升级包 version 不能为空");
  }
  if (!toSemverTuple(targetVersion)) {
    reasons.push("升级包 version 不是合法 semver");
  }
  if (toSemverTuple(targetVersion) && toSemverTuple(currentVersion)) {
    if (semverCmp < 0 && !manifest.allowDowngrade && !config.allowDevDowngrade) {
      reasons.push("不允许降级安装");
    }
    if (semverCmp === 0 && !(isDevPkg && config.allowSameVersionDevReplace)) {
      reasons.push("同版本默认不允许重复覆盖");
    }
  }

  if (!signatureValid) {
    if (requireSignature && !isDevPkg) {
      reasons.push(`正式包签名校验失败(${signatureReason})`);
    } else if (!(isDevPkg && config.allowUnsignedDevPackage)) {
      reasons.push(`未通过签名校验(${signatureReason})`);
    }
  }

  if (isDevPkg && !config.allowDevPackageInstall) {
    reasons.push("当前配置禁止安装开发包");
  }

  return {
    allowInstall: reasons.length === 0,
    reasons,
    compareResult: semverCmp > 0 ? "upgrade" : semverCmp < 0 ? "downgrade" : semverCmp === 0 ? "same" : "unknown",
    currentVersion,
    targetVersion,
    isDevPackage: isDevPkg,
  };
}

function parseChecksumsObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  if (raw.files && typeof raw.files === "object" && !Array.isArray(raw.files)) {
    return raw.files;
  }
  return raw;
}

async function inspectSourceZip(zipPath, config) {
  const cfg = config || (await readUpgradeConfig());
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const maxFileCount = Math.max(1, Number(cfg.maxFileCount || 20000));
  if (entries.length > maxFileCount) {
    throw new HttpError(400, `源码压缩包文件数超限，最多 ${maxFileCount}`);
  }
  const top = new Set();
  let hasProjectRoot = false;
  let hasBackend = false;
  let hasFrontend = false;

  for (const entry of entries) {
    const normalized = normalizeZipEntryName(entry.entryName);
    if (isUnsafeZipPath(normalized)) {
      throw new HttpError(400, `源码压缩包路径非法: ${entry.entryName}`);
    }
    const parts = normalized.split("/").filter(Boolean);
    if (!parts.length) continue;
    top.add(parts[0]);
    if (parts[0] === "dachicunhouduan") {
      hasProjectRoot = true;
      if (parts[1] === "backend") hasBackend = true;
      if (parts[1] === "frontend-vue") hasFrontend = true;
    }
  }
  return {
    fileCount: entries.length,
    topFolders: [...top],
    hasProjectRoot,
    hasBackend,
    hasFrontendVue: hasFrontend,
    valid:
      hasProjectRoot &&
      hasBackend &&
      hasFrontend &&
      [...top].filter((name) => name && name !== "dachicunhouduan" && name !== "__MACOSX").length === 0,
    rejectReason:
      hasProjectRoot &&
      hasBackend &&
      hasFrontend &&
      [...top].filter((name) => name && name !== "dachicunhouduan" && name !== "__MACOSX").length === 0
        ? ""
        : "源码包根目录必须仅包含 dachicunhouduan/（可含 __MACOSX），并包含 dachicunhouduan/backend 与 dachicunhouduan/frontend-vue",
  };
}

async function inspectStandardUpgradePackage(zipPath, options = {}) {
  const [cfg, release] = await Promise.all([readUpgradeConfig(), readSystemRelease()]);
  const packageId = String(options.packageId || createId("supkg"));
  const extractDir = path.join(PATHS.tmp, `verify_${packageId}`);
  await extractZipSafe(zipPath, extractDir, cfg);

  for (const required of REQUIRED_UPGRADE_FILES) {
    if (!(await exists(path.join(extractDir, required)))) {
      throw new HttpError(400, `升级包缺少 ${required}`);
    }
  }
  const payloadDir = path.join(extractDir, "payload");
  if (!(await exists(payloadDir))) {
    throw new HttpError(400, "升级包缺少 payload 目录");
  }

  const manifestRaw = await fs.readFile(path.join(extractDir, "upgrade-manifest.json"), "utf8");
  const checksumsRaw = await fs.readFile(path.join(extractDir, "checksums.json"), "utf8");
  const signatureRaw = await fs.readFile(path.join(extractDir, "signature.sig"), "utf8");

  const manifest = normalizeManifest(JSON.parse(manifestRaw), cfg);
  const checksumsParsed = parseChecksumsObject(JSON.parse(checksumsRaw));
  const computed = await computeChecksumsForDir(payloadDir);

  const checksumErrors = [];
  Object.entries(checksumsParsed).forEach(([rel, hash]) => {
    const key = normalizeZipEntryName(rel);
    const expect = String(hash || "");
    const actual = String(computed[key] || "");
    if (!actual) checksumErrors.push(`缺少文件: ${key}`);
    else if (actual !== expect) checksumErrors.push(`checksum 不匹配: ${key}`);
  });
  Object.keys(computed).forEach((rel) => {
    if (checksumsParsed[rel] === undefined) checksumErrors.push(`checksums 未声明文件: ${rel}`);
  });

  const signature = await verifyManifestChecksumsSignature(manifest, checksumsParsed, signatureRaw, cfg);
  const installPolicy = evaluateInstallPolicy({
    release,
    manifest,
    config: cfg,
    signatureValid: signature.valid,
    signatureReason: signature.reason,
  });

  const targetRootInPayload = path.join(payloadDir, manifest.targetAppRootName || "");
  const hasTargetRoot = await exists(targetRootInPayload);
  if (!hasTargetRoot) {
    installPolicy.allowInstall = false;
    installPolicy.reasons.push(`payload 下缺少目标根目录: ${manifest.targetAppRootName}`);
  }
  if (checksumErrors.length) {
    installPolicy.allowInstall = false;
    installPolicy.reasons.push("checksum 校验失败");
  }

  return {
    packageId,
    extractDir,
    manifest,
    checksums: checksumsParsed,
    signature: {
      valid: signature.valid,
      reason: signature.reason,
    },
    checksum: {
      valid: checksumErrors.length === 0,
      errors: checksumErrors,
      totalFiles: Object.keys(computed).length,
    },
    release,
    installPolicy,
    payloadPath: payloadDir,
    targetRootPath: targetRootInPayload,
  };
}

function buildManifestForPackage(input = {}, config = {}, release = {}) {
  return normalizeManifest(
    {
      packageType: config?.packageRules?.packageType || "ink-screen-platform-upgrade",
      appId: config?.packageRules?.appId || "ink-screen-platform",
      version: String(input.version || ""),
      channel: String(input.channel || "stable"),
      buildTime: input.buildTime || new Date().toISOString(),
      buildId: String(input.buildId || createId("build")),
      developerOnly: Boolean(input.developerOnly),
      allowDowngrade: Boolean(input.allowDowngrade),
      minCompatibleUpdaterVersion: String(input.minCompatibleUpdaterVersion || ""),
      payloadRoot: "payload",
      packageFormatVersion: Number(input.packageFormatVersion || config?.packageRules?.defaultPackageFormatVersion || 1),
      notes: String(input.notes || ""),
      createdBy: String(input.createdBy || ""),
      sourceRelease: String(input.sourceRelease || release.version || ""),
      sourceFolderName: "dachicunhouduan",
      payloadLayout: config?.packageRules?.payloadLayout || "payload_contains_project_root_folder",
      targetAppRootName: config?.packageRules?.targetAppRootName || "dachicunhouduan",
    },
    config
  );
}

module.exports = {
  normalizeZipEntryName,
  isUnsafeZipPath,
  compareSemver,
  toSemverTuple,
  extractZipSafe,
  computeChecksumsForDir,
  signManifestChecksums,
  verifyManifestChecksumsSignature,
  inspectSourceZip,
  inspectStandardUpgradePackage,
  evaluateInstallPolicy,
  buildManifestForPackage,
  getKeyPem,
  createSignPayload,
  sha256Hex,
};
