<template>
  <div class="page">
    <el-card class="panel">
      <template #header>
        <div class="header-row">
          <div>
            <strong>设备模拟（Vue）</strong>
            <div class="sub">真机同链路：login -> auto-register -> bind/status -> login -> stream</div>
          </div>
          <div class="actions">
            <el-button @click="goDocs">API 文档</el-button>
            <el-button @click="goAdmin">返回管理端</el-button>
            <template v-if="auth.token">
              <span class="who">当前用户：{{ auth.username }}</span>
              <el-button type="danger" plain @click="logout">退出登录</el-button>
            </template>
          </div>
        </div>
      </template>

      <div v-if="!auth.token" class="login-wrap">
        <el-form :model="loginForm" label-width="90px" @submit.prevent>
          <el-form-item label="角色">
            <el-select v-model="loginForm.role" style="width: 180px">
              <el-option label="用户" value="user" />
              <el-option label="管理员" value="admin" />
            </el-select>
          </el-form-item>
          <el-form-item label="用户名"><el-input v-model="loginForm.username" autocomplete="username" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="loginForm.password" show-password autocomplete="current-password" /></el-form-item>
          <el-button type="primary" :loading="loginLoading" @click="doLogin">登录并进入模拟</el-button>
        </el-form>
      </div>

      <div v-else class="stack">
        <el-alert type="info" :closable="false" show-icon>
          <template #default>
            模拟器已对齐最新设备能力：支持主页/桌牌/天气图片状态、
            <code>remote.switch_view</code>、<code>remote.refresh_page_image</code>、<code>remote.request_screen_state</code>、
            <code>remote.show_text</code>、<code>remote.show_image</code>、<code>remote.cast_stop</code>。
          </template>
        </el-alert>

        <el-row :gutter="12">
          <el-col :md="12" :xs="24">
            <el-card>
              <template #header>模拟设备选择</template>
              <el-form :model="pickForm" label-width="120px" size="small">
                <el-form-item label="已注册模拟设备">
                  <el-select v-model="pickForm.deviceId" filterable clearable style="width: 100%" placeholder="选择模拟设备">
                    <el-option
                      v-for="d in simulatedDevices"
                      :key="d.id"
                      :label="`${d.displayName || d.id} (${d.mac})`"
                      :value="d.id"
                    />
                  </el-select>
                </el-form-item>
              </el-form>
              <div class="actions">
                <el-button @click="loadSimulatedDevices">刷新列表</el-button>
                <el-button type="primary" :disabled="!pickForm.deviceId" @click="switchToPickedDevice">切换到该设备</el-button>
              </div>
            </el-card>
          </el-col>

          <el-col :md="12" :xs="24">
            <el-card>
              <template #header>新设备启动</template>
              <el-form :model="startForm" label-width="120px" size="small">
                <el-form-item label="MAC（可空）">
                  <el-input v-model="startForm.mac" placeholder="AA:BB:CC:DD:EE:FF（为空自动生成）" />
                </el-form-item>
                <el-form-item label="设备备注"><el-input v-model="startForm.remark" /></el-form-item>
                <el-form-item label="设备类型"><el-input v-model="startForm.type" /></el-form-item>
              </el-form>
              <div class="actions">
                <el-button type="primary" :loading="starting" @click="startSimulatedDeviceFlow">按真机链路启动</el-button>
                <el-button @click="stopBindPoll">停止绑定轮询</el-button>
                <el-button @click="clearLogs">清空日志</el-button>
              </div>
            </el-card>
          </el-col>
        </el-row>

        <el-row :gutter="12">
          <el-col :md="8" :xs="24">
            <el-card>
              <template #header>状态</template>
              <div class="kv"><span>脚本阶段</span><strong>{{ scriptStage }}</strong></div>
              <div class="kv"><span>当前设备</span><strong>{{ currentDeviceLabel }}</strong></div>
              <div class="kv"><span>绑定状态</span><strong>{{ bindStatus }}</strong></div>
              <div class="kv"><span>PIN</span><strong>{{ pinCode || "-" }}</strong></div>
              <div class="kv"><span>PIN有效期</span><strong>{{ pinExpire || "-" }}</strong></div>
              <div class="kv"><span>SSE</span><strong>{{ sseStatus }}</strong></div>
              <div class="kv"><span>WS</span><strong>{{ wsStatus }}</strong></div>
              <div class="kv"><span>当前界面</span><strong>{{ displayState.view || "-" }}</strong></div>
              <div class="kv"><span>最近命令</span><strong class="ellipsis">{{ displayState.lastRemoteCommand || "-" }}</strong></div>
              <div class="kv"><span>最近ACK</span><strong>{{ displayState.lastAckStatus || "-" }}</strong></div>
              <div class="kv"><span>ACK时间</span><strong>{{ displayState.lastAckAt || "-" }}</strong></div>
            </el-card>
          </el-col>

          <el-col :md="8" :xs="24">
            <el-card>
              <template #header>页面图像与投屏状态</template>
              <div class="kv"><span>激活页面类型</span><strong>{{ activePageType }}</strong></div>
              <div class="kv"><span>页面 image_id</span><strong class="ellipsis">{{ displayState.pageImageId || "-" }}</strong></div>
              <div class="kv"><span>页面 etag</span><strong class="ellipsis">{{ displayState.pageEtag || "-" }}</strong></div>
              <div class="kv"><span>页面更新时间</span><strong class="ellipsis">{{ displayState.pageUpdatedAt || "-" }}</strong></div>
              <div class="kv"><span>投屏 file_id</span><strong class="ellipsis">{{ displayState.imageFileId || "-" }}</strong></div>
              <div class="kv"><span>公告模式</span><strong>{{ displayState.announcementMode || "-" }}</strong></div>
              <div class="kv"><span>公告文本</span><strong class="ellipsis">{{ displayState.announcementText || "-" }}</strong></div>

              <div class="actions" style="margin-top: 8px">
                <el-button size="small" @click="refreshAllPageSnapshots('manual')">刷新三页快照</el-button>
                <el-button size="small" @click="refreshCurrentPageSnapshot">刷新当前页</el-button>
              </div>

              <div class="preview-wrap">
                <img v-if="previewImageUrl" :src="previewImageUrl" alt="page preview" class="preview-image" />
                <div v-else class="preview-empty">暂无页面/投屏图片</div>
              </div>
            </el-card>
          </el-col>

          <el-col :md="8" :xs="24">
            <el-card>
              <template #header>阶段日志</template>
              <pre class="log">{{ logs.join("\n") }}</pre>
            </el-card>
          </el-col>
        </el-row>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from "vue";
