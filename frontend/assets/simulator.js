import {
  byId,
  apiRequest,
  parseJsonSafe,
  toast,
  getStorage,
  setStorage,
  notifySuccess,
  notifyError,
  notifyInfo,
  makeDraggable,
  makeResizable,
} from "./common.js?v=20260227-3";
import { openDevicePicker } from "./device-picker.js?v=20260227-3";

const VERSION = "20260311-1";
let token = getStorage("simulator_token");
let role = getStorage("simulator_role") || "user";
let hardwareToken = "";
let currentDevice = null;
let bootstrapToken = "";
let bindPollTimer = null;
let ws = null;
let sse = null;
let eventLog = [];
let eventIds = new Set();
let localTfFiles = [];
let lastRemoteImageUrl = "";
let lastCastImageUrl = "";
let hardwareAuthCache = null;
let remoteTextTimer = null;
let remoteTextEndTs = 0;
let remoteTextContent = "";

const outputEl = byId("s-output");
const outputPanelEl = byId("s-output-panel");
const outputHandleEl = byId("s-output-handle");
const outputToggleEl = byId("s-output-toggle");
const scriptStatusEl = byId("s-script-status");
const loginPanelEl = byId("s-login-panel");
const appPanelEl = byId("s-app-panel");
const currentDeviceEl = byId("s-current-device");
const pinCodeEl = byId("s-pin-code");
const pinExpireEl = byId("s-pin-expire");
const bindStatusEl = byId("s-bind-status");
const wsStatusEl = byId("s-ws-status");
const sseStatusEl = byId("s-sse-status");
const eventLogEl = byId("s-event-log");
const snapshotEl = byId("s-snapshot");
const snapshotViewEl = byId("s-snapshot-view");
const tfBodyEl = byId("s-tf-body");
const tfReportedAtEl = byId("s-tf-reported-at");
const remoteViewEl = byId("s-remote-view");
const remoteTextPreviewEl = byId("s-remote-text-preview");
const remoteImagePreviewEl = byId("s-remote-image-preview");
const castPreviewEl = byId("s-cast-preview");

function print(data) {
  toast(outputEl, data);
}

function on(id, event, handler) {
  const el = byId(id);
  if (!el) return;
  el.addEventListener(event, handler);
}

function setScriptStatus(text) {
  if (scriptStatusEl) scriptStatusEl.textContent = text;
}

function setOutputCollapsed(collapsed) {
  if (outputPanelEl) outputPanelEl.classList.toggle("collapsed", collapsed);
  if (outputToggleEl) outputToggleEl.textContent = collapsed ? "操作输出" : "收起输出";
  setStorage("simulator_output_collapsed", collapsed ? "1" : "");
}

function setAuthed(authed) {
  if (loginPanelEl) loginPanelEl.classList.toggle("hidden", authed);
  if (appPanelEl) appPanelEl.classList.toggle("hidden", !authed);
}

function setBindInfo({ pin = "", expiresAt = "", status = "未绑定" } = {}) {
  if (pinCodeEl) pinCodeEl.value = pin;
  if (pinExpireEl) pinExpireEl.value = expiresAt;
  if (bindStatusEl) bindStatusEl.value = status;
}

function setCurrentDevice(device) {
  currentDevice = device || null;
  if (currentDeviceEl) {
    currentDeviceEl.textContent = currentDevice ? `${currentDevice.id} (${currentDevice.mac})` : "未选择";
  }
}

function setStatus(el, text) {
  if (el) el.textContent = text;
}

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

async function request(path, options = {}) {
  if (!token) throw new Error("请先登录模拟端");
  return apiRequest(path, { ...options, token });
}

async function deviceRequest(path, options = {}) {
  if (!hardwareToken) throw new Error("设备尚未获得硬件令牌");
  return apiRequest(path, { ...options, token: hardwareToken });
}

async function execute(name, action, successHint = "") {
  try {
    const result = await action();
    if (result !== undefined) print(result);
    notifySuccess(result?.msg || successHint || `${name}成功`);
    return result;
  } catch (error) {
    const message = error?.message || String(error);
    print({ error: message });
    notifyError(`${name}失败：${message}`);
    return null;
  }
}

