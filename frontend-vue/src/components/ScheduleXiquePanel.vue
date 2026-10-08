<template>
  <el-card class="xique-panel" shadow="never">
    <template #header>
      <div class="xique-header">
        <div class="xique-header-left">
          <strong>从喜鹊导入</strong>
          <div class="xique-subtitle">每天 06:00-24:00 按频率自动同步，00:00-06:00 暂停；优先自动识别验证码，连续失败 2 次后回退手动输入。</div>
        </div>
        <div class="xique-header-right">
          <el-tag :type="stateTagType" effect="light">{{ stateTagLabel }}</el-tag>
          <el-button link type="primary" :loading="statusLoading" @click="loadStatus">刷新状态</el-button>
        </div>
      </div>
    </template>

    <el-alert
      v-if="statusAlertText"
      :title="statusAlertText"
      :type="statusAlertType"
      :closable="false"
      show-icon
      class="xique-alert"
    />

    <el-row :gutter="16">
      <el-col :xs="24" :lg="12">
        <el-form class="xique-form" :model="configDraft" label-width="118px" size="small">
          <el-form-item label="自动更新课程表">
            <el-switch v-model="configDraft.enabled" :loading="configSaving" @change="queueConfigSave" />
          </el-form-item>
          <el-form-item label="更新频率">
            <el-select v-model="configDraft.intervalMinutes" :disabled="!configDraft.enabled" style="width:100%" @change="queueConfigSave">
              <el-option label="10分钟" :value="10" />
              <el-option label="30分钟" :value="30" />
              <el-option label="1小时" :value="60" />
            </el-select>
          </el-form-item>
          <el-form-item label="学年/学期">
            <el-input v-model="configDraft.currentTermKey" placeholder="可选，例如 2025-S2" clearable @change="queueConfigSave" />
          </el-form-item>
        </el-form>

        <div class="xique-note">
          <div>说明：</div>
          <div>1. 自动同步仅在 06:00-24:00 执行，00:00-06:00 暂停。</div>
          <div>2. 登录态失效、验证码失效或连续失败时，会提示重新验证。</div>
          <div>3. 这里的自动更新设置仅作用于课程表同步，不影响主页下发逻辑。</div>
        </div>
      </el-col>

      <el-col :xs="24" :lg="12">
        <el-descriptions border size="small" :column="1" class="xique-descriptions">
          <el-descriptions-item label="目标设备">
            {{ deviceLabel || "请先选择设备" }}
          </el-descriptions-item>
          <el-descriptions-item label="当前状态">
            {{ statusText }}
          </el-descriptions-item>
          <el-descriptions-item label="最近成功">
            {{ formatDateTime(status?.config?.lastSuccessAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="下次执行">
            {{ formatDateTime(status?.config?.nextRunAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="失败次数">
            {{ status?.config?.failureCount ?? 0 }}
          </el-descriptions-item>
          <el-descriptions-item label="教务账号">
            {{ status?.config?.loginUsername || "未配置" }}
          </el-descriptions-item>
        </el-descriptions>

        <div class="xique-actions">
          <el-button type="primary" :disabled="!deviceId" :loading="dialogOpening" @click="openImportDialog">从喜鹊导入</el-button>
          <el-button :disabled="!canReverify" :loading="dialogOpening" @click="openReverifyDialog">重新验证</el-button>
        </div>

        <el-divider class="xique-divider" />

        <div class="xique-log-title">最近同步日志</div>
        <div v-if="recentLogs.length" class="xique-log-list">
          <div v-for="log in recentLogs" :key="log.id" class="xique-log-item">
            <div class="xique-log-top">
              <span class="xique-log-time">{{ formatDateTime(log.createdAt) }}</span>
              <el-tag size="small" :type="logTagType(log.status)">{{ String(log.action || "sync") }}</el-tag>
            </div>
            <div class="xique-log-detail">{{ logDetailText(log) }}</div>
          </div>
        </div>
        <div v-else class="xique-log-empty">暂无同步日志</div>
      </el-col>
    </el-row>
  </el-card>

  <el-dialog
    v-model="dialogVisible"
    :title="dialogTitle"
    width="min(92vw, 980px)"
    top="6vh"
    append-to-body
    destroy-on-close
    @closed="resetDialogSecrets"
  >
    <el-alert :type="dialogAlertType" :closable="false" show-icon :title="dialogAlertText" class="xique-dialog-alert" />

    <el-form :model="dialogForm" label-width="120px" size="small" class="xique-dialog-form">
      <el-row :gutter="16">
        <el-col :xs="24" :md="12">
          <el-form-item label="教务系统账号">
            <el-input v-model="dialogForm.loginUsername" autocomplete="off" placeholder="请输入教务系统账号" />
          </el-form-item>
          <el-form-item label="教务系统密码">
            <el-input v-model="dialogForm.password" type="password" show-password autocomplete="off" placeholder="请输入教务系统密码" />
          </el-form-item>
          <el-form-item label="学年/学期">
            <el-input v-model="dialogForm.currentTermKey" placeholder="可选，例如 2025-S2" />
          </el-form-item>
          <el-form-item label="自动更新课程表">
            <el-switch v-model="dialogForm.enabled" />
          </el-form-item>
          <el-form-item label="更新频率">
            <el-select v-model="dialogForm.intervalMinutes" :disabled="!dialogForm.enabled" style="width:100%">
              <el-option label="10分钟" :value="10" />
              <el-option label="30分钟" :value="30" />
              <el-option label="1小时" :value="60" />
            </el-select>
          </el-form-item>
          <el-form-item label="自动识别验证码">
            <el-switch v-model="dialogForm.preferAutoOcr" />
          </el-form-item>
        </el-col>

        <el-col :xs="24" :md="12">
          <el-form-item v-if="captchaVisible" label="验证码输入">
            <el-input
              v-model="dialogForm.captchaAnswer"
              placeholder="请输入验证码"
              autocomplete="off"
              @focus="handleCaptchaInputFocus"
            />
          </el-form-item>
          <el-form-item v-if="captchaVisible" label="验证码图片">
            <div class="captcha-box">
              <img :src="dialogForm.captchaImage" alt="captcha" class="captcha-image captcha-image-clickable" @click="reloadCaptcha" />
              <el-button size="small" :loading="dialogOpening" @click="reloadCaptcha">刷新验证码</el-button>
              <div class="captcha-meta">
                <div>验证码会话：{{ shortId(dialogForm.captchaSession) || "-" }}</div>
                <div>过期时间：{{ formatDateTime(dialogForm.captchaExpiresAt) }}</div>
              </div>
            </div>
          </el-form-item>
          <el-form-item v-else label="验证码">
            <div class="captcha-placeholder">当前未检测到验证码。若开启“自动识别验证码”，提交时会先自动识别，失败后再回退手动输入。</div>
          </el-form-item>
        </el-col>
      </el-row>
    </el-form>

    <template #footer>
      <div class="dialog-actions">
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button :loading="dialogOpening" @click="reloadCaptcha">{{ dialogMode === 'reverify' ? '重新拉取验证码' : '刷新登录态' }}</el-button>
        <el-button type="primary" :loading="dialogSubmitting" @click="submitDialog">
          {{ dialogMode === 'reverify' ? '完成验证' : '开始导入' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus/es/components/message/index.mjs";
import {
  fetchXiqueStatus,
  initXiqueLogin,
  normalizeXiqueConfig,
  reverifyXiqueLogin,
  saveXiqueConfig,
  startXiqueImport,
  verifyXiqueCaptcha,
  type XiqueImportResponse,
  type XiqueInitLoginResponse,
  type XiqueScheduleConfig,
  type XiqueStatusResponse,
} from "../services/xique";

type DialogMode = "import" | "reverify";

const props = defineProps<{
  deviceId: string;
  token?: string | null;
  deviceLabel?: string;
}>();

const emit = defineEmits<{
  (event: "updated"): void;
}>();

const statusLoading = ref(false);
const configSaving = ref(false);
const dialogOpening = ref(false);
const dialogSubmitting = ref(false);
const dialogVisible = ref(false);
const dialogMode = ref<DialogMode>("import");
const dialogAlertText = ref("请先打开导入弹窗，后端会探测当前登录态并按需返回验证码。");
const dialogAlertType = ref<"info" | "warning" | "success" | "error">("info");
const status = ref<XiqueStatusResponse | null>(null);
const configSaveLocked = ref(false);
const configSaveTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const lastCaptchaRefreshAt = ref(0);
const dialogTaskId = ref("");

const configDraft = reactive({
  enabled: false,
  intervalMinutes: 60 as 10 | 30 | 60,
  currentTermKey: "",
});

const dialogForm = reactive({
  loginUsername: "",
  password: "",
  currentTermKey: "",
  enabled: false,
  intervalMinutes: 60 as 10 | 30 | 60,
  preferAutoOcr: true,
  captchaSession: "",
  captchaAnswer: "",
  captchaImage: "",
  captchaExpiresAt: "",
});


function shortId(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 10) return raw;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

function formatDateTime(value?: string) {
  const raw = String(value || "").trim();
  if (!raw) return "-";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function logTagType(statusValue?: string) {
  const value = String(statusValue || "").toLowerCase();
  if (value === "success") return "success";
  if (value === "warn" || value === "warning") return "warning";
  if (value === "error" || value === "failed") return "danger";
  return "info";
}

function logDetailText(log: Record<string, any>) {
  const detail = log?.detail;
  if (!detail) return "无详细信息";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch (_) {
    return "日志详情解析失败";
  }
}

function cloneConfig(input?: XiqueScheduleConfig | null) {
  const cfg = normalizeXiqueConfig(
    input || { deviceId: props.deviceId, enabled: false, intervalMinutes: 60, currentTermKey: "" }
  );
  return {
    enabled: cfg.enabled,
    intervalMinutes: cfg.intervalMinutes,
    currentTermKey: cfg.currentTermKey || "",
  };
}

function resetDialogSecrets() {
  dialogForm.password = "";
  dialogForm.captchaAnswer = "";
  dialogTaskId.value = "";
}

function syncConfigDraft(next?: XiqueScheduleConfig | null) {
  configSaveLocked.value = true;
  const cfg = cloneConfig(next || status.value?.config || null);
  configDraft.enabled = cfg.enabled;
  configDraft.intervalMinutes = cfg.intervalMinutes;
  configDraft.currentTermKey = cfg.currentTermKey;
  setTimeout(() => {
    configSaveLocked.value = false;
  }, 0);
}

function syncDialogBase(next?: XiqueScheduleConfig | null) {
  const cfg = cloneConfig(next || status.value?.config || null);
  dialogForm.loginUsername = String((next?.loginUsername || status.value?.config?.loginUsername || "") as string);
  dialogForm.currentTermKey = cfg.currentTermKey;
  dialogForm.enabled = cfg.enabled;
  dialogForm.intervalMinutes = cfg.intervalMinutes;
}

function syncDialogCaptcha(response?: Partial<XiqueInitLoginResponse> | Partial<XiqueImportResponse> | null) {
  dialogForm.captchaSession = String(response?.captchaSession || "");
  dialogForm.captchaImage = String(response?.captchaImage || "");
  dialogForm.captchaExpiresAt = String(response?.captchaExpiresAt || "");
  dialogForm.captchaAnswer = "";
  if (response?.taskId || response?.configId) {
    dialogTaskId.value = String(response?.taskId || response?.configId || "");
  }
}

const recentLogs = computed(() => {
  const logs = Array.isArray(status.value?.logs) ? status.value?.logs : [];
  return logs.slice(0, 6);
});

const canReverify = computed(() => Boolean(status.value?.config?.needCaptchaReverify || status.value?.session?.needCaptchaReverify || status.value?.config?.paused));

const stateTagLabel = computed(() => {
  if (!props.deviceId) return "未选择设备";
  if (status.value?.config?.needCaptchaReverify || status.value?.session?.needCaptchaReverify) return "需要重新验证";
  if (status.value?.config?.paused) return "已暂停";
  if (status.value?.config?.enabled) return "自动更新中";
  return "未启用自动更新";
});

const stateTagType = computed<"info" | "success" | "warning" | "danger">(() => {
  if (!props.deviceId) return "info";
  if (status.value?.config?.needCaptchaReverify || status.value?.session?.needCaptchaReverify) return "warning";
  if (status.value?.config?.paused) return "danger";
  if (status.value?.config?.enabled) return "success";
  return "info";
});

const statusText = computed(() => {
  if (!props.deviceId) return "Please select a schedule device.";
  if (status.value?.config?.needCaptchaReverify || status.value?.session?.needCaptchaReverify) return "Need Xique reverify.";
  if (status.value?.config?.paused) return `Paused: ${status.value?.config?.pauseReason || "unknown reason"}`;
  if (status.value?.config?.enabled) return `Auto sync enabled (${status.value?.config?.intervalMinutes || 60} min)`;
  return "Manual import only";
});

const statusAlertText = computed(() => {
  if (!props.deviceId) return "Please select a schedule device first.";
  if (status.value?.config?.needCaptchaReverify || status.value?.session?.needCaptchaReverify) return "Xique login expired. Please reverify.";
  if (status.value?.config?.paused) return `Auto sync paused: ${status.value?.config?.pauseReason || "check repeated failures"}`;
  return "Xique import/sync only updates schedule data.";
});

const statusAlertType = computed<"info" | "warning" | "success" | "error">(() => {
  if (!props.deviceId) return "info";
  if (status.value?.config?.needCaptchaReverify || status.value?.session?.needCaptchaReverify) return "warning";
  if (status.value?.config?.paused) return "error";
  return "info";
});

const captchaVisible = computed(() => Boolean(dialogForm.captchaImage) && !dialogForm.preferAutoOcr);
const dialogTitle = computed(() => (dialogMode.value === "reverify" ? "重新验证喜鹊登录" : "从喜鹊导入课程表"));

async function loadStatus(silent = false) {
  if (!props.token || !props.deviceId) {
    status.value = null;
    syncConfigDraft(null);
    return;
  }
  statusLoading.value = true;
  try {
    const data = await fetchXiqueStatus(props.token, props.deviceId);
    status.value = data;
    syncConfigDraft(data.config);
  } catch (error) {
    if (!silent) {
      ElMessage.error((error as Error).message || "加载喜鹊状态失败");
    }
  } finally {
    statusLoading.value = false;
  }
}

function queueConfigSave() {
  if (configSaveLocked.value || !props.token || !props.deviceId) return;
  if (configSaveTimer.value) {
    clearTimeout(configSaveTimer.value);
  }
  configSaveTimer.value = setTimeout(() => {
    void saveConfigNow();
  }, 400);
}

async function saveConfigNow(overrides?: Partial<{ loginUsername: string; loginDisplayName: string; currentTermKey: string }>) {
  if (!props.token || !props.deviceId) return;
  configSaving.value = true;
  try {
    const payload = {
      deviceId: props.deviceId,
      enabled: Boolean(configDraft.enabled),
      intervalMinutes: configDraft.intervalMinutes,
      currentTermKey: String(overrides?.currentTermKey || configDraft.currentTermKey || status.value?.config?.currentTermKey || ""),
      loginUsername: String((overrides?.loginUsername ?? status.value?.config?.loginUsername) || ""),
      loginDisplayName: String((overrides?.loginDisplayName ?? status.value?.config?.loginDisplayName) || ""),
    };
    const result = await saveXiqueConfig(props.token, payload);
    status.value = {
      deviceId: props.deviceId,
      config: result.config,
      session: result.session,
      logs: status.value?.logs || [],
    };
    syncConfigDraft(result.config);
  } catch (error) {
    ElMessage.error((error as Error).message || "保存喜鹊自动更新配置失败");
  } finally {
    configSaving.value = false;
  }
}

function prepareDialogFromStatus() {
  syncDialogBase(status.value?.config || null);
  dialogForm.preferAutoOcr = true;
  resetDialogSecrets();
  syncDialogCaptcha(null);
  dialogAlertText.value = "正在请求登录态，请稍候...";
  dialogAlertType.value = "info";
}

async function openImportDialog() {
  if (!props.token || !props.deviceId) {
    ElMessage.warning("请先选择课程表设备");
    return;
  }
  dialogMode.value = "import";
  dialogOpening.value = true;
  dialogVisible.value = true;
  prepareDialogFromStatus();
  try {
    const response = await initXiqueLogin(props.token, {
      deviceId: props.deviceId,
      adapterMode: "remote",
      autoOcrEnabled: dialogForm.preferAutoOcr,
      currentTermKey: dialogForm.currentTermKey,
      enabled: dialogForm.enabled,
      intervalMinutes: dialogForm.intervalMinutes,
      loginUsername: dialogForm.loginUsername,
    });
    syncDialogBase(status.value?.config || null);
    if (response.captchaRequired) {
      syncDialogCaptcha(response);
      if (dialogForm.preferAutoOcr) {
        dialogAlertText.value = "已检测到验证码，提交时将优先自动识别；若失败会回退手动输入。";
        dialogAlertType.value = "info";
      } else {
        dialogAlertText.value = "后端已检测到验证码，请填写验证码后继续导入。";
        dialogAlertType.value = "warning";
      }
    } else {
      syncDialogCaptcha(null);
      dialogAlertText.value = response.loginRequired ? "Please input account/password to continue." : "Login session ready, you can import now.";
      dialogAlertType.value = "success";
    }
  } catch (error) {
    dialogAlertText.value = (error as Error).message || "初始化登录流程失败";
    dialogAlertType.value = "error";
    ElMessage.error(dialogAlertText.value);
  } finally {
    dialogOpening.value = false;
  }
}

async function openReverifyDialog() {
  if (!props.token || !props.deviceId) {
    ElMessage.warning("请先选择课程表设备");
    return;
  }
  dialogMode.value = "reverify";
  dialogOpening.value = true;
  dialogVisible.value = true;
  prepareDialogFromStatus();
  dialogAlertText.value = "正在拉取重新验证所需的验证码...";
  dialogAlertType.value = "info";
  try {
    const response = await reverifyXiqueLogin(props.token, {
      deviceId: props.deviceId,
      adapterMode: "remote",
      autoOcrEnabled: dialogForm.preferAutoOcr,
      currentTermKey: dialogForm.currentTermKey,
      enabled: dialogForm.enabled,
      intervalMinutes: dialogForm.intervalMinutes,
      loginUsername: dialogForm.loginUsername,
    });
    syncDialogBase(status.value?.config || null);
    if (response.captchaRequired) {
      syncDialogCaptcha(response);
      if (dialogForm.preferAutoOcr) {
        dialogAlertText.value = "将优先自动识别验证码完成重验证；失败后可改为手动输入。";
        dialogAlertType.value = "info";
      } else {
        dialogAlertText.value = "请输入验证码完成重新验证。";
        dialogAlertType.value = "warning";
      }
    } else {
      syncDialogCaptcha(null);
      dialogAlertText.value = "重新验证已就绪，无需验证码。";
      dialogAlertType.value = "success";
    }
  } catch (error) {
    dialogAlertText.value = (error as Error).message || "重新验证失败";
    dialogAlertType.value = "error";
    ElMessage.error(dialogAlertText.value);
  } finally {
    dialogOpening.value = false;
  }
}

async function reloadCaptcha() {
  if (!props.token || !props.deviceId) {
    ElMessage.warning("请先选择课程表设备");
    return;
  }
  dialogOpening.value = true;
  try {
    const payload = {
      deviceId: props.deviceId,
      adapterMode: "remote",
      currentTermKey: dialogForm.currentTermKey,
      enabled: dialogForm.enabled,
      intervalMinutes: dialogForm.intervalMinutes,
      autoOcrEnabled: dialogForm.preferAutoOcr,
      loginUsername: dialogForm.loginUsername,
      requireCaptcha: true,
      forceCaptcha: dialogMode.value === "reverify",
    };
    const response = dialogMode.value === "reverify"
      ? await reverifyXiqueLogin(props.token, payload)
      : await initXiqueLogin(props.token, payload);
    if (response.captchaRequired) {
      syncDialogCaptcha(response);
      if (dialogForm.preferAutoOcr) {
        dialogAlertText.value = "验证码已刷新，自动识别模式下将不显示验证码输入框。";
        dialogAlertType.value = "info";
      } else {
        dialogAlertText.value = "验证码已刷新，请输入新验证码。";
        dialogAlertType.value = "warning";
      }
    } else {
      syncDialogCaptcha(null);
      dialogAlertText.value = "当前会话无需验证码，可直接导入。";
      dialogAlertType.value = "success";
    }
  } catch (error) {
    dialogAlertText.value = (error as Error).message || "刷新验证码失败";
    dialogAlertType.value = "error";
    ElMessage.error(dialogAlertText.value);
  } finally {
    dialogOpening.value = false;
  }
}

async function handleCaptchaInputFocus() {
  const now = Date.now();
  if (now - lastCaptchaRefreshAt.value < 800) return;
  lastCaptchaRefreshAt.value = now;
  await reloadCaptcha();
}

async function submitDialog() {
  if (!props.token || !props.deviceId) {
    ElMessage.warning("请先选择课程表设备");
    return;
  }
  if (!dialogForm.loginUsername.trim()) {
    ElMessage.warning("请输入教务系统账号");
    return;
  }
  if (!dialogForm.password.trim()) {
    ElMessage.warning("请输入教务系统密码");
    return;
  }

  dialogSubmitting.value = true;
  try {
    const commonPayload = {
      deviceId: props.deviceId,
      adapterMode: "remote",
      loginUsername: dialogForm.loginUsername.trim(),
      password: dialogForm.password,
      currentTermKey: dialogForm.currentTermKey.trim(),
      enabled: Boolean(dialogForm.enabled),
      intervalMinutes: dialogForm.intervalMinutes as 10 | 30 | 60,
    };

    const manualCaptcha = dialogForm.captchaAnswer.trim();
    const autoCaptchaEnabled = Boolean(dialogForm.preferAutoOcr);
    if (!manualCaptcha && captchaVisible.value && !autoCaptchaEnabled) {
      ElMessage.warning("请先输入验证码，或开启“自动识别验证码”");
      dialogSubmitting.value = false;
      return;
    }

    let response: XiqueImportResponse;
    if (manualCaptcha) {
      response = await verifyXiqueCaptcha(props.token, {
        ...commonPayload,
        taskId: dialogTaskId.value || undefined,
        configId: dialogTaskId.value || undefined,
        captchaSession: dialogForm.captchaSession,
        sessionId: dialogForm.captchaSession,
        captchaCode: manualCaptcha,
      });
    } else {
      response = await startXiqueImport(props.token, {
        ...commonPayload,
        forceCaptcha: dialogMode.value === "reverify",
        autoOcrEnabled: autoCaptchaEnabled,
      });
    }

    if (response.status === "need_manual_captcha" || response.status === "captcha_required") {
      if (dialogForm.preferAutoOcr) {
        dialogForm.preferAutoOcr = false;
      }
      syncDialogCaptcha(response);
      const attempts = Number(response.ocrAttempts || response.ocrFailCount || 0);
      dialogAlertText.value = attempts > 0
        ? `自动识别已尝试 ${attempts} 次，现需手动输入验证码。`
        : "当前需要手动输入验证码后继续。";
      dialogAlertType.value = "warning";
      ElMessage.warning("请手动输入验证码");
      return;
    }

    if (response.status !== "imported") {
      dialogAlertText.value = `当前返回状态：${response.status || "unknown"}`;
      dialogAlertType.value = "warning";
      ElMessage.warning(dialogAlertText.value);
      return;
    }

    await saveConfigNow({
      loginUsername: dialogForm.loginUsername.trim(),
      currentTermKey: dialogForm.currentTermKey.trim(),
    });

    const ocrAttempts = Number(response.ocrAttempts || 0);
    dialogAlertText.value = ocrAttempts > 0
      ? `喜鹊课程表导入成功（自动识别尝试 ${ocrAttempts} 次）。`
      : "喜鹊课程表导入成功。";
    dialogAlertType.value = "success";
    dialogVisible.value = false;
    ElMessage.success("喜鹊课程表导入成功");
    await loadStatus(true);
    emit("updated");
  } catch (error) {
    dialogAlertText.value = (error as Error).message || "导入失败";
    dialogAlertType.value = "error";
    ElMessage.error(dialogAlertText.value);
    if (/captcha/i.test(dialogAlertText.value)) {
      await reloadCaptcha();
    }
  } finally {
    dialogSubmitting.value = false;
  }
}

watch(
  () => [props.deviceId, props.token],
  () => {
    void loadStatus(true);
  },
  { immediate: true }
);

watch(
  () => [configDraft.enabled, configDraft.intervalMinutes, configDraft.currentTermKey],
  () => {
    if (!configSaveLocked.value) {
      queueConfigSave();
    }
  }
);

onBeforeUnmount(() => {
  if (configSaveTimer.value) {
    clearTimeout(configSaveTimer.value);
    configSaveTimer.value = null;
  }
});
</script>

<style scoped>
.xique-panel {
  margin-bottom: 12px;
}

.xique-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.xique-header-left {
  display: grid;
  gap: 6px;
}

.xique-header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.xique-subtitle {
  font-size: 12px;
  color: #64748b;
}

.xique-alert {
  margin-bottom: 12px;
}

.xique-form {
  padding-right: 10px;
}

.xique-note {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.7;
  color: #475569;
  background: linear-gradient(180deg, #f8fbff 0%, #ffffff 100%);
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 14px;
}

.xique-descriptions {
  margin-bottom: 12px;
}

.xique-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.xique-divider {
  margin: 14px 0;
}

.xique-log-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.xique-log-list {
  display: grid;
  gap: 10px;
}

.xique-log-item {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fff;
}

.xique-log-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.xique-log-time {
  font-size: 12px;
  color: #64748b;
}

.xique-log-detail {
  margin-top: 6px;
  font-size: 12px;
  color: #334155;
  line-height: 1.6;
  word-break: break-all;
}

.xique-log-empty {
  font-size: 12px;
  color: #64748b;
}

.xique-dialog-alert {
  margin-bottom: 14px;
}

.xique-dialog-form {
  max-height: 66vh;
  overflow: auto;
  padding-right: 4px;
}

.captcha-box {
  display: grid;
  gap: 10px;
  width: 100%;
}

.captcha-image {
  width: 100%;
  max-width: 240px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
}

.captcha-image-clickable {
  cursor: pointer;
}

.captcha-meta {
  font-size: 12px;
  color: #64748b;
  display: grid;
  gap: 2px;
}

.captcha-placeholder {
  font-size: 12px;
  color: #64748b;
  line-height: 1.6;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

@media (max-width: 768px) {
  .xique-header {
    flex-direction: column;
  }

  .xique-form {
    padding-right: 0;
  }

  .xique-dialog-form {
    max-height: none;
  }
}
</style>