import { ElMessage } from "element-plus/es/components/message/index.mjs";
import { useRouter } from "vue-router";
import { apiRequest } from "../services/api";
import { useAuthStore } from "../stores/auth";

type AppRole = "user" | "admin";
type DeviceInfo = { id: string; mac: string; displayName?: string; simulated?: boolean };
type PageType = "homepage" | "badgepage" | "weatherpage" | "unknown";

type PageSnapshot = {
  pageType: PageType;
  imageId: string;
  previewUrl: string;
  etag: string;
  updatedAt: string;
  version: number;
};

const auth = useAuthStore();
const router = useRouter();

const loginLoading = ref(false);
const starting = ref(false);

const loginForm = reactive<{ role: AppRole; username: string; password: string }>({
  role: auth.role || "user",
  username: auth.lastUsername || auth.username || "",
  password: "",
});

const startForm = reactive({
  mac: "",
  remark: "模拟设备",
  type: "ink-screen",
});

const pickForm = reactive({
  deviceId: "",
});

const simulatedDevices = ref<DeviceInfo[]>([]);
const scriptStage = ref("IDLE");
const logs = ref<string[]>([]);
const currentDevice = ref<DeviceInfo | null>(null);
const hardwareToken = ref("");
const bootstrapToken = ref("");
const bindStatus = ref("未绑定");
const pinCode = ref("");
const pinExpire = ref("");
const sseStatus = ref("未连接");
const wsStatus = ref("未连接");

