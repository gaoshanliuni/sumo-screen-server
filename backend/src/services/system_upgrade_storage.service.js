const fs = require("fs/promises");
const path = require("path");
const createId = require("../utils/id");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const RUNTIME_ROOT = path.join(REPO_ROOT, "backend", "runtime", "system-upgrade");
const PATHS = {
  root: RUNTIME_ROOT,
  packages: path.join(RUNTIME_ROOT, "packages"),
  tasks: path.join(RUNTIME_ROOT, "tasks"),
  staging: path.join(RUNTIME_ROOT, "staging"),
  downloads: path.join(RUNTIME_ROOT, "downloads"),
  history: path.join(RUNTIME_ROOT, "history"),
  tmp: path.join(RUNTIME_ROOT, "tmp"),
  config: path.join(RUNTIME_ROOT, "config.json"),
  status: path.join(RUNTIME_ROOT, "status.json"),
  sourcesIndex: path.join(RUNTIME_ROOT, "sources.json"),
  packageIndex: path.join(RUNTIME_ROOT, "packages.json"),
  buildIndex: path.join(RUNTIME_ROOT, "builds.json"),
  installIndex: path.join(RUNTIME_ROOT, "installs.json"),
  authTokenIndex: path.join(RUNTIME_ROOT, "auth_tokens.json"),
};

const DEFAULT_CONFIG = {
  enabled: true,
  channel: "stable",
  allowDevPackageInstall: false,
  allowDevDowngrade: false,
  allowUnsignedDevPackage: false,
  allowSameVersionDevReplace: false,
  maxUploadBytes: 800 * 1024 * 1024,
  maxPackageBytes: 800 * 1024 * 1024,
  maxSourceBytes: 1024 * 1024 * 1024,
  maxFileCount: 20000,
  maxSingleFileBytes: 200 * 1024 * 1024,
  upgradeServer: {
    enabled: false,
    baseUrl: "",
    token: "",
    latestPath: "/latest",
    packagePath: "",
  },
  signing: {
    publicKeyPem: "",
    privateKeyPem: "",
    publicKeyPath: "",
    privateKeyPath: "",
  },
  packageRules: {
    requireSignatureForStable: true,
    devPackageRequireFlag: true,
    defaultPackageFormatVersion: 1,
    packageType: "ink-screen-platform-upgrade",
    appId: "ink-screen-platform",
    targetAppRootName: "dachicunhouduan",
    payloadLayout: "payload_contains_project_root_folder",
  },
};

const DEFAULT_STATUS = {
  subsystemStatus: "normal",
  lastError: "",
  lastErrorAt: "",
  busyTasks: 0,
  lastUpgradeResult: {
    taskId: "",
    status: "idle",
    message: "",
    at: "",
  },
  pendingPackageId: "",
  updatedAt: "",
};

let ensured = false;

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

async function writeJsonFileAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tempFile = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(value, null, 2);
  await fs.writeFile(tempFile, payload, "utf8");
  await fs.rename(tempFile, filePath);
}

function mergeConfig(base, patch) {
  const target = { ...(base || {}) };
  Object.entries(patch || {}).forEach(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof target[key] === "object" && target[key] !== null) {
      target[key] = mergeConfig(target[key], value);
    } else if (value !== undefined) {
      target[key] = value;
    }
  });
  return target;
}

