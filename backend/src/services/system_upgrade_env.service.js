const fs = require("fs/promises");
const path = require("path");
const { REPO_ROOT, readUpgradeConfig, readUpgradeStatus, ensureUpgradeRuntime } = require("./system_upgrade_storage.service");

const RELEASE_FILE = path.join(REPO_ROOT, "shared", "system-release.json");

const DEFAULT_RELEASE = {
  appId: "ink-screen-platform",
  version: "0.0.0",
  channel: "stable",
  buildTime: "",
  buildId: "",
  developerBuild: true,
};

async function readSystemRelease() {
  try {
    const raw = await fs.readFile(RELEASE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_RELEASE };
    return {
      appId: String(parsed.appId || DEFAULT_RELEASE.appId),
      version: String(parsed.version || DEFAULT_RELEASE.version),
      channel: String(parsed.channel || DEFAULT_RELEASE.channel),
      buildTime: String(parsed.buildTime || ""),
      buildId: String(parsed.buildId || ""),
      developerBuild: Boolean(parsed.developerBuild),
    };
  } catch (_) {
    return { ...DEFAULT_RELEASE };
  }
}

async function writeSystemRelease(release = {}) {
  const current = await readSystemRelease();
  const next = {
    ...current,
    ...release,
  };
  await fs.mkdir(path.dirname(RELEASE_FILE), { recursive: true });
  await fs.writeFile(RELEASE_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function isContainerRuntime() {
  try {
    await fs.access("/.dockerenv");
    return true;
  } catch (_) {
    // continue
  }
  try {
    const cgroup = await fs.readFile("/proc/1/cgroup", "utf8");
    const lower = String(cgroup || "").toLowerCase();
    return lower.includes("docker") || lower.includes("containerd") || lower.includes("kubepods");
  } catch (_) {
    return false;
  }
}

function detectPlatformLabel() {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "linux") return "Linux";
  if (process.platform === "darwin") return "macOS";
  return process.platform;
}

async function getUpgradeRuntimeSummary() {
  await ensureUpgradeRuntime();
  const [release, config, status, inContainer] = await Promise.all([
    readSystemRelease(),
    readUpgradeConfig(),
    readUpgradeStatus(),
    isContainerRuntime(),
  ]);
  const envEnabled = String(process.env.SYSTEM_UPGRADE_ENABLED || "1") !== "0";
  const subsystemEnabled = envEnabled && config.enabled !== false;
  const hasPublicKey =
    Boolean(String(config?.signing?.publicKeyPem || "").trim()) ||
    Boolean(String(config?.signing?.publicKeyPath || "").trim()) ||
    Boolean(String(process.env.SYSTEM_UPGRADE_PUBLIC_KEY || "").trim()) ||
    Boolean(String(process.env.SYSTEM_UPGRADE_PUBLIC_KEY_PATH || "").trim());
  const hasPrivateKey =
    Boolean(String(config?.signing?.privateKeyPem || "").trim()) ||
    Boolean(String(config?.signing?.privateKeyPath || "").trim()) ||
    Boolean(String(process.env.SYSTEM_UPGRADE_PRIVATE_KEY || "").trim()) ||
    Boolean(String(process.env.SYSTEM_UPGRADE_PRIVATE_KEY_PATH || "").trim());
  return {
    release,
    runtime: {
      platform: detectPlatformLabel(),
      nodeVersion: process.version,
      container: inContainer,
      subsystemEnabled,
      subsystemStatus: subsystemEnabled ? String(status?.subsystemStatus || "normal") : "disabled",
      busy: Number(status?.busyTasks || 0) > 0,
      lastError: String(status?.lastError || ""),
      lastErrorAt: String(status?.lastErrorAt || ""),
      lastUpgradeResult: status?.lastUpgradeResult || null,
      pendingPackageId: String(status?.pendingPackageId || ""),
      hasPublicKey,
      hasPrivateKey,
      allowDevPackageInstall: Boolean(config?.allowDevPackageInstall),
      allowDevDowngrade: Boolean(config?.allowDevDowngrade),
      allowUnsignedDevPackage: Boolean(config?.allowUnsignedDevPackage),
      allowSameVersionDevReplace: Boolean(config?.allowSameVersionDevReplace),
      channel: String(config?.channel || release.channel || "stable"),
      upgradeServerSummary: {
        enabled: Boolean(config?.upgradeServer?.enabled),
        baseUrl: String(config?.upgradeServer?.baseUrl || ""),
        latestPath: String(config?.upgradeServer?.latestPath || "/latest"),
        hasToken: Boolean(String(config?.upgradeServer?.token || "").trim()),
      },
      updatedAt: String(status?.updatedAt || ""),
    },
    config,
  };
}

module.exports = {
  RELEASE_FILE,
  readSystemRelease,
  writeSystemRelease,
  isContainerRuntime,
  detectPlatformLabel,
  getUpgradeRuntimeSummary,
};