const pageSnapshots = reactive<Record<PageType, PageSnapshot>>({
  homepage: { pageType: "homepage", imageId: "", previewUrl: "", etag: "", updatedAt: "", version: 0 },
  badgepage: { pageType: "badgepage", imageId: "", previewUrl: "", etag: "", updatedAt: "", version: 0 },
  weatherpage: { pageType: "weatherpage", imageId: "", previewUrl: "", etag: "", updatedAt: "", version: 0 },
  unknown: { pageType: "unknown", imageId: "", previewUrl: "", etag: "", updatedAt: "", version: 0 },
});

const displayState = reactive({
  view: "",
  announcementText: "",
  announcementMode: "",
  imageFileId: "",
  imageUrl: "",
  pageType: "unknown" as PageType,
  pageImageId: "",
  pageImageUrl: "",
  pageEtag: "",
  pageUpdatedAt: "",
  lastRemoteCommand: "",
  lastAckStatus: "",
  lastAckAt: "",
});

let bindPollTimer: ReturnType<typeof setInterval> | null = null;
let sse: EventSource | null = null;
let ws: WebSocket | null = null;
const recentEventKeys = new Map<string, number>();
const EVENT_DEDUP_WINDOW_MS = 1500;

const currentDeviceLabel = computed(() => {
  if (!currentDevice.value) return "未选择";
  const name = currentDevice.value.displayName ? `${currentDevice.value.displayName} / ` : "";
  return `${name}${currentDevice.value.id} (${currentDevice.value.mac})`;
});

const activePageType = computed<PageType>(() => {
  const fromView = normalizePageType(displayState.view);
  if (fromView !== "unknown") return fromView;
  return displayState.pageType;
});

const previewImageUrl = computed(() => {
  if (displayState.imageUrl) return displayState.imageUrl;
  if (displayState.pageImageUrl) return displayState.pageImageUrl;
  const fallback = pageSnapshots[activePageType.value];
  return fallback?.previewUrl || "";
});

function goAdmin() {
  router.push("/admin");
}

function goDocs() {
  router.push("/docs");
}

function logout() {
  auth.logout();
  resetRuntime();
}

function pushLog(line: string) {
  logs.value.unshift(`[${new Date().toISOString()}] ${line}`);
  logs.value = logs.value.slice(0, 500);
}

function clearLogs() {
  logs.value = [];
}

function logBootStage(stage: string, detail: Record<string, unknown> = {}) {
  scriptStage.value = stage;
  pushLog(`${stage} ${JSON.stringify(detail)}`);
}

function normalizeMac(input: string) {
  return String(input || "").trim().toUpperCase().replace(/-/g, ":");
}