async function ensureUpgradeRuntime() {
  if (ensured) return;
  await Promise.all([
    ensureDir(PATHS.root),
    ensureDir(PATHS.packages),
    ensureDir(PATHS.tasks),
    ensureDir(PATHS.staging),
    ensureDir(PATHS.downloads),
    ensureDir(PATHS.history),
    ensureDir(PATHS.tmp),
  ]);
  if (!(await exists(PATHS.config))) {
    await writeJsonFileAtomic(PATHS.config, DEFAULT_CONFIG);
  }
  if (!(await exists(PATHS.status))) {
    await writeJsonFileAtomic(PATHS.status, { ...DEFAULT_STATUS, updatedAt: new Date().toISOString() });
  }
  if (!(await exists(PATHS.sourcesIndex))) await writeJsonFileAtomic(PATHS.sourcesIndex, { items: [] });
  if (!(await exists(PATHS.packageIndex))) await writeJsonFileAtomic(PATHS.packageIndex, { items: [] });
  if (!(await exists(PATHS.buildIndex))) await writeJsonFileAtomic(PATHS.buildIndex, { items: [] });
  if (!(await exists(PATHS.installIndex))) await writeJsonFileAtomic(PATHS.installIndex, { items: [] });
  if (!(await exists(PATHS.authTokenIndex))) await writeJsonFileAtomic(PATHS.authTokenIndex, { items: [] });
  ensured = true;
}

async function readUpgradeConfig() {
  await ensureUpgradeRuntime();
  const raw = await readJsonFile(PATHS.config, DEFAULT_CONFIG);
  return mergeConfig(DEFAULT_CONFIG, raw || {});
}

async function saveUpgradeConfig(patch = {}) {
  await ensureUpgradeRuntime();
  const current = await readUpgradeConfig();
  const next = mergeConfig(current, patch);
  await writeJsonFileAtomic(PATHS.config, next);
  return next;
}

async function readUpgradeStatus() {
  await ensureUpgradeRuntime();
  const raw = await readJsonFile(PATHS.status, DEFAULT_STATUS);
  return { ...DEFAULT_STATUS, ...(raw || {}) };
}

async function patchUpgradeStatus(patch = {}) {
  await ensureUpgradeRuntime();
  const current = await readUpgradeStatus();
  const next = mergeConfig(current, patch);
  next.updatedAt = new Date().toISOString();
  await writeJsonFileAtomic(PATHS.status, next);
  return next;
}

async function createTask(type, payload = {}, actor = {}) {
  await ensureUpgradeRuntime();
  const now = new Date().toISOString();
  const id = createId("sutask");
  const task = {
    id,
    type: String(type || "unknown"),
    status: "queued",
    progress: 0,
    message: "任务已创建",
    payload,
    result: null,
    error: "",
    actor: {
      userId: String(actor.userId || ""),
      role: String(actor.role || ""),
      username: String(actor.username || ""),
    },
    createdAt: now,
    updatedAt: now,
    startedAt: "",
    finishedAt: "",
    pid: 0,
  };
  await writeJsonFileAtomic(path.join(PATHS.tasks, `${id}.json`), task);
  return task;
}

async function readTask(taskId) {
  await ensureUpgradeRuntime();
  if (!taskId) return null;
  const file = path.join(PATHS.tasks, `${String(taskId)}.json`);
  return await readJsonFile(file, null);
}

async function updateTask(taskId, patch = {}) {
  await ensureUpgradeRuntime();
  const current = (await readTask(taskId)) || {};
  const next = mergeConfig(current, patch);
  next.id = String(taskId || current.id || "");
  next.updatedAt = new Date().toISOString();
  await writeJsonFileAtomic(path.join(PATHS.tasks, `${next.id}.json`), next);
  return next;
}

async function listTasks(limit = 80) {
  await ensureUpgradeRuntime();
  const entries = await fs.readdir(PATHS.tasks).catch(() => []);
  const files = entries.filter((item) => item.endsWith(".json")).sort().reverse();
  const results = [];
  for (const file of files.slice(0, Math.max(1, Number(limit || 80)))) {
    const row = await readJsonFile(path.join(PATHS.tasks, file), null);
    if (row) results.push(row);
  }
  results.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  return results;
}

async function appendHistory(kind, payload = {}) {
  await ensureUpgradeRuntime();
  const now = new Date().toISOString();
  const id = createId("suhis");
  const row = {
    id,
    kind: String(kind || "unknown"),
    createdAt: now,
    ...payload,
  };
  const file = path.join(PATHS.history, `${now.replace(/[:.]/g, "-")}_${id}_${row.kind}.json`);
  await writeJsonFileAtomic(file, row);
  return row;
}