function clearConnections() {
  if (ws) {
    try {
      ws.close();
    } catch (_) {
      // ignore
    }
    ws = null;
  }
  if (sse) {
    try {
      sse.close();
    } catch (_) {
      // ignore
    }
    sse = null;
  }
  setStatus(wsStatusEl, "未连接");
  setStatus(sseStatusEl, "未连接");
}

function resetEventLog() {
  eventLog = [];
  eventIds = new Set();
  if (eventLogEl) eventLogEl.textContent = "";
}

function pushEvent(event, channel) {
  if (!event || !event.eventId) return;
  if (eventIds.has(event.eventId)) return;
  eventIds.add(event.eventId);
  if (eventIds.size > 400) {
    eventIds = new Set([...eventIds].slice(-300));
  }
  eventLog.unshift({ ...event, channel });
  if (eventLog.length > 200) eventLog = eventLog.slice(0, 200);
  if (eventLogEl) {
    eventLogEl.textContent = eventLog
      .map((item) => {
        return `[${item.timestamp}] (${item.channel}) ${item.type}\n${JSON.stringify(item.payload || {}, null, 0)}`;
      })
      .join("\n\n");
  }
  applyRemotePreview(event);
  scheduleSnapshotRefresh();
}

function applyRemotePreview(event) {
  if (!event || !event.type) return;
  if (event.type === "remote.switch_view") {
    if (remoteViewEl) remoteViewEl.textContent = event.payload?.view || "-";
  }
  if (event.type === "remote.show_text") {
    startRemoteTextCountdown(event.payload?.text || "-", event.payload?.durationSec, event.payload?.expiresAt);
  }
  if (event.type === "remote.show_image") {
    const file = event.payload?.file;
    if (file?.url) {
      loadImagePreview(file.url, remoteImagePreviewEl, token || hardwareToken, "remote");
    }
  }
  if (event.type === "remote.cast_frame") {
    const imageData = event.payload?.imageData;
    if (imageData && castPreviewEl) {
      castPreviewEl.src = imageData;
      castPreviewEl.classList.remove("hidden");
    }
  }
  if (event.type === "remote.cast_stop") {
    if (castPreviewEl) {
      castPreviewEl.src = "";
      castPreviewEl.classList.add("hidden");
    }
  }
}

function formatRemain(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function renderRemoteTextRemain() {
  if (!remoteTextPreviewEl) return;
  const remain = Math.max(0, Math.floor((remoteTextEndTs - Date.now()) / 1000));
  if (remain <= 0) {
    remoteTextPreviewEl.textContent = "-";
    if (remoteTextTimer) {
      clearInterval(remoteTextTimer);
      remoteTextTimer = null;
    }
    return;
  }
  remoteTextPreviewEl.textContent = `${remoteTextContent}（剩余 ${formatRemain(remain)}）`;
}

function startRemoteTextCountdown(text, durationSec, expiresAt) {
  remoteTextContent = String(text || "-");
  const parsedDuration = Number(durationSec || 0);
  if (expiresAt) {
    remoteTextEndTs = new Date(expiresAt).getTime();
  } else if (parsedDuration > 0) {
    remoteTextEndTs = Date.now() + parsedDuration * 1000;
  } else {
    remoteTextEndTs = Date.now();
  }

  if (remoteTextTimer) {
    clearInterval(remoteTextTimer);
    remoteTextTimer = null;
  }

  renderRemoteTextRemain();
  if (remoteTextEndTs > Date.now()) {
    remoteTextTimer = setInterval(renderRemoteTextRemain, 1000);
  }
}

async function loadImagePreview(url, imgEl, authToken, slot) {
  if (!imgEl || !url) return;
  try {
    const response = await fetch(url, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    });
    if (!response.ok) return;
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    if (slot === "cast") {
      if (lastCastImageUrl) URL.revokeObjectURL(lastCastImageUrl);
      lastCastImageUrl = objectUrl;
    } else {
      if (lastRemoteImageUrl) URL.revokeObjectURL(lastRemoteImageUrl);
      lastRemoteImageUrl = objectUrl;
    }
    imgEl.src = objectUrl;
    imgEl.classList.remove("hidden");
  } catch (_) {
    // ignore preview errors
  }
}