function createRandomMac() {
  const bytes = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256));
  return bytes.map((n) => n.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

function normalizePageType(value: string): PageType {
  const v = String(value || "").trim().toLowerCase();
  if (["home", "homepage"].includes(v)) return "homepage";
  if (["badge", "badgepage", "nameplate"].includes(v)) return "badgepage";
  if (["weather", "weatherpage"].includes(v)) return "weatherpage";
  return "unknown";
}

function pageEndpoint(pageType: PageType) {
  if (pageType === "homepage") return "/api/hardware/homepage";
  if (pageType === "badgepage") return "/api/hardware/badgepage";
  if (pageType === "weatherpage") return "/api/hardware/weatherpage";
  return "";
}

function resetPageSnapshots() {
  ["homepage", "badgepage", "weatherpage"].forEach((k) => {
    const pageType = k as PageType;
    pageSnapshots[pageType] = {
      pageType,
      imageId: "",
      previewUrl: "",
      etag: "",
      updatedAt: "",
      version: 0,
    };
  });
}

function resetDisplayState() {
  displayState.view = "";
  displayState.announcementText = "";
  displayState.announcementMode = "";
  displayState.imageFileId = "";
  displayState.imageUrl = "";
  displayState.pageType = "unknown";
  displayState.pageImageId = "";
  displayState.pageImageUrl = "";
  displayState.pageEtag = "";
  displayState.pageUpdatedAt = "";
  displayState.lastRemoteCommand = "";
  displayState.lastAckStatus = "";
  displayState.lastAckAt = "";
}

function buildEventDedupKey(type: string, payload: Record<string, any>) {
  const commandId = String(payload?.commandId || "").trim();
  if (commandId) return `${type}:${commandId}`;
  return `${type}:${JSON.stringify(payload || {})}`;
}

function isDuplicateEvent(type: string, payload: Record<string, any>) {
  const key = buildEventDedupKey(type, payload);
  const now = Date.now();
  const last = recentEventKeys.get(key) || 0;
  recentEventKeys.set(key, now);
  if (recentEventKeys.size > 300) {
    for (const [k, ts] of recentEventKeys.entries()) {
      if (now - ts > EVENT_DEDUP_WINDOW_MS * 4) recentEventKeys.delete(k);
    }
  }
  return last > 0 && now - last <= EVENT_DEDUP_WINDOW_MS;
}

function buildAuthorizedUrl(rawUrl: string) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return "";
  try {
    const url = raw.startsWith("http") ? new URL(raw) : new URL(raw, location.origin);
    if (hardwareToken.value) url.searchParams.set("token", hardwareToken.value);
    return url.toString();
  } catch (_) {
    return raw;
  }
}

function preloadImage(url: string) {
  return new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image load error"));
    img.src = url;
  });
}

function applySnapshotToDisplay(pageType: PageType) {
  const snap = pageSnapshots[pageType];
  if (!snap) return;
  displayState.pageType = pageType;
  displayState.pageImageId = snap.imageId;
  displayState.pageImageUrl = snap.previewUrl;
  displayState.pageEtag = snap.etag;
  displayState.pageUpdatedAt = snap.updatedAt;
}

async function refreshPageSnapshot(pageType: PageType, reason: string) {
  if (pageType === "unknown") return;
  if (!hardwareToken.value) return;

  const endpoint = pageEndpoint(pageType);
  if (!endpoint) return;

  try {
    const data = await apiRequest<any>(endpoint, { token: hardwareToken.value });
    const image = data?.image || {};
    const preview =
      buildAuthorizedUrl(String(image.admin_preview_url || "")) ||
      buildAuthorizedUrl(String(image.preview_url || "")) ||
      buildAuthorizedUrl(String(image.admin_image_url || "")) ||
      buildAuthorizedUrl(String(image.image_url || ""));

    pageSnapshots[pageType] = {
      pageType,
      imageId: String(image.image_id || image.image_key || ""),
      previewUrl: preview,
      etag: String(image.etag || ""),
      updatedAt: String(image.updated_at || ""),
      version: Number(data?.version || 0),
    };

    if (activePageType.value === pageType || displayState.pageType === "unknown") {
      applySnapshotToDisplay(pageType);
    }

    pushLog(`PAGE_SNAPSHOT_OK ${pageType} reason=${reason} etag=${pageSnapshots[pageType].etag || "-"}`);
  } catch (error) {
    pushLog(`PAGE_SNAPSHOT_FAIL ${pageType} reason=${reason} err=${(error as Error).message || String(error)}`);
  }
}

async function refreshAllPageSnapshots(reason: string) {
  await Promise.all([
    refreshPageSnapshot("homepage", reason),
    refreshPageSnapshot("badgepage", reason),
    refreshPageSnapshot("weatherpage", reason),
  ]);
}

