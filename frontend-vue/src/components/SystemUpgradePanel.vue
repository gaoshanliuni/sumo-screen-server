<template>
  <div class="system-upgrade-wrap">
    <el-card>
      <template #header>
        <div class="su-header">
          <strong>系统升级</strong>
          <div class="row-actions">
            <el-button :loading="loading.runtime" @click="refreshAll">刷新</el-button>
          </div>
        </div>
      </template>
      <el-row :gutter="12">
        <el-col :md="12" :xs="24">
          <el-descriptions :column="1" border size="small" title="当前系统信息">
            <el-descriptions-item label="当前版本">{{ runtime.release.version || "-" }}</el-descriptions-item>
            <el-descriptions-item label="Channel">{{ runtime.release.channel || "-" }}</el-descriptions-item>
            <el-descriptions-item label="Build">{{ runtime.release.buildId || "-" }}</el-descriptions-item>
            <el-descriptions-item label="Build Time">{{ formatTime(runtime.release.buildTime) }}</el-descriptions-item>
            <el-descriptions-item label="开发构建">
              <el-tag :type="runtime.release.developerBuild ? 'warning' : 'success'">
                {{ runtime.release.developerBuild ? "是" : "否" }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="平台">{{ runtime.runtime.platform || "-" }}</el-descriptions-item>
            <el-descriptions-item label="容器环境">
              <el-tag :type="runtime.runtime.container ? 'warning' : 'info'">
                {{ runtime.runtime.container ? "是" : "否" }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="子系统状态">
              <el-tag :type="subsystemStatusType">{{ runtime.runtime.subsystemStatus || "unknown" }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="最近升级结果">
              {{ runtime.runtime.lastUpgradeResult?.status || "-" }} / {{ runtime.runtime.lastUpgradeResult?.message || "-" }}
            </el-descriptions-item>
            <el-descriptions-item label="待安装包">
              {{ runtime.runtime.pendingPackageId || "-" }}
            </el-descriptions-item>
            <el-descriptions-item label="公钥已配置">
              <el-tag :type="runtime.runtime.hasPublicKey ? 'success' : 'danger'">
                {{ runtime.runtime.hasPublicKey ? "是" : "否" }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="允许开发包安装">
              {{ runtime.runtime.allowDevPackageInstall ? "是" : "否" }}
            </el-descriptions-item>
            <el-descriptions-item label="允许开发降级">
              {{ runtime.runtime.allowDevDowngrade ? "是" : "否" }}
            </el-descriptions-item>
            <el-descriptions-item label="升级服务器">
              {{ runtime.runtime.upgradeServerSummary?.enabled ? (runtime.runtime.upgradeServerSummary?.baseUrl || "已启用") : "未启用" }}
            </el-descriptions-item>
          </el-descriptions>
        </el-col>
        <el-col :md="12" :xs="24">
          <el-form label-width="140px" size="small">
            <el-form-item label="启用升级子系统">
              <el-switch v-model="configForm.enabled" />
            </el-form-item>
            <el-form-item label="默认 channel">
              <el-select v-model="configForm.channel" style="width: 180px">
                <el-option label="stable" value="stable" />
                <el-option label="dev" value="dev" />
              </el-select>
            </el-form-item>
            <el-form-item label="允许开发包安装">
              <el-switch v-model="configForm.allowDevPackageInstall" />
            </el-form-item>
            <el-form-item label="允许开发降级">
              <el-switch v-model="configForm.allowDevDowngrade" />
            </el-form-item>
            <el-form-item label="允许未签名开发包">
              <el-switch v-model="configForm.allowUnsignedDevPackage" />
            </el-form-item>
            <el-form-item label="允许同版本dev覆盖">
              <el-switch v-model="configForm.allowSameVersionDevReplace" />
            </el-form-item>
            <el-form-item label="升级服务器">
              <el-input v-model="configForm.upgradeServer.baseUrl" placeholder="https://upgrade.example.com" />
            </el-form-item>
            <el-form-item label="latestPath">
              <el-input v-model="configForm.upgradeServer.latestPath" placeholder="/latest" />
            </el-form-item>
            <el-form-item label="server token">
              <el-input v-model="configForm.upgradeServer.token" show-password />
            </el-form-item>
          </el-form>
          <div class="row-actions">
            <el-button type="primary" :loading="loading.saveConfig" @click="saveConfig">保存配置</el-button>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <el-card>
      <template #header><strong>升级安装</strong></template>
      <div class="stack-vertical">
        <div class="row-actions">
          <input ref="packageInputRef" type="file" accept=".zip" @change="onPickPackageZip" />
          <el-button type="primary" :disabled="!packageFile" :loading="loading.uploadPackage" @click="uploadPackageZip">
            上传标准升级包
          </el-button>
          <el-button :loading="loading.fetchRemote" @click="fetchRemote">远程拉取升级包</el-button>
          <el-input v-model="remoteUrl" placeholder="可选：直接指定升级包URL" style="width: 360px" />
        </div>
        <el-table :data="packages" size="small" height="300">
          <el-table-column prop="id" label="包ID" min-width="160" />
          <el-table-column prop="fileName" label="文件名" min-width="200" />
          <el-table-column prop="manifest.version" label="版本" width="110" />
          <el-table-column prop="manifest.channel" label="channel" width="90" />
          <el-table-column label="签名" width="90">
            <template #default="scope">
              <el-tag :type="scope.row.signature?.valid ? 'success' : 'warning'">
                {{ scope.row.signature?.valid ? "通过" : "未通过" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="安装许可" width="120">
            <template #default="scope">
              <el-tag :type="scope.row.installPolicy?.allowInstall ? 'success' : 'danger'">
                {{ scope.row.installPolicy?.allowInstall ? "可安装" : "拒绝" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="拒绝原因" min-width="220">
            <template #default="scope">
              <span>{{ (scope.row.installPolicy?.reasons || []).join("；") || "-" }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="290" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="verifyPackage(scope.row)">校验</el-button>
              <el-button link type="warning" @click="installPackage(scope.row)">安装</el-button>
              <el-button link type="info" @click="downloadPackage(scope.row)">下载</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>

    <el-card>
      <template #header><strong>制作升级包</strong></template>
      <el-alert type="info" :closable="false" show-icon>
        <template #default>
          源码压缩包根目录必须包含 <code>dachicunhouduan/</code>，且其中存在 <code>backend/</code> 与 <code>frontend-vue/</code>。
        </template>
      </el-alert>
      <div class="stack-vertical">
        <div class="row-actions">
          <input ref="sourceInputRef" type="file" accept=".zip" @change="onPickSourceZip" />
          <el-button type="primary" :disabled="!sourceFile" :loading="loading.uploadSource" @click="uploadSourceZip">
            上传源码压缩包
          </el-button>
          <el-tag v-if="latestSourceUpload.id" type="success">当前源包: {{ latestSourceUpload.id }}</el-tag>
          <el-tag v-if="latestSourceUpload.id && !latestSourceUpload.valid" type="danger">源包校验失败</el-tag>
        </div>

        <el-form label-width="150px" size="small">
          <el-form-item label="管理员二次密码">
            <el-input v-model="adminPassword" show-password placeholder="请输入当前管理员密码获取打包token" style="width: 320px" />
            <el-button :loading="loading.adminVerify" @click="verifyAdmin">校验</el-button>
            <el-tag v-if="buildTokenExpireAt" type="warning">Token 到期: {{ formatTime(buildTokenExpireAt) }}</el-tag>
          </el-form-item>
          <el-form-item label="version"><el-input v-model="buildForm.version" /></el-form-item>
          <el-form-item label="channel">
            <el-select v-model="buildForm.channel" style="width: 150px">
              <el-option label="stable" value="stable" />
              <el-option label="dev" value="dev" />
            </el-select>
          </el-form-item>
          <el-form-item label="developerOnly"><el-switch v-model="buildForm.developerOnly" /></el-form-item>
          <el-form-item label="allowDowngrade"><el-switch v-model="buildForm.allowDowngrade" /></el-form-item>
          <el-form-item label="正式签名"><el-switch v-model="buildForm.signAsOfficial" /></el-form-item>
          <el-form-item label="buildId"><el-input v-model="buildForm.buildId" /></el-form-item>
          <el-form-item label="minCompatibleUpdaterVersion"><el-input v-model="buildForm.minCompatibleUpdaterVersion" /></el-form-item>
          <el-form-item label="notes"><el-input v-model="buildForm.notes" type="textarea" :rows="3" /></el-form-item>
        </el-form>
        <div class="row-actions">
          <el-button
            type="primary"
            :disabled="!latestSourceUpload.id || !packageBuildToken"
            :loading="loading.buildPackage"
            @click="startBuildPackage"
          >
            开始制作升级包
          </el-button>
        </div>
      </div>
    </el-card>

    <el-card>
      <template #header><strong>任务与历史</strong></template>
      <el-row :gutter="12">
        <el-col :md="12" :xs="24">
          <el-table :data="runtime.tasks || []" size="small" height="260">
            <el-table-column prop="id" label="任务ID" min-width="160" />
            <el-table-column prop="type" label="类型" width="130" />
            <el-table-column prop="status" label="状态" width="120" />
            <el-table-column prop="progress" label="进度" width="90" />
            <el-table-column prop="message" label="消息" min-width="180" />
          </el-table>
        </el-col>
        <el-col :md="12" :xs="24">
          <el-table :data="historyRows" size="small" height="260">
            <el-table-column prop="createdAt" label="时间" width="170" />
            <el-table-column prop="kind" label="类型" width="180" />
            <el-table-column prop="status" label="状态" width="110" />
            <el-table-column label="详情" min-width="180">
              <template #default="scope">
                <span>{{ historyDetailText(scope.row) }}</span>
              </template>
            </el-table-column>
          </el-table>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus/es/components/message/index.mjs";
import {
  getSystemUpgradeRuntime,
  getSystemUpgradeConfig,
  saveSystemUpgradeConfig,
  verifySystemUpgradeAdmin,
  uploadSystemUpgradeSourceZip,
  startBuildSystemUpgradePackage,
  getSystemUpgradeTask,
  getSystemUpgradeBuiltPackages,
  uploadSystemUpgradePackageZip,
  startSystemUpgradeVerify,
  startSystemUpgradeInstall,
  startSystemUpgradeFetchRemote,
  getSystemUpgradeHistory,
} from "../services/systemUpgrade";

const props = defineProps<{ token: string }>();

const loading = reactive({
  runtime: false,
  saveConfig: false,
  adminVerify: false,
  uploadSource: false,
  buildPackage: false,
  uploadPackage: false,
  fetchRemote: false,
});

const runtime = reactive<any>({
  release: {},
  runtime: {},
  config: {},
  tasks: [],
});
const packages = ref<any[]>([]);
const historyRows = ref<any[]>([]);

const configForm = reactive<any>({
  enabled: true,
  channel: "stable",
  allowDevPackageInstall: false,
  allowDevDowngrade: false,
  allowUnsignedDevPackage: false,
  allowSameVersionDevReplace: false,
  upgradeServer: {
    baseUrl: "",
    latestPath: "/latest",
    token: "",
  },
});

const packageInputRef = ref<HTMLInputElement | null>(null);
const sourceInputRef = ref<HTMLInputElement | null>(null);
const packageFile = ref<File | null>(null);
const sourceFile = ref<File | null>(null);
const remoteUrl = ref("");

const latestSourceUpload = reactive<any>({});
const adminPassword = ref("");
const packageBuildToken = ref("");
const buildTokenExpireAt = ref("");
const buildForm = reactive<any>({
  version: "",
  channel: "stable",
  developerOnly: false,
  allowDowngrade: false,
  signAsOfficial: false,
  notes: "",
  buildId: "",
  minCompatibleUpdaterVersion: "",
});

const pollingTaskIds = ref<Set<string>>(new Set());
let pollTimer: ReturnType<typeof setInterval> | null = null;

const subsystemStatusType = computed(() => {
  const status = String(runtime.runtime?.subsystemStatus || "normal");
  if (status === "normal") return "success";
  if (status === "busy") return "warning";
  if (status === "disabled") return "info";
  return "danger";
});

function formatTime(value: string) {
  if (!value) return "-";
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return value;
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} ${String(
    t.getHours()
  ).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
}

function historyDetailText(row: any) {
  if (!row || typeof row !== "object") return "-";
  if (row.error) return String(row.error);
  if (row.message) return String(row.message);
  if (row.packageId) return `packageId=${row.packageId}`;
  return "-";
}

function applyConfigToForm(cfg: any) {
  configForm.enabled = cfg?.enabled !== false;
  configForm.channel = String(cfg?.channel || "stable");
  configForm.allowDevPackageInstall = Boolean(cfg?.allowDevPackageInstall);
  configForm.allowDevDowngrade = Boolean(cfg?.allowDevDowngrade);
  configForm.allowUnsignedDevPackage = Boolean(cfg?.allowUnsignedDevPackage);
  configForm.allowSameVersionDevReplace = Boolean(cfg?.allowSameVersionDevReplace);
  configForm.upgradeServer.baseUrl = String(cfg?.upgradeServer?.baseUrl || "");
  configForm.upgradeServer.latestPath = String(cfg?.upgradeServer?.latestPath || "/latest");
  configForm.upgradeServer.token = String(cfg?.upgradeServer?.token || "");
}

async function loadRuntime() {
  if (!props.token) return;
  loading.runtime = true;
  try {
    const [rt, cfg, built, hist] = await Promise.all([
      getSystemUpgradeRuntime(props.token),
      getSystemUpgradeConfig(props.token),
      getSystemUpgradeBuiltPackages(props.token),
      getSystemUpgradeHistory(props.token),
    ]);
    Object.assign(runtime, rt || {});
    applyConfigToForm(cfg || {});
    packages.value = Array.isArray(built?.packages) ? built.packages : [];
    const src = Array.isArray(built?.sources) ? built.sources : [];
    if (src.length) Object.assign(latestSourceUpload, src[0]);
    historyRows.value = Array.isArray(hist) ? hist : [];
  } catch (error: any) {
    ElMessage.error(error?.message || "加载系统升级信息失败");
  } finally {
    loading.runtime = false;
  }
}

async function saveConfig() {
  if (!props.token) return;
  loading.saveConfig = true;
  try {
    const payload = {
      enabled: configForm.enabled,
      channel: configForm.channel,
      allowDevPackageInstall: configForm.allowDevPackageInstall,
      allowDevDowngrade: configForm.allowDevDowngrade,
      allowUnsignedDevPackage: configForm.allowUnsignedDevPackage,
      allowSameVersionDevReplace: configForm.allowSameVersionDevReplace,
      upgradeServer: {
        baseUrl: configForm.upgradeServer.baseUrl,
        latestPath: configForm.upgradeServer.latestPath,
        token: configForm.upgradeServer.token,
      },
    };
    await saveSystemUpgradeConfig(props.token, payload);
    ElMessage.success("升级配置已保存");
    await loadRuntime();
  } catch (error: any) {
    ElMessage.error(error?.message || "保存配置失败");
  } finally {
    loading.saveConfig = false;
  }
}

function onPickSourceZip(event: Event) {
  const input = event.target as HTMLInputElement;
  sourceFile.value = input?.files?.[0] || null;
}

function onPickPackageZip(event: Event) {
  const input = event.target as HTMLInputElement;
  packageFile.value = input?.files?.[0] || null;
}

async function uploadSourceZip() {
  if (!props.token || !sourceFile.value) return;
  loading.uploadSource = true;
  try {
    const meta = await uploadSystemUpgradeSourceZip(props.token, sourceFile.value);
    Object.assign(latestSourceUpload, meta || {});
    ElMessage.success("源码压缩包已上传并校验");
    sourceFile.value = null;
    if (sourceInputRef.value) sourceInputRef.value.value = "";
    await loadRuntime();
  } catch (error: any) {
    ElMessage.error(error?.message || "源码压缩包上传失败");
  } finally {
    loading.uploadSource = false;
  }
}

async function verifyAdmin() {
  if (!props.token) return;
  if (!adminPassword.value.trim()) {
    ElMessage.warning("请输入管理员密码");
    return;
  }
  loading.adminVerify = true;
  try {
    const result = await verifySystemUpgradeAdmin(props.token, adminPassword.value.trim());
    packageBuildToken.value = String(result.packageBuildToken || "");
    buildTokenExpireAt.value = String(result.expireAt || "");
    adminPassword.value = "";
    ElMessage.success("二次校验通过，已获取打包token");
  } catch (error: any) {
    packageBuildToken.value = "";
    buildTokenExpireAt.value = "";
    ElMessage.error(error?.message || "管理员密码校验失败");
  } finally {
    loading.adminVerify = false;
  }
}

function trackTask(taskId: string) {
  if (!taskId) return;
  pollingTaskIds.value.add(taskId);
}

async function startBuildPackage() {
  if (!props.token || !latestSourceUpload.id) {
    ElMessage.warning("请先上传并通过校验的源码压缩包");
    return;
  }
  if (!packageBuildToken.value) {
    ElMessage.warning("请先完成管理员二次校验");
    return;
  }
  loading.buildPackage = true;
  try {
    const task = await startBuildSystemUpgradePackage(props.token, {
      sourceId: latestSourceUpload.id,
      packageBuildToken: packageBuildToken.value,
      options: { ...buildForm },
    });
    trackTask(String(task.id || ""));
    packageBuildToken.value = "";
    buildTokenExpireAt.value = "";
    ElMessage.success("制作任务已创建");
    await loadRuntime();
  } catch (error: any) {
    ElMessage.error(error?.message || "制作升级包失败");
  } finally {
    loading.buildPackage = false;
  }
}

async function uploadPackageZip() {
  if (!props.token || !packageFile.value) return;
  loading.uploadPackage = true;
  try {
    const result = await uploadSystemUpgradePackageZip(props.token, packageFile.value);
    packageFile.value = null;
    if (packageInputRef.value) packageInputRef.value.value = "";
    ElMessage.success(`升级包已上传: ${result?.id || ""}`);
    await loadRuntime();
  } catch (error: any) {
    ElMessage.error(error?.message || "升级包上传失败");
  } finally {
    loading.uploadPackage = false;
  }
}

async function fetchRemote() {
  if (!props.token) return;
  loading.fetchRemote = true;
  try {
    const task = await startSystemUpgradeFetchRemote(props.token, {
      url: remoteUrl.value.trim() || undefined,
    });
    trackTask(String(task.id || ""));
    ElMessage.success("远程拉取任务已创建");
    await loadRuntime();
  } catch (error: any) {
    ElMessage.error(error?.message || "远程拉取失败");
  } finally {
    loading.fetchRemote = false;
  }
}

async function verifyPackage(row: any) {
  if (!props.token || !row?.id) return;
  try {
    const task = await startSystemUpgradeVerify(props.token, String(row.id));
    trackTask(String(task.id || ""));
    ElMessage.success("校验任务已创建");
  } catch (error: any) {
    ElMessage.error(error?.message || "创建校验任务失败");
  }
}

async function installPackage(row: any) {
  if (!props.token || !row?.id) return;
  try {
    const task = await startSystemUpgradeInstall(props.token, String(row.id));
    trackTask(String(task.id || ""));
    ElMessage.success("安装任务已创建");
  } catch (error: any) {
    ElMessage.error(error?.message || "创建安装任务失败");
  }
}

async function downloadPackage(row: any) {
  if (!props.token || !row?.id) return;
  try {
    const url = `/api/system-upgrade/packages/${encodeURIComponent(String(row.id))}/download`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${props.token}`,
      },
    });
    if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}`);
    const blob = await resp.blob();
    const link = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = row.fileName || `${row.id}.zip`;
    link.click();
    URL.revokeObjectURL(objectUrl);
  } catch (error: any) {
    ElMessage.error(error?.message || "下载失败");
  }
}

async function pollTasks() {
  if (!props.token || pollingTaskIds.value.size === 0) return;
  const doneIds: string[] = [];
  for (const taskId of pollingTaskIds.value.values()) {
    try {
      const task = await getSystemUpgradeTask(props.token, taskId);
      if (["success", "failed", "manual_required"].includes(String(task?.status || ""))) {
        doneIds.push(taskId);
      }
    } catch (_) {
      doneIds.push(taskId);
    }
  }
  doneIds.forEach((id) => pollingTaskIds.value.delete(id));
  if (doneIds.length) {
    await loadRuntime();
  }
}

async function refreshAll() {
  await loadRuntime();
}

onMounted(async () => {
  await loadRuntime();
  pollTimer = setInterval(() => {
    pollTasks().catch(() => undefined);
  }, 2500);
});

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>

<style scoped>
.system-upgrade-wrap {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}

.su-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