async function listHistory(kind = "", limit = 120) {
  await ensureUpgradeRuntime();
  const entries = await fs.readdir(PATHS.history).catch(() => []);
  const files = entries.filter((item) => item.endsWith(".json")).sort().reverse();
  const list = [];
  for (const file of files) {
    if (list.length >= Math.max(1, Number(limit || 120))) break;
    const row = await readJsonFile(path.join(PATHS.history, file), null);
    if (!row) continue;
    if (kind && String(row.kind || "") !== String(kind)) continue;
    list.push(row);
  }
  return list;
}

async function readIndex(indexPath) {
  await ensureUpgradeRuntime();
  const raw = await readJsonFile(indexPath, { items: [] });
  if (!Array.isArray(raw.items)) raw.items = [];
  return raw;
}

async function writeIndex(indexPath, value) {
  await writeJsonFileAtomic(indexPath, value);
}

async function upsertIndexItem(indexPath, item, key = "id") {
  const db = await readIndex(indexPath);
  const id = String(item?.[key] || "").trim();
  if (!id) return db.items;
  const index = db.items.findIndex((row) => String(row?.[key] || "") === id);
  if (index >= 0) db.items[index] = { ...db.items[index], ...item };
  else db.items.unshift(item);
  db.items = db.items.slice(0, 1000);
  await writeIndex(indexPath, db);
  return db.items;
}

async function listSourceUploads(limit = 120) {
  const db = await readIndex(PATHS.sourcesIndex);
  return db.items.slice(0, Math.max(1, Number(limit || 120)));
}

async function saveSourceUpload(meta) {
  await upsertIndexItem(PATHS.sourcesIndex, meta, "id");
  return meta;
}

async function getSourceUpload(sourceId) {
  const db = await readIndex(PATHS.sourcesIndex);
  return db.items.find((item) => String(item.id || "") === String(sourceId || "")) || null;
}

async function listPackages(limit = 120) {
  const db = await readIndex(PATHS.packageIndex);
  return db.items.slice(0, Math.max(1, Number(limit || 120)));
}

async function savePackageMeta(meta) {
  await upsertIndexItem(PATHS.packageIndex, meta, "id");
  return meta;
}

async function getPackageMeta(packageId) {
  const db = await readIndex(PATHS.packageIndex);
  return db.items.find((item) => String(item.id || "") === String(packageId || "")) || null;
}

async function listBuilds(limit = 120) {
  const db = await readIndex(PATHS.buildIndex);
  return db.items.slice(0, Math.max(1, Number(limit || 120)));
}

async function saveBuildMeta(meta) {
  await upsertIndexItem(PATHS.buildIndex, meta, "id");
  return meta;
}

async function listInstalls(limit = 120) {
  const db = await readIndex(PATHS.installIndex);
  return db.items.slice(0, Math.max(1, Number(limit || 120)));
}

async function saveInstallMeta(meta) {
  await upsertIndexItem(PATHS.installIndex, meta, "id");
  return meta;
}

async function listAuthTokens() {
  const db = await readIndex(PATHS.authTokenIndex);
  return db.items;
}

async function saveAuthTokens(items = []) {
  await writeIndex(PATHS.authTokenIndex, { items: Array.isArray(items) ? items.slice(0, 2000) : [] });
}

module.exports = {
  REPO_ROOT,
  PATHS,
  DEFAULT_CONFIG,
  DEFAULT_STATUS,
  ensureUpgradeRuntime,
  readUpgradeConfig,
  saveUpgradeConfig,
  readUpgradeStatus,
  patchUpgradeStatus,
  createTask,
  readTask,
  updateTask,
  listTasks,
  appendHistory,
  listHistory,
  listSourceUploads,
  saveSourceUpload,
  getSourceUpload,
  listPackages,
  savePackageMeta,
  getPackageMeta,
  listBuilds,
  saveBuildMeta,
  listInstalls,
  saveInstallMeta,
  listAuthTokens,
  saveAuthTokens,
  readJsonFile,
  writeJsonFileAtomic,
  exists,
};
