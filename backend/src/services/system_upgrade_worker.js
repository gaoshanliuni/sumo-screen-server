const HttpError = require("../utils/httpError");
const { logOperation } = require("../utils/logging");
const { readTask, updateTask, appendHistory } = require("./system_upgrade_storage.service");
const { executeTaskByType } = require("./system_upgrade.service");
const { rebuildSubsystemStatus } = require("./system_upgrade_task.service");

async function updateProgress(taskId, progress = 0, message = "") {
  await updateTask(taskId, {
    progress: Math.max(0, Math.min(100, Number(progress || 0))),
    message: String(message || ""),
    status: "running",
  });
}

async function runTask(taskId) {
  const task = await readTask(taskId);
  if (!task) {
    throw new HttpError(404, "任务不存在");
  }
  if (["success", "failed", "manual_required"].includes(String(task.status || ""))) {
    return;
  }
  await updateTask(taskId, {
    status: "running",
    startedAt: task.startedAt || new Date().toISOString(),
    message: "任务开始执行",
    progress: 1,
  });
  await rebuildSubsystemStatus();

  try {
    const result = await executeTaskByType({
      task,
      progress: async (p, msg) => {
        await updateProgress(taskId, p, msg);
      },
    });

    const mode = String(result?.mode || "");
    const finalStatus = mode === "manual_required" ? "manual_required" : "success";
    await updateTask(taskId, {
      status: finalStatus,
      progress: 100,
      message: finalStatus === "manual_required" ? "需手动执行安装步骤" : "任务执行成功",
      result,
      finishedAt: new Date().toISOString(),
      error: "",
    });
    await appendHistory("task_finish", {
      taskId,
      type: String(task.type || ""),
      status: finalStatus,
      result,
      at: new Date().toISOString(),
    });
  } catch (error) {
    const msg = String(error?.message || error || "unknown error");
    const actionByType = {
      build_package: "system_upgrade.build_package_failed",
      verify_package: "system_upgrade.verify_reject",
      fetch_remote_package: "system_upgrade.fetch_remote",
      install_package: "system_upgrade.manual_linux",
    };
    await updateTask(taskId, {
      status: "failed",
      progress: 100,
      message: "任务执行失败",
      error: msg,
      finishedAt: new Date().toISOString(),
    });
    await appendHistory("task_failed", {
      taskId,
      type: String(task.type || ""),
      status: "failed",
      error: msg,
      stack: String(error?.stack || ""),
      at: new Date().toISOString(),
    });
    logOperation({
      actorId: task?.actor?.userId || "system",
      actorRole: task?.actor?.role || "system",
      action: actionByType[String(task?.type || "")] || "system_upgrade.task_failed",
      targetType: "system_upgrade_task",
      targetId: String(taskId || ""),
      detail: {
        type: String(task?.type || ""),
        error: msg,
      },
      status: "failed",
    });
  } finally {
    await rebuildSubsystemStatus();
  }
}

async function main() {
  const taskId = String(process.argv[2] || "").trim();
  if (!taskId) process.exit(2);
  try {
    await runTask(taskId);
    process.exit(0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[system-upgrade-worker] fatal:", error?.stack || error?.message || error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runTask,
};