function connectWebSocket() {
  if (!currentDevice) return;
  const streamToken = hardwareToken || token;
  if (!streamToken) return;
  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://${location.host}/ws/hardware?deviceId=${encodeURIComponent(
    currentDevice.id
  )}&token=${encodeURIComponent(streamToken)}`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => setStatus(wsStatusEl, "已连接");
  ws.onclose = () => setStatus(wsStatusEl, "已断开");
  ws.onerror = () => setStatus(wsStatusEl, "连接错误");
  ws.onmessage = (event) => {
    const payload = parseJsonSafe(event.data);
    if (payload?.type === "device-event" && payload.event) {
      pushEvent(payload.event, "ws");
    }
  };
}

function connectSse() {
  if (!currentDevice) return;
  const streamToken = hardwareToken || token;
  if (!streamToken) return;
  const url = `/api/hardware/stream/sse?deviceId=${encodeURIComponent(currentDevice.id)}&token=${encodeURIComponent(
    streamToken
  )}`;
  sse = new EventSource(url);
  sse.onopen = () => setStatus(sseStatusEl, "已连接");
  sse.onerror = () => setStatus(sseStatusEl, "连接错误");
  sse.addEventListener("ready", (event) => {
    const payload = parseJsonSafe(event.data);
    if (payload?.deviceId) {
      setStatus(sseStatusEl, "已连接");
    }
  });
  sse.addEventListener("device-event", (event) => {
    const payload = parseJsonSafe(event.data);
    if (payload?.eventId) {
      pushEvent(payload, "sse");
    }
  });
}

function connectStreams() {
  clearConnections();
  resetEventLog();
  connectWebSocket();
  connectSse();
}

function stopBindPoll() {
  if (bindPollTimer) {
    clearInterval(bindPollTimer);
    bindPollTimer = null;
  }
}

function logBootStage(stage, detail = {}) {
  const payload = { stage, ...detail, at: new Date().toISOString() };
  setScriptStatus(stage);
  print(payload);
}

function createRandomMac() {
  const bytes = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256));
  return bytes.map((n) => n.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

async function loginHardwareByMac(mac) {
  const normalized = String(mac || "").trim().toUpperCase();
  if (!normalized) throw new Error("MAC为空，无法登录设备");
  hardwareToken = "";
  logBootStage("TRY_LOGIN", { mac: normalized });
  const login = await apiRequest("/hardware/login", {
    method: "POST",
    body: { mac: normalized },
  });
  hardwareToken = login.data?.token || "";
  hardwareAuthCache = { token: hardwareToken, templates: login.data?.templates || [] };
  const deviceId = login.data?.deviceId || currentDevice?.id || "";
  setCurrentDevice({ id: deviceId, mac: normalized });
  setBindInfo({ status: "已绑定", pin: "", expiresAt: "" });
  logBootStage("LOGIN_OK", { deviceId });
  return login;
}

function scheduleBindPoll() {
  stopBindPoll();
  if (!bootstrapToken) return;
  bindPollTimer = setInterval(async () => {
    try {
      logBootStage("POLL_BIND", { bootstrapToken: bootstrapToken.slice(0, 12) });
      const result = await apiRequest(`/hardware/bind/status?bootstrapToken=${encodeURIComponent(bootstrapToken)}`);
      if (result.data?.bound) {
        const device = result.data?.device || currentDevice;
        if (device) setCurrentDevice(device);
        const mac = device?.mac || byId("s-new-mac")?.value.trim();
        if (!mac) {
          notifyError("绑定成功但缺少 MAC，无法完成设备登录");
          return;
        }
        logBootStage("BIND_CONFIRMED", { deviceId: device?.id || "" });
        try {
          await loginHardwareByMac(mac);
          stopBindPoll();
          notifySuccess("设备已绑定并完成登录");
          connectStreams();
          logBootStage("STREAM_READY", { channel: "WS+SSE" });
          await refreshSnapshot();
        } catch (error) {
          notifyError(`绑定后登录失败，将继续重试：${error.message || error}`);
        }
      } else {
        const expiresAt = result.data?.pinExpiresAt || "";
        setBindInfo({ status: "待绑定", expiresAt });
      }
    } catch (error) {
      notifyError(`轮询失败：${error.message || error}`);
    }
  }, 5000);
}

async function startSimulatedDeviceFlow() {
  stopBindPoll();
  clearConnections();
  bootstrapToken = "";
  hardwareToken = "";
  hardwareAuthCache = null;

  let mac = byId("s-new-mac")?.value.trim();
  const remark = byId("s-new-remark")?.value.trim();
  const type = byId("s-new-type")?.value.trim();
  if (!mac) {
    mac = createRandomMac();
    const input = byId("s-new-mac");
    if (input) input.value = mac;
  }

  try {
    await loginHardwareByMac(mac);
    stopBindPoll();
    connectStreams();
    logBootStage("STREAM_READY", { channel: "WS+SSE" });
    await refreshSnapshot();
    return { data: { mode: "already_bound_via_login" } };
  } catch (error) {
    logBootStage("LOGIN_FAILED", { reason: error.message || String(error) });
  }

  logBootStage("AUTO_REGISTER", { mac, simulated: true });
  const result = await apiRequest("/hardware/auto-register", {
    method: "POST",
    body: {
      mac,
      type: type || "ink-screen",
      remark: remark || "",
      simulated: true,
    },
  });

  const data = result.data || {};
  if (data.device) setCurrentDevice(data.device);

  if (data.mode === "already_bound") {
    await loginHardwareByMac(data.device?.mac || mac);
    stopBindPoll();
    connectStreams();
    logBootStage("STREAM_READY", { channel: "WS+SSE" });
    await refreshSnapshot();
  } else {
    bootstrapToken = data.bootstrap?.token || "";
    setBindInfo({ status: "待绑定", pin: data.bind?.pin || "", expiresAt: data.bind?.expiresAt || "" });
    logBootStage("POLL_BIND_WAIT", { pin: data.bind?.pin || "" });
    scheduleBindPoll();
  }

  return result;
}

async function pickSimulatedDevice() {
  if (!token) throw new Error("请先登录模拟端");
  const result = await openDevicePicker({
    token,
    title: "选择模拟设备",
    multiple: false,
    simulated: true,
    bound: role === "user" ? true : undefined,
  });
  if (result.devices && result.devices[0]) {
    setCurrentDevice(result.devices[0]);
    await resolveHardwareToken({ throwOnFail: true });
    connectStreams();
    logBootStage("STREAM_READY", { channel: "WS+SSE" });
    await refreshSnapshot();
  }
}

async function resolveHardwareToken(options = {}) {
  const throwOnFail = Boolean(options.throwOnFail);
  if (!currentDevice) return;
  try {
    await loginHardwareByMac(currentDevice.mac);
  } catch (error) {
    if (throwOnFail) throw error;
  }
}

function renderLocalTfFiles() {
  if (!tfBodyEl) return;
  tfBodyEl.innerHTML = localTfFiles
    .map((file, index) => {
      return `
        <tr data-index="${index}">
          <td>${file.name}</td>
          <td>${file.category}</td>
          <td>${formatSize(file.size)}</td>
          <td><button data-role="delete" class="warn">删除</button></td>
        </tr>
      `;
    })
    .join("");

  tfBodyEl.querySelectorAll("[data-role='delete']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("tr");
      const idx = Number(row?.dataset?.index || -1);
      if (idx >= 0) {
        localTfFiles.splice(idx, 1);
        renderLocalTfFiles();
      }
    });
  });
}

async function reportTfFiles() {
  if (!hardwareToken) throw new Error("设备尚未绑定，无法上报本地文件");
  const files = localTfFiles.map((file) => ({
    name: file.name,
    category: file.category,
    size: file.size,
    updatedAt: file.updatedAt || new Date().toISOString(),
  }));
  const result = await deviceRequest("/hardware/tf/report", {
    method: "POST",
    body: { files },
  });
  if (tfReportedAtEl) tfReportedAtEl.textContent = result.data?.reportedAt || "-";
  return result;
}

function addLocalTfFile() {
  const name = byId("s-tf-name")?.value.trim();
  const category = byId("s-tf-category")?.value;
  const sizeInput = byId("s-tf-size")?.value;
  if (!name) {
    notifyError("请输入文件名");
    return;
  }
  const size = Number(sizeInput || 0) * 1024;
  localTfFiles.push({
    name,
    category,
    size,
    updatedAt: new Date().toISOString(),
  });
  renderLocalTfFiles();
}

function clearLocalTfFiles() {
  localTfFiles = [];
  renderLocalTfFiles();
}

let snapshotTimer = null;
function scheduleSnapshotRefresh() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(async () => {
    snapshotTimer = null;
    await refreshSnapshot();
  }, 900);
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderSnapshotView(snapshot) {
  if (!snapshotViewEl) return;
  const blocks = [];
  const device = snapshot.device || {};
  blocks.push(
    buildSnapshotBlock("设备信息", [
      `ID：${escapeHtml(device.id || "-")}`,
      `MAC：${escapeHtml(device.mac || "-")}`,
      `状态：${escapeHtml(device.status || "-")}`,
      `绑定：${escapeHtml(device.bindState || "-")}`,
      `模拟：${device.simulated ? "是" : "否"}`,
      `固件：${escapeHtml(device.firmwareVersion || "-")}`,
    ])
  );

  const keys = snapshot.keys || {};
  const keyLines = Object.keys(keys).length
    ? Object.entries(keys).map(([slug, value]) => `${escapeHtml(slug)}: ${escapeHtml(value)}`)
    : ["暂无密钥"];
  blocks.push(buildSnapshotBlock("模板密钥", keyLines));

  const todos = snapshot.todos || [];
  blocks.push(buildSnapshotBlock("TODO", [`数量：${todos.length}`]));

  const schedules = snapshot.schedules || [];
  blocks.push(buildSnapshotBlock("课程表", [`数量：${schedules.length}`]));

  const upgrades = snapshot.upgrades || [];
  blocks.push(buildSnapshotBlock("升级任务", [`数量：${upgrades.length}`]));

  const hw = snapshot.hardwareConfig || {};
  if (hw.templates) {
    blocks.push(buildSnapshotBlock("硬件配置", [`模板数：${hw.templates.length}`]));
  }

  snapshotViewEl.innerHTML = blocks.join("");
}

function buildSnapshotBlock(title, lines) {
  return `
    <div class="snapshot-block">
      <h4>${escapeHtml(title)}</h4>
      <div class="snapshot-list">
        ${lines.map((line) => `<div class="snapshot-item">${line}</div>`).join("")}
      </div>
    </div>
  `;
}

async function refreshSnapshot() {
  if (!currentDevice) return;
  const deviceId = currentDevice.id;

  const results = await Promise.all([
    safeRequest(() => request(`/devices/${deviceId}`)),
    safeRequest(() => request(`/templates/device/${deviceId}/keys`)),
    safeRequest(() => request(`/todos?deviceId=${encodeURIComponent(deviceId)}`)),
    safeRequest(() => request(`/schedules?deviceId=${encodeURIComponent(deviceId)}`)),
    safeRequest(() => request(`/firmware/upgrades?deviceId=${encodeURIComponent(deviceId)}`)),
    hardwareToken ? safeRequest(() => apiRequest("/hardware/config", { token: hardwareToken })) : Promise.resolve(null),
  ]);

  const snapshot = {
    device: results[0]?.data || {},
    keys: results[1]?.data || {},
    todos: results[2]?.data || [],
    schedules: results[3]?.data || [],
    upgrades: results[4]?.data || [],
    hardwareConfig: results[5]?.data || {},
    hardwareAuth: hardwareAuthCache,
  };

  renderSnapshotView(snapshot);
  toast(snapshotEl, snapshot);
  return snapshot;
}

async function safeRequest(action) {
  try {
    return await action();
  } catch (_) {
    return null;
  }
}

on("s-login", "click", async () => {
  const selectedRole = byId("s-role").value;
  const username = byId("s-username").value.trim();
  const password = byId("s-password").value;
  if (!username || !password) {
    notifyError("请输入账号和密码");
    return;
  }
  try {
    const result = await apiRequest(`/auth/${selectedRole}/login`, {
      method: "POST",
      body: { username, password },
    });
    token = result.data?.token || "";
    role = selectedRole;
    setStorage("simulator_token", token);
    setStorage("simulator_role", role);
    setAuthed(true);
    notifySuccess("登录成功");
  } catch (error) {
    print({ error: error.message || String(error) });
    notifyError(error.message || "登录失败");
  }
});

on("s-logout", "click", async () => {
  try {
    if (token) await apiRequest("/auth/logout", { method: "POST", token });
  } catch (_) {
    // ignore
  }
  token = "";
  role = "user";
  hardwareToken = "";
  currentDevice = null;
  bootstrapToken = "";
  stopBindPoll();
  clearConnections();
  resetEventLog();
  if (remoteTextTimer) {
    clearInterval(remoteTextTimer);
    remoteTextTimer = null;
  }
  remoteTextEndTs = 0;
  remoteTextContent = "";
  if (remoteTextPreviewEl) remoteTextPreviewEl.textContent = "-";
  setCurrentDevice(null);
  setBindInfo({ status: "未绑定" });
  setStorage("simulator_token", "");
  setStorage("simulator_role", "user");
  setAuthed(false);
  notifyInfo("已退出登录");
});

on("s-auto-register", "click", async () => {
  await execute("启动模拟设备", () => startSimulatedDeviceFlow());
});

on("s-stop-poll", "click", () => {
  stopBindPoll();
  notifyInfo("已停止轮询");
});

on("s-pick-device", "click", async () => {
  try {
    await pickSimulatedDevice();
  } catch (error) {
    notifyError(error.message || "选择设备失败");
  }
});

on("s-delete-device", "click", async () => {
  if (!currentDevice) return notifyError("请先选择设备");
  await execute("删除设备", () => request(`/devices/${currentDevice.id}/delete`, { method: "POST" }));
  setCurrentDevice(null);
  clearConnections();
});

on("s-tf-add", "click", () => {
  addLocalTfFile();
});

on("s-tf-clear", "click", () => {
  clearLocalTfFiles();
});

on("s-tf-report", "click", async () => {
  await execute("上报本地文件", () => reportTfFiles());
});

on("s-refresh-snapshot", "click", async () => {
  await execute("刷新快照", () => refreshSnapshot());
});

window.addEventListener("error", (event) => {
  if (event?.message) {
    print({ error: event.message });
    notifyError(`脚本错误：${event.message}`);
  }
});

window.addEventListener("unhandledrejection", (event) => {
  if (event?.reason) {
    print({ error: event.reason?.message || String(event.reason) });
    notifyError(`脚本异常：${event.reason?.message || event.reason}`);
  }
});

if (outputHandleEl && outputPanelEl) {
  makeDraggable(outputPanelEl, outputHandleEl);
  makeResizable(outputPanelEl);
}

if (outputToggleEl) {
  const collapsed = getStorage("simulator_output_collapsed") === "1";
  setOutputCollapsed(collapsed);
  outputToggleEl.addEventListener("click", () => {
    const next = !outputPanelEl.classList.contains("collapsed");
    setOutputCollapsed(next);
  });
}

const roleSelect = byId("s-role");
if (roleSelect) roleSelect.value = role;

if (token) {
  setAuthed(true);
} else {
  setAuthed(false);
}

setScriptStatus("已加载");
console.log(`simulator.js ${VERSION} loaded`);