async function refreshCurrentPageSnapshot() {
  const pageType = activePageType.value;
  if (pageType === "unknown") {
    ElMessage.info("当前界面不是主页/桌牌/天气，无法刷新页面快照");
    return;
  }
  await refreshPageSnapshot(pageType, "manual-current");
}

async function sendRemoteAck(commandId: string, eventType: string, status: "success" | "failed", message: string, payload: Record<string, any> = {}) {
  const cid = String(commandId || "").trim();
  if (!cid || !hardwareToken.value) return;
  try {
    await apiRequest("/api/hardware/remote/ack", {
      method: "POST",
      token: hardwareToken.value,
      body: JSON.stringify({
        commandId: cid,
        eventType,
        status,
        message,
        payload,
      }),
    });
    displayState.lastAckStatus = `${status} · ${eventType}`;
    displayState.lastAckAt = new Date().toLocaleTimeString();
    pushLog(`ACK ${eventType} ${status} ${cid}${message ? ` ${message}` : ""}`);
  } catch (error) {
    displayState.lastAckStatus = `failed · ${eventType}`;
    displayState.lastAckAt = new Date().toLocaleTimeString();
    pushLog(`ACK_ERROR ${eventType} ${cid} ${(error as Error).message || String(error)}`);
  }
}

async function handleShowImageCommand(type: string, payload: Record<string, any>) {
  const commandId = String(payload.commandId || "").trim();
  displayState.imageFileId = String(payload.fileId || payload?.file?.id || "");

  const candidateUrl = String(payload.downloadUrl || payload?.file?.url || "");
  const imageUrl = buildAuthorizedUrl(candidateUrl);
  if (!imageUrl) {
    displayState.imageUrl = "";
    await sendRemoteAck(commandId, type, "failed", "missing image url");
    return;
  }

  displayState.imageUrl = imageUrl;
  try {
    await preloadImage(imageUrl);
    pushLog(`IMAGE_READY ${displayState.imageFileId || "-"}`);
    await sendRemoteAck(commandId, type, "success", "image loaded");
  } catch (error) {
    displayState.imageUrl = "";
    const msg = (error as Error).message || "image load failed";
    pushLog(`IMAGE_LOAD_FAIL ${msg}`);
    await sendRemoteAck(commandId, type, "failed", msg);
  }
}

async function handleRefreshPageImageEvent(type: string, payload: Record<string, any>) {
  const commandId = String(payload.commandId || "").trim();
  const pageType = normalizePageType(String(payload.pageType || payload.view || displayState.view || ""));
  if (pageType === "unknown") {
    await sendRemoteAck(commandId, type, "failed", "unsupported pageType", { pageType: payload.pageType || "" });
    return;
  }
  await refreshPageSnapshot(pageType, "remote.refresh_page_image");
  applySnapshotToDisplay(pageType);
  await sendRemoteAck(commandId, type, "success", "page image refreshed", {
    pageType,
    imageId: pageSnapshots[pageType].imageId,
    etag: pageSnapshots[pageType].etag,
  });
}

async function handleRequestScreenStateEvent(type: string, payload: Record<string, any>) {
  const commandId = String(payload.commandId || "").trim();
  const state = {
    view: displayState.view || "",
    pageType: displayState.pageType,
    pageImageId: displayState.pageImageId,
    pageEtag: displayState.pageEtag,
    announcementMode: displayState.announcementMode,
    hasCastImage: Boolean(displayState.imageUrl),
    wsStatus: wsStatus.value,
    sseStatus: sseStatus.value,
  };
  await sendRemoteAck(commandId, type, "success", "screen state", state);
}

