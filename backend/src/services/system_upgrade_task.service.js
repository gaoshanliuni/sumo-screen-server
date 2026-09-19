const path = require("path");
const { spawn } = require("child_process");
const HttpError = require("../utils/httpError");
const {
  REPO_ROOT,
  createTask,
  readTask,
  updateTask,
  listTasks,
  patchUpgradeStatus,
  readUpgradeConfig,
} = require("./system_upgrade_storage.service");

const WORKER_FILE = path.join(REPO_ROOT, "backend", "src", "services", "system_upgrade_worker.js");
const BUSY_STATUSES = new Set(["queued", "running"]);

async function rebuildSubsystemStatus() {
  const cfg = await readUpgradeConfig();
  const tasks = await listTasks(300);
  const busyTasks = tasks.filter((item) => BUSY_STATUSES.has(String(item.status || ""))).length;
  const lastFailed = tasks.find((item) => String(item.status || "") === "failed");
  const lastDone = tasks.find((item) => ["success", "failed", "manual_required"].includes(String(item.status || "")));
  const subsystemStatus = cfg.enabled === false ? "disabled" : busyTasks > 0 ? "busy" : lastFailed ? "error" : "normal";
  const patch = {
    busyTasks,
    subsystemStatus,
  };
  if (lastFailed) {
    patch.lastError = String(lastFailed.error || lastFailed.message || "");
    patch.lastErrorAt = String(lastFailed.finishedAt || lastFailed.updatedAt || "");
  }
  if (lastDone) {
    patch.lastUpgradeResult = {
      taskId: String(lastDone.id || ""),
      status: String(lastDone.status || ""),
      message: String(lastDone.message || ""),
      at: String(lastDone.finishedAt || lastDone.updatedAt || ""),
    };
  }
  await patchUpgradeStatus(patch);
}

async function spawnWorker(taskId = "") {
  if (!taskId) {
    throw new HttpError(500, "任务创建失败：缺少 taskId");
  }
  const child = spawn(process.execPath, [WORKER_FILE, String(taskId)], {
    cwd: path.join(REPO_ROOT, "backend"),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  await updateTask(taskId, {
    pid: Number(child.pid || 0),
    message: "任务已提交到独立 worker",
  });
  return Number(child.pid || 0);
}

async function createAndStartTask({
  type = "unknown",
  payload = {},
  actor = {},
}) {
  const task = await createTask(type, payload, actor);
  await rebuildSubsystemStatus();
  try {
    await spawnWorker(task.id);
    await rebuildSubsystemStatus();
  } catch (error) {
    await updateTask(task.id, {
      status: "failed",
      message: "任务启动失败",
      error: String(error?.message || error),
      finishedAt: new Date().toISOString(),
      progress: 100,
    });
    await rebuildSubsystemStatus();
    throw error;
  }
  return (await readTask(task.id)) || task;
}

async function listTaskSummary(limit = 120) {
  const tasks = await listTasks(limit);
  return tasks.map((task) => ({
    id: String(task.id || ""),
    type: String(task.type || ""),
    status: String(task.status || ""),
    progress: Number(task.progress || 0),
    message: String(task.message || ""),
    createdAt: String(task.createdAt || ""),
    updatedAt: String(task.updatedAt || ""),
    startedAt: String(task.startedAt || ""),
    finishedAt: String(task.finishedAt || ""),
  }));
}

module.exports = {
  BUSY_STATUSES,
  WORKER_FILE,
  rebuildSubsystemStatus,
  createAndStartTask,
  listTaskSummary,
};
