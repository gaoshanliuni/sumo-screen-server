const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const createId = require("../utils/id");
const HttpError = require("../utils/httpError");
const { PATHS, writeJsonFileAtomic, exists } = require("./system_upgrade_storage.service");

const WINDOWS_HELPER_FILE = path.join(PATHS.tmp, "windows_updater_helper.js");

const WINDOWS_HELPER_SOURCE = `
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

async function copyReplace(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.cp(src, dest, { recursive: true, force: true, errorOnExist: false });
}

async function run() {
  const taskFile = process.argv[2];
  const planFile = process.argv[3];
  if (!taskFile || !planFile) process.exit(2);
  const plan = JSON.parse(await fsp.readFile(planFile, "utf8"));
  const now = new Date().toISOString();
  const writeTask = async (patch) => {
    const current = JSON.parse(await fsp.readFile(taskFile, "utf8"));
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await fsp.writeFile(taskFile, JSON.stringify(next, null, 2), "utf8");
  };

  await writeTask({
    status: "running",
    message: "Windows helper 正在等待主进程释放文件锁",
    startedAt: now,
    progress: 8,
  });
  await sleep(1500);

  const targetRoot = plan.targetRoot;
  const payloadProjectRoot = plan.payloadProjectRoot;
  const backupRoot = plan.backupRoot;
  if (!targetRoot || !payloadProjectRoot) {
    await writeTask({
      status: "failed",
      message: "Windows helper 参数不完整",
      error: "targetRoot/payloadProjectRoot missing",
      finishedAt: new Date().toISOString(),
      progress: 100,
    });
    process.exit(1);
  }

  await writeTask({
    status: "running",
    message: "正在备份当前目录",
    progress: 30,
  });

  if (backupRoot) {
    await fsp.rm(backupRoot, { recursive: true, force: true });
    if (fs.existsSync(targetRoot)) {
      await copyReplace(targetRoot, backupRoot);
    }
  }

  await writeTask({
    status: "running",
    message: "正在替换项目文件",
    progress: 70,
  });

  const parent = path.dirname(targetRoot);
  await fsp.mkdir(parent, { recursive: true });
  await fsp.rm(targetRoot, { recursive: true, force: true });
  await copyReplace(payloadProjectRoot, targetRoot);

  await writeTask({
    status: "success",
    message: "Windows helper 已完成文件替换，请重启服务进程",
    progress: 100,
    finishedAt: new Date().toISOString(),
    result: {
      backupRoot: backupRoot || "",
      targetRoot,
      payloadProjectRoot,
      restartRequired: true,
    },
  });
}

run().catch(async (error) => {
  try {
    const taskFile = process.argv[2];
    if (taskFile) {
      const current = JSON.parse(await fsp.readFile(taskFile, "utf8"));
      const next = {
        ...current,
        status: "failed",
        message: "Windows helper 执行失败",
        error: String(error && error.message ? error.message : error),
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        progress: 100,
      };
      await fsp.writeFile(taskFile, JSON.stringify(next, null, 2), "utf8");
    }
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
`;

async function ensureWindowsHelper() {
  await fs.mkdir(PATHS.tmp, { recursive: true });
  if (!(await exists(WINDOWS_HELPER_FILE))) {
    await fs.writeFile(WINDOWS_HELPER_FILE, WINDOWS_HELPER_SOURCE, "utf8");
  }
  return WINDOWS_HELPER_FILE;
}

async function scheduleWindowsInstall({
  taskId = "",
  taskFile = "",
  payloadProjectRoot = "",
  projectRoot = "",
  backupRoot = "",
}) {
  if (!taskId || !taskFile || !payloadProjectRoot || !projectRoot) {
    throw new HttpError(400, "Windows install 参数不足");
  }
  const helper = await ensureWindowsHelper();
  const planFile = path.join(PATHS.tmp, `win_install_plan_${taskId}.json`);
  await writeJsonFileAtomic(planFile, {
    id: createId("suplan"),
    taskId,
    payloadProjectRoot,
    targetRoot: projectRoot,
    backupRoot,
    createdAt: new Date().toISOString(),
  });
  const child = spawn(process.execPath, [helper, taskFile, planFile], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return {
    helperPid: Number(child.pid || 0),
    helperScript: helper,
    planFile,
    backupRoot,
    targetRoot: projectRoot,
  };
}

function buildLinuxManualInstructions({
  packageId = "",
  packagePath = "",
  projectRootName = "dachicunhouduan",
  runtimeDir = "/opt/app",
}) {
  const safePkgPath = String(packagePath || "").replace(/\\/g, "/");
  const projectRoot = String(projectRootName || "dachicunhouduan");
  const targetRoot = `${String(runtimeDir || "/opt/app").replace(/\/+$/, "")}/${projectRoot}`;
  return {
    mode: "manual_required",
    reason: "linux_or_container_manual_apply",
    steps: [
      `1) 下载升级包（packageId=${packageId}）`,
      `2) 解压升级包到临时目录：unzip ${safePkgPath ? `"${safePkgPath}"` : "<package.zip>"} -d /tmp/ink-upgrade`,
      `3) 确认 payload 根目录存在：/tmp/ink-upgrade/payload/${projectRoot}`,
      `4) 停止当前服务进程（建议由进程管理器执行）`,
      `5) 备份旧目录：cp -a "${targetRoot}" "${targetRoot}.backup.$(date +%Y%m%d%H%M%S)"`,
      `6) 覆盖新目录：rsync -a --delete "/tmp/ink-upgrade/payload/${projectRoot}/" "${targetRoot}/"`,
      "7) 启动服务并检查健康接口 /api/health",
    ],
    targetRoot,
    payloadRoot: `payload/${projectRoot}`,
  };
}

module.exports = {
  scheduleWindowsInstall,
  buildLinuxManualInstructions,
};