async function handleDeviceEvent(rawEvent: any) {
  if (!rawEvent) return;
  const type = String(rawEvent.type || "");
  const payload = rawEvent.payload && typeof rawEvent.payload === "object" ? rawEvent.payload : {};
  if (isDuplicateEvent(type, payload)) {
    pushLog(`DEVICE_EVENT_DUP ${type}`);
    return;
  }

  displayState.lastRemoteCommand = type;
  pushLog(`DEVICE_EVENT ${type} ${JSON.stringify(payload)}`);

  if (type === "remote.switch_view") {
    displayState.view = String(payload.view || "");
    const pageType = normalizePageType(displayState.view);
    if (pageType !== "unknown") {
      await refreshPageSnapshot(pageType, "remote.switch_view");
      applySnapshotToDisplay(pageType);
    }
    await sendRemoteAck(String(payload.commandId || ""), type, "success", "view switched", {
      view: displayState.view,
      pageType,
    });
    return;
  }

  if (type === "remote.refresh_page_image") {
    await handleRefreshPageImageEvent(type, payload);
    return;
  }

  if (type === "remote.request_screen_state") {
    await handleRequestScreenStateEvent(type, payload);
    return;
  }

  if (type === "remote.show_text") {
    displayState.announcementText = String(payload.text || "");
    displayState.announcementMode = String(payload.announcementMode || "status");
    await sendRemoteAck(String(payload.commandId || ""), type, "success", "text shown", {
      mode: displayState.announcementMode,
    });
    return;
  }

  if (type === "remote.show_image") {
    await handleShowImageCommand(type, payload);
    return;
  }

  if (type === "remote.cast_frame") {
    if (payload.downloadUrl || payload?.file?.url) {
      await handleShowImageCommand(type, payload);
    } else {
      await sendRemoteAck(String(payload.commandId || ""), type, "success", "cast frame accepted");
    }
    return;
  }

  if (type === "remote.cast_stop") {
    displayState.imageFileId = "";
    displayState.imageUrl = "";
    await sendRemoteAck(String(payload.commandId || ""), type, "success", "cast stopped");
    return;
  }

  if (type.startsWith("homepage.")) {
    await refreshPageSnapshot("homepage", type);
    if (activePageType.value === "homepage") applySnapshotToDisplay("homepage");
    return;
  }
  if (type.startsWith("badgepage.")) {
    await refreshPageSnapshot("badgepage", type);
    if (activePageType.value === "badgepage") applySnapshotToDisplay("badgepage");
    return;
  }
  if (type.startsWith("weatherpage.")) {
    await refreshPageSnapshot("weatherpage", type);
    if (activePageType.value === "weatherpage") applySnapshotToDisplay("weatherpage");
    return;
  }
}

function disconnectStreams() {
  if (sse) {
    sse.close();
    sse = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  sseStatus.value = "未连接";
  wsStatus.value = "未连接";
}

function connectStreams() {
  disconnectStreams();
  if (!currentDevice.value?.id || !hardwareToken.value) return;

  const token = encodeURIComponent(hardwareToken.value);
  const deviceId = encodeURIComponent(currentDevice.value.id);
  const sseUrl = `/api/hardware/stream/sse?deviceId=${deviceId}&token=${token}`;
  sse = new EventSource(sseUrl);

  sse.onopen = () => {
    sseStatus.value = "已连接";
  };
  sse.onerror = () => {
    sseStatus.value = "连接错误";
  };
  sse.addEventListener("device-event", (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data || "{}");
      void handleDeviceEvent(data);
    } catch (_) {
      pushLog(`SSE_EVENT_RAW ${(event as MessageEvent).data}`);
    }
  });

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${protocol}://${location.host}/ws/hardware?deviceId=${deviceId}&token=${token}`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    wsStatus.value = "已连接";
  };
  ws.onclose = () => {
    wsStatus.value = "已断开";
  };
  ws.onerror = () => {
    wsStatus.value = "连接错误";
  };
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data || "{}");
      if (data?.type === "device-event" && data?.event) {
        void handleDeviceEvent(data.event);
      } else {
        void handleDeviceEvent(data);
      }
    } catch (_) {
      pushLog(`WS_EVENT_RAW ${event.data}`);
    }
  };
}

function stopBindPoll() {
  if (bindPollTimer) {
    clearInterval(bindPollTimer);
    bindPollTimer = null;
    pushLog("POLL_STOPPED");
  }
}

function scheduleBindPoll() {
  stopBindPoll();
  if (!bootstrapToken.value) return;
  bindPollTimer = setInterval(async () => {
    try {
      logBootStage("POLL_BIND", { bootstrapToken: bootstrapToken.value.slice(0, 12) });
      const result = await apiRequest<{ bound: boolean; pinExpiresAt?: string; device?: DeviceInfo }>(
        `/api/hardware/bind/status?bootstrapToken=${encodeURIComponent(bootstrapToken.value)}`
      );
      if (result.bound) {
        const deviceMac = result.device?.mac || currentDevice.value?.mac || normalizeMac(startForm.mac);
        const deviceId = result.device?.id || currentDevice.value?.id || "";
        currentDevice.value = {
          id: deviceId,
          mac: deviceMac,
          displayName: result.device?.displayName || currentDevice.value?.displayName || "",
          simulated: true,
        };
        logBootStage("BIND_CONFIRMED", { deviceId });
        await loginHardwareByMac(deviceMac);
        stopBindPoll();
        connectStreams();
        await refreshAllPageSnapshots("bind-confirmed");
        logBootStage("STREAM_READY", { channel: "WS+SSE" });
        await loadSimulatedDevices();
        ElMessage.success("设备已绑定并登录成功");
      } else {
        bindStatus.value = "待绑定";
        pinExpire.value = result.pinExpiresAt || "";
      }
    } catch (error) {
      pushLog(`POLL_BIND_ERROR ${(error as Error).message || String(error)}`);
    }
  }, 5000);
}

function resetRuntime() {
  stopBindPoll();
  disconnectStreams();
  scriptStage.value = "IDLE";
  currentDevice.value = null;
  hardwareToken.value = "";
  bootstrapToken.value = "";
  bindStatus.value = "未绑定";
  pinCode.value = "";
  pinExpire.value = "";
  resetDisplayState();
  resetPageSnapshots();
}

async function doLogin() {
  if (!loginForm.username.trim() || !loginForm.password) {
    ElMessage.error("请输入账号和密码");
    return;
  }
  loginLoading.value = true;
  try {
    await auth.login(loginForm.role, loginForm.username.trim(), loginForm.password);
    await loadSimulatedDevices();
    ElMessage.success("登录成功");
  } catch (error) {
    ElMessage.error((error as Error).message || "登录失败");
  } finally {
    loginLoading.value = false;
  }
}

async function loadSimulatedDevices() {
  if (!auth.token) return;
  const rows = await apiRequest<DeviceInfo[]>("/api/devices?simulated=true", { token: auth.token });
  simulatedDevices.value = rows;
}

async function loginHardwareByMac(mac: string) {
  const normalized = normalizeMac(mac);
  if (!normalized) throw new Error("MAC 为空，无法登录");

  hardwareToken.value = "";
  logBootStage("TRY_LOGIN", { mac: normalized });
  const login = await apiRequest<{ token: string; deviceId: string; templates: unknown[] }>("/api/hardware/login", {
    method: "POST",
    body: JSON.stringify({ mac: normalized }),
  });
  hardwareToken.value = login.token || "";
  const current = simulatedDevices.value.find((item) => item.id === login.deviceId || item.mac === normalized);
  currentDevice.value = {
    id: login.deviceId || current?.id || "",
    mac: normalized,
    displayName: current?.displayName || "",
    simulated: true,
  };
  bindStatus.value = "已绑定";
  pinCode.value = "";
  pinExpire.value = "";
  logBootStage("LOGIN_OK", { deviceId: login.deviceId || "" });
}

async function switchToPickedDevice() {
  const row = simulatedDevices.value.find((item) => item.id === pickForm.deviceId);
  if (!row) return ElMessage.error("请先选择模拟设备");
  try {
    resetRuntime();
    await loginHardwareByMac(row.mac);
    connectStreams();
    await refreshAllPageSnapshots("switch-device");
    logBootStage("STREAM_READY", { channel: "WS+SSE", deviceId: row.id });
    ElMessage.success("已切换到模拟设备");
  } catch (error) {
    ElMessage.error((error as Error).message || "切换失败");
  }
}

async function startSimulatedDeviceFlow() {
  if (!auth.token) {
    ElMessage.error("请先登录账号");
    return;
  }

  starting.value = true;
  try {
    resetRuntime();

    let mac = normalizeMac(startForm.mac);
    if (!mac) {
      mac = createRandomMac();
      startForm.mac = mac;
    }

    try {
      await loginHardwareByMac(mac);
      connectStreams();
      await refreshAllPageSnapshots("quick-login");
      logBootStage("STREAM_READY", { channel: "WS+SSE" });
      ElMessage.success("设备已注册并绑定，直接登录成功");
      await loadSimulatedDevices();
      return;
    } catch (error) {
      logBootStage("LOGIN_FAILED", { reason: (error as Error).message || String(error) });
    }

    logBootStage("AUTO_REGISTER", { mac, simulated: true });
    const result = await apiRequest<{
      mode: string;
      device?: DeviceInfo;
      bind?: { pin?: string; expiresAt?: string };
      bootstrap?: { token?: string };
    }>("/api/hardware/auto-register", {
      method: "POST",
      body: JSON.stringify({
        mac,
        type: startForm.type || "ink-screen",
        remark: startForm.remark || "",
        simulated: true,
      }),
    });

    if (result.device) {
      currentDevice.value = {
        id: result.device.id || "",
        mac: result.device.mac || mac,
        displayName: result.device.displayName || "",
        simulated: true,
      };
    } else {
      currentDevice.value = { id: currentDevice.value?.id || "", mac, simulated: true };
    }

    if (result.mode === "already_bound") {
      await loginHardwareByMac(currentDevice.value.mac);
      connectStreams();
      await refreshAllPageSnapshots("already-bound");
      logBootStage("STREAM_READY", { channel: "WS+SSE" });
      await loadSimulatedDevices();
      ElMessage.success("设备已绑定并登录成功");
      return;
    }

    bindStatus.value = "待绑定";
    pinCode.value = result.bind?.pin || "";
    pinExpire.value = result.bind?.expiresAt || "";
    bootstrapToken.value = result.bootstrap?.token || "";
    logBootStage("POLL_BIND_WAIT", { pin: pinCode.value || "" });
    scheduleBindPoll();
    await loadSimulatedDevices();
    ElMessage.info("已进入待绑定状态，请完成 PIN 绑定");
  } catch (error) {
    ElMessage.error((error as Error).message || "启动失败");
  } finally {
    starting.value = false;
  }
}

onBeforeUnmount(() => {
  stopBindPoll();
  disconnectStreams();
});
</script>

<style scoped>
.page {
  padding: 16px;
}
.panel {
  max-width: 1360px;
  margin: 0 auto;
}
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.sub {
  margin-top: 6px;
  color: #64748b;
  font-size: 12px;
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.who {
  color: #334155;
  font-size: 13px;
}
.stack {
  display: grid;
  gap: 12px;
}
.login-wrap {
  max-width: 520px;
}
.kv {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px dashed #e2e8f0;
  gap: 12px;
}
.ellipsis {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 220px;
}
.preview-wrap {
  margin-top: 10px;
  border: 1px solid #dbe1ea;
  border-radius: 8px;
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f8fafc;
}
.preview-image {
  max-width: 100%;
  max-height: 320px;
  object-fit: contain;
}
.preview-empty {
  color: #64748b;
  font-size: 13px;
}
.log {
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 8px;
  padding: 12px;
  height: 360px;
  overflow: auto;
  font-size: 12px;
  margin: 0;
}
</style>
