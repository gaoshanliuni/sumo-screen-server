import {
  byId,
  apiRequest,
  apiUpload,
  parseJsonSafe,
  toast,
  getStorage,
  setStorage,
  notifySuccess,
  notifyError,
  notifyInfo,
  makeDraggable,
  makeResizable,
} from "./common.js?v=20260301-2";
import { openDevicePicker } from "./device-picker.js?v=20260301-2";

const VERSION = "20260301-2";
let token = getStorage("user_token");
let currentDevice = null;
let todoDeletedIds = new Set();
let scheduleDeletedIds = new Set();
let scheduleRowCount = 1;
let templatesCache = [];
let templatesBySlug = new Map();
let firmwareCache = [];

const outputEl = byId("u-output");
const outputPanelEl = byId("u-output-panel");
const outputHandleEl = byId("u-output-handle");
const outputToggleEl = byId("u-output-toggle");
const scriptStatusEl = byId("u-script-status");
const navGuestEl = byId("u-nav-guest");
const navAppEl = byId("u-nav-app");
const logoutBtn = byId("u-logout");
const currentDeviceEl = byId("u-current-device");
const quickDeviceEl = byId("u-quick-device");
const quickCurrentDeviceEl = byId("u-quick-current-device");
const tfCurrentDeviceEl = byId("u-tf-current-device");
const remoteDeviceEl = byId("u-remote-device");
const todoBodyEl = byId("u-todo-body");
const scheduleBodyEl = byId("u-sch-body");
const scheduleSelectAllEl = byId("u-sch-select-all");
const tfBodyEl = byId("u-tf-body");
const tfLocalBodyEl = byId("u-tf-local-body");
const tfLocalTimeEl = byId("u-tf-local-time");
const castImageInputEl = byId("u-cast-image");
const castImagePreviewEl = byId("u-cast-image-preview");
const castFpsEl = byId("u-cast-fps");
const navButtons = [...document.querySelectorAll("[data-section-target]")];
const sections = [...document.querySelectorAll("[data-section]")];

let castStream = null;
let castTimer = null;
let castVideo = null;
let castCanvas = null;

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
  if (outputToggleEl) {
    outputToggleEl.textContent = collapsed ? "操作输出" : "收起输出";
  }
  setStorage("user_output_collapsed", collapsed ? "1" : "");
}

function showSection(name) {
  sections.forEach((section) => {
    section.classList.toggle("active", section.dataset.section === name);
  });
  navButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sectionTarget === name);
  });
  if (name === "overview" && token) {
    loadOverview().catch((error) => {
      print({ error: error.message || String(error) });
      notifyError(`加载概览失败：${error.message || String(error)}`);
    });
  }
  if (name === "third" && token) {
    loadTemplates().catch((error) => {
      print({ error: error.message || String(error) });
      notifyError(`加载模板失败：${error.message || String(error)}`);
    });
  }
  if (name === "firmware" && token) {
    loadFirmwares().catch((error) => {
      print({ error: error.message || String(error) });
      notifyError(`加载固件失败：${error.message || String(error)}`);
    });
  }
  if (name === "tf" && token) {
    loadTfFiles().catch((error) => {
      print({ error: error.message || String(error) });
      notifyError(`加载文件失败：${error.message || String(error)}`);
    });
    loadTfLocalFiles().catch((error) => {
      print({ error: error.message || String(error) });
      notifyError(`加载本地文件失败：${error.message || String(error)}`);
    });
  }
}

function setAuthed(authed) {
  navGuestEl.classList.toggle("hidden", authed);
  navAppEl.classList.toggle("hidden", !authed);
  if (quickDeviceEl) quickDeviceEl.classList.toggle("hidden", !authed);
  if (logoutBtn) logoutBtn.classList.toggle("hidden", !authed);
  showSection(authed ? "overview" : "login");
}

function ensureDevice() {
  if (!currentDevice) throw new Error("请先选择设备");
}

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let idx = 0;
  let size = bytes;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

async function request(path, options = {}) {
  if (!token) throw new Error("请先登录");
  return apiRequest(path, { ...options, token });
}

async function execute(name, action, successHint = "") {
  try {
    const result = await action();
    if (result !== undefined) print(result);
    notifySuccess(result?.msg || successHint || `${name}成功`);
    return result;
  } catch (error) {
    print({ error: error.message || String(error) });
    notifyError(`${name}失败：${error.message || String(error)}`);
    return null;
  }
}

function setCurrentDevice(device) {
  currentDevice = device || null;
  const label = currentDevice ? `${currentDevice.id} (${currentDevice.mac})` : "未选择";
  if (currentDeviceEl) currentDeviceEl.textContent = label;
  if (quickCurrentDeviceEl) quickCurrentDeviceEl.textContent = label;
  if (tfCurrentDeviceEl) tfCurrentDeviceEl.textContent = label;
  if (remoteDeviceEl) remoteDeviceEl.textContent = label;
  if (currentDevice) {
    const slug = byId("u-third-slug")?.value || "";
    if (slug) loadDeviceThirdParams(slug).catch(() => {});
  }
}

async function pickDevice() {
  if (!token) throw new Error("请先登录");
  const result = await openDevicePicker({
    token,
    title: "选择设备",
    multiple: false,
    bound: true,
  });
  if (result.devices && result.devices[0]) {
    setCurrentDevice(result.devices[0]);
  }
}

async function loadOverview() {
  const me = await request("/auth/me");
  const devices = await request("/devices");
  const todos = await request("/todos");
  const schedules = await request("/schedules");

  if (byId("u-overview-username")) byId("u-overview-username").textContent = me.data?.username || "-";
  if (byId("u-overview-id")) byId("u-overview-id").textContent = me.data?.id || "-";
  if (byId("u-overview-role")) byId("u-overview-role").textContent = me.data?.role || "-";

  const list = devices.data || [];
  const bound = list.filter((item) => item.bindState === "bound").length;
  const pending = list.length - bound;
  if (byId("u-overview-device-total")) byId("u-overview-device-total").textContent = list.length;
  if (byId("u-overview-device-bound")) byId("u-overview-device-bound").textContent = bound;
  if (byId("u-overview-device-pending")) byId("u-overview-device-pending").textContent = pending;

  if (byId("u-overview-todo-count")) byId("u-overview-todo-count").textContent = (todos.data || []).length;
  if (byId("u-overview-schedule-count")) byId("u-overview-schedule-count").textContent = (schedules.data || []).length;

  return { me, devices, todos, schedules };
}

async function loadTemplates() {
  const result = await request("/templates");
  templatesCache = result.data || [];
  templatesBySlug = new Map(templatesCache.map((item) => [item.slug, item]));
  const select = byId("u-third-slug");
  if (select) {
    const prev = select.value;
    select.innerHTML = templatesCache.map((item) => `<option value="${item.slug}">${item.name || item.slug}</option>`).join("");
    if (prev && templatesBySlug.has(prev)) {
      select.value = prev;
    }
    renderThirdDynamicFields(select.value);
    if (select.value && currentDevice) {
      loadDeviceThirdParams(select.value).catch(() => {});
    }
  }
  return templatesCache;
}

function renderThirdDynamicFields(slug) {
  const wrap = byId("u-third-dynamic-fields");
  if (!wrap) return;
  const tpl = templatesBySlug.get(String(slug || "").trim());
  const fields = Array.isArray(tpl?.userInputFields) ? tpl.userInputFields : [];
  if (!fields.length) {
    wrap.innerHTML = `<div class="tiny muted">当前模板没有“用户补全字段”。</div>`;
    return;
  }
  wrap.innerHTML = fields
    .map((field) => {
      const name = String(field?.name || "").trim();
      const placeholder = String(field?.placeholder || "").trim();
      if (!name) return "";
      return `
      <div>
        <label>${name}</label>
        <input data-role="u-third-dynamic" data-name="${name}" placeholder="${placeholder}" />
      </div>
      `;
    })
    .join("");
}

async function loadFirmwares() {
  const result = await request("/firmware");
  firmwareCache = result.data || [];
  const select = byId("u-fw-select");
  if (select) {
    select.innerHTML = firmwareCache
      .map((item) => `<option value="${item.id}">${item.version} (${item.deviceType || "all"})</option>`)
      .join("");
  }
  return firmwareCache;
}

function appendTodoRow(row = {}) {
  const tr = document.createElement("tr");
  tr.dataset.id = row.id || "";
  tr.innerHTML = `
    <td><input data-field="content" value="${row.content || ""}" placeholder="TODO内容" /></td>
    <td><input data-field="done" class="mini" type="checkbox" ${row.done ? "checked" : ""} /></td>
    <td><input data-field="priority" type="number" value="${row.priority ?? ""}" placeholder="可空" /></td>
    <td><button data-role="delete" type="button" class="warn">删除</button></td>
  `;
  tr.querySelector('[data-role="delete"]').addEventListener("click", () => {
    if (tr.dataset.id) todoDeletedIds.add(tr.dataset.id);
    tr.remove();
  });
  todoBodyEl.appendChild(tr);
}

function collectTodoRows() {
  return [...todoBodyEl.querySelectorAll("tr")].map((tr) => ({
    id: tr.dataset.id || undefined,
    content: tr.querySelector('[data-field="content"]').value.trim(),
    done: tr.querySelector('[data-field="done"]').checked,
    priority: tr.querySelector('[data-field="priority"]').value.trim() || null,
  }));
}

async function loadTodoSheet() {
  ensureDevice();
  const result = await request(`/todos?deviceId=${encodeURIComponent(currentDevice.id)}`);
  todoDeletedIds = new Set();
  todoBodyEl.innerHTML = "";
  (result.data || []).forEach((row) => appendTodoRow(row));
  return result;
}

async function saveTodoSheet() {
  ensureDevice();
  const rows = collectTodoRows();
  return await request("/todos/batch-upsert", {
    method: "POST",
    body: {
      deviceId: currentDevice.id,
      rows,
      deletedIds: [...todoDeletedIds],
    },
  });
}

function createScheduleCell(data) {
  const cell = document.createElement("td");
  cell.dataset.week = data.weekDay;
  cell.dataset.id = data.id || "";

  const wrap = document.createElement("div");
  wrap.className = "schedule-cell";

  const courseInput = document.createElement("input");
  courseInput.placeholder = "课程名称";
  courseInput.value = data.courseName || "";

  const noteInput = document.createElement("input");
  noteInput.placeholder = "备注（点击显示）";
  noteInput.className = "note-input";
  noteInput.value = data.note || "";

  courseInput.addEventListener("focus", () => {
    wrap.classList.add("show-note");
  });
  courseInput.addEventListener("click", () => {
    wrap.classList.add("show-note");
  });

  wrap.appendChild(courseInput);
  wrap.appendChild(noteInput);
  cell.appendChild(wrap);
  return cell;
}

function createScheduleRow(orderIndex, dataMap) {
  const tr = document.createElement("tr");
  tr.dataset.order = String(orderIndex);

  const selectTd = document.createElement("td");
  selectTd.className = "row-select";
  selectTd.innerHTML = `<input type="checkbox" class="row-selector" />`;
  tr.appendChild(selectTd);

  const orderTd = document.createElement("td");
  orderTd.className = "row-head";
  orderTd.textContent = String(orderIndex);
  tr.appendChild(orderTd);

  for (let day = 1; day <= 7; day += 1) {
    const key = `${orderIndex}-${day}`;
    const data = dataMap.get(key) || { weekDay: day };
    tr.appendChild(createScheduleCell(data));
  }
  return tr;
}

function renderScheduleSheet(rows = []) {
  scheduleBodyEl.innerHTML = "";
  scheduleDeletedIds = new Set();

  const dataMap = new Map();
  let maxOrder = 1;
  rows.forEach((row) => {
    const orderIndex = Number(row.orderIndex || row.order || 0) || 1;
    const weekDay = Number(row.weekday || row.weekDay || row.week || 0) || 1;
    maxOrder = Math.max(maxOrder, orderIndex);
    dataMap.set(`${orderIndex}-${weekDay}`, {
      id: row.id,
      weekDay,
      courseName: row.courseName || row.name || "",
      note: row.note || "",
    });
  });

  scheduleRowCount = Math.max(1, maxOrder);
  for (let i = 1; i <= scheduleRowCount; i += 1) {
    scheduleBodyEl.appendChild(createScheduleRow(i, dataMap));
  }
}

function collectScheduleRows() {
  const result = [];
  scheduleBodyEl.querySelectorAll("tr").forEach((tr) => {
    const orderIndex = Number(tr.dataset.order || 0) || 1;
    tr.querySelectorAll("td[data-week]").forEach((cell) => {
      const weekDay = Number(cell.dataset.week || 0) || 1;
      const courseInput = cell.querySelector("input:not(.note-input)");
      const noteInput = cell.querySelector("input.note-input");
      const courseName = courseInput?.value.trim() || "";
      const note = noteInput?.value.trim() || "";
      if (!courseName && !note) return;
      result.push({
        id: cell.dataset.id || undefined,
        weekday: weekDay,
        orderIndex,
        courseName,
        note,
      });
    });
  });
  return result;
}

function reindexScheduleRows() {
  const rows = [...scheduleBodyEl.querySelectorAll("tr")];
  rows.forEach((tr, index) => {
    const orderIndex = index + 1;
    tr.dataset.order = String(orderIndex);
    const head = tr.querySelector("td.row-head");
    if (head) head.textContent = String(orderIndex);
  });
  scheduleRowCount = rows.length || 1;
}

async function loadScheduleSheet() {
  ensureDevice();
  const result = await request(`/schedules?deviceId=${encodeURIComponent(currentDevice.id)}`);
  renderScheduleSheet(result.data || []);
  return result;
}

async function saveScheduleSheet() {
  ensureDevice();
  const rows = collectScheduleRows();
  return await request("/schedules/batch-upsert", {
    method: "POST",
    body: {
      deviceId: currentDevice.id,
      rows,
      deletedIds: [...scheduleDeletedIds],
    },
  });
}

async function callThirdApi() {
  ensureDevice();
  const slug = byId("u-third-slug")?.value;
  if (!slug) throw new Error("请先选择模板");
  const params = collectThirdParams();
  return await request(`/third/${slug}`, {
    method: "POST",
    body: {
      deviceId: currentDevice.id,
      params,
    },
  });
}

function collectThirdParams() {
  const paramsText = byId("u-third-params")?.value || "";
  const params = parseJsonSafe(paramsText);
  document.querySelectorAll("[data-role='u-third-dynamic']").forEach((input) => {
    const key = String(input?.dataset?.name || "").trim();
    const value = String(input?.value || "").trim();
    if (!key) return;
    if (!value) {
      delete params[key];
      return;
    }
    params[key] = value;
  });
  return params;
}

async function loadDeviceThirdParams(slug) {
  ensureDevice();
  if (!slug) return;
  renderThirdDynamicFields(slug);
  const result = await request(`/devices/${encodeURIComponent(currentDevice.id)}/third-params?slug=${encodeURIComponent(slug)}`);
  const params = result.data && typeof result.data === "object" ? result.data : {};
  const consumed = new Set();
  document.querySelectorAll("[data-role='u-third-dynamic']").forEach((input) => {
    const key = String(input?.dataset?.name || "").trim();
    if (!key) return;
    const value = params[key];
    input.value = value === undefined || value === null ? "" : String(value);
    consumed.add(key);
  });

  const jsonInput = byId("u-third-params");
  if (jsonInput) {
    const next = { ...params };
    consumed.forEach((key) => delete next[key]);
    jsonInput.value = Object.keys(next).length ? JSON.stringify(next) : "";
  }
}

async function pushThirdParamsToDevice() {
  ensureDevice();
  const slug = byId("u-third-slug")?.value;
  if (!slug) throw new Error("请先选择模板");
  const params = collectThirdParams();
  return await request(`/devices/${encodeURIComponent(currentDevice.id)}/third-params`, {
    method: "POST",
    body: { slug, params },
  });
}

async function loadTfFiles() {
  const category = byId("u-tf-category")?.value || "";
  const query = new URLSearchParams();
  if (category) query.set("category", category);
  if (currentDevice) query.set("deviceId", currentDevice.id);
  const result = await request(`/tf${query.toString() ? `?${query.toString()}` : ""}`);
  const list = result.data || [];
  tfBodyEl.innerHTML = list
    .map((item) => {
      const status = item.deliverStatus === "delivered" ? "已下发" : item.deliverStatus === "pending" ? "待下发" : "";
      return `
        <tr>
          <td>${item.originalName || item.name || "-"}</td>
          <td>${item.category || "-"}</td>
          <td>${formatSize(item.size || 0)}</td>
          <td>${status || "-"}</td>
          <td>${item.createdAt || "-"}</td>
          <td>
            <button data-role="download" data-id="${item.id}">下载</button>
            <button data-role="delete" data-id="${item.id}" class="warn">删除</button>
          </td>
        </tr>
      `;
    })
    .join("");

  tfBodyEl.querySelectorAll("[data-role='download']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const file = list.find((row) => row.id === id);
      if (!file) return;
      await downloadWithAuth(`/api/tf/${file.id}/download`, file.originalName || file.name || file.id);
    });
  });
  tfBodyEl.querySelectorAll("[data-role='delete']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      await execute("删除文件", () => request(`/tf/${id}/delete`, { method: "POST" }));
      await loadTfFiles();
    });
  });

  return result;
}

async function loadTfLocalFiles() {
  if (!currentDevice) return;
  const result = await request(`/tf/device?deviceId=${encodeURIComponent(currentDevice.id)}`);
  if (tfLocalTimeEl) tfLocalTimeEl.textContent = result.data?.reportedAt || "-";
  const list = result.data?.files || [];
  tfLocalBodyEl.innerHTML = list
    .map((item) => `
      <tr>
        <td>${item.name || "-"}</td>
        <td>${item.category || "-"}</td>
        <td>${formatSize(item.size || 0)}</td>
        <td>${item.updatedAt || "-"}</td>
        <td>
          <button data-role="download" data-name="${item.name}" data-category="${item.category}">下载</button>
          <button data-role="delete" data-name="${item.name}" data-category="${item.category}" class="warn">删除</button>
        </td>
      </tr>
    `)
    .join("");

  tfLocalBodyEl.querySelectorAll("[data-role='download']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      const category = btn.dataset.category;
      await downloadWithAuth(
        `/api/tf/device/${encodeURIComponent(currentDevice.id)}/download?name=${encodeURIComponent(name)}&category=${encodeURIComponent(category)}`,
        name
      );
    });
  });
  tfLocalBodyEl.querySelectorAll("[data-role='delete']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      const category = btn.dataset.category;
      await execute("删除本地文件", () =>
        request(`/tf/device/${encodeURIComponent(currentDevice.id)}/delete`, {
          method: "POST",
          body: { name, category },
        })
      );
      await loadTfLocalFiles();
    });
  });

  return result;
}

async function uploadTfFile() {
  const fileInput = byId("u-tf-file");
  const category = byId("u-tf-category").value;
  if (!fileInput?.files?.length) throw new Error("请先选择文件");
  const formData = new FormData();
  formData.append("file", fileInput.files[0]);
  formData.append("category", category);
  return await apiUpload("/tf/upload", { token, formData });
}

async function downloadWithAuth(url, fileName) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error("下载失败");
  const blob = await response.blob();
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = fileName || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
}

async function sendRemoteImage() {
  ensureDevice();
  const file = castImageInputEl?.files?.[0];
  if (!file) throw new Error("请先选择图片");
  const formData = new FormData();
  formData.append("file", file);
  formData.append("deviceId", currentDevice.id);
  formData.append("saveToTf", "true");
  return await apiUpload("/remote/show-image", { token, formData });
}

async function switchRemoteView() {
  ensureDevice();
  const view = byId("u-remote-view")?.value;
  if (!view) throw new Error("请选择界面");
  return await request("/remote/switch-view", {
    method: "POST",
    body: { deviceId: currentDevice.id, view, saveToTf: true },
  });
}

async function sendRemoteText() {
  ensureDevice();
  const text = byId("u-remote-text")?.value.trim();
  const durationRaw = byId("u-remote-duration")?.value;
  const durationSec = Number(durationRaw || 10);
  if (!text) throw new Error("请输入要显示的文字");
  if (!Number.isFinite(durationSec) || durationSec < 10 || durationSec > 86400) {
    throw new Error("持续时间需在10秒到24小时之间");
  }
  return await request("/remote/show-text", {
    method: "POST",
    body: { deviceId: currentDevice.id, text, durationSec, saveToTf: true },
  });
}

async function startCast() {
  ensureDevice();
  if (castStream) return;
  const fps = Math.max(1, Math.min(5, Number(castFpsEl?.value || 1)));
  castStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  castVideo = document.createElement("video");
  castVideo.srcObject = castStream;
  await castVideo.play();
  castCanvas = document.createElement("canvas");

  const sendFrame = async () => {
    if (!castVideo || castVideo.readyState < 2) return;
    const width = 800;
    const ratio = castVideo.videoHeight / castVideo.videoWidth || 0.75;
    const height = Math.round(width * ratio);
    castCanvas.width = width;
    castCanvas.height = height;
    const ctx = castCanvas.getContext("2d");
    ctx.drawImage(castVideo, 0, 0, width, height);
    const imageData = castCanvas.toDataURL("image/jpeg", 0.6);
    try {
      await request("/remote/cast-frame", {
        method: "POST",
        body: { deviceId: currentDevice.id, imageData, width, height },
      });
    } catch (_) {
      // ignore single frame errors
    }
  };

  castTimer = setInterval(sendFrame, Math.round(1000 / fps));
  const [track] = castStream.getVideoTracks();
  if (track) {
    track.addEventListener("ended", () => {
      stopCast({ notifyDevice: true, reason: "browser_track_ended" });
      notifyInfo("投屏已结束，已通知设备退出");
    });
  }
}

async function notifyCastStop(reason = "ended") {
  if (!currentDevice) return;
  await request("/remote/cast-stop", {
    method: "POST",
    body: { deviceId: currentDevice.id, reason },
  });
}

function stopCast({ notifyDevice = true, reason = "ended" } = {}) {
  if (castTimer) {
    clearInterval(castTimer);
    castTimer = null;
  }
  if (castStream) {
    castStream.getTracks().forEach((t) => t.stop());
    castStream = null;
  }
  castVideo = null;
  castCanvas = null;
  if (notifyDevice) {
    notifyCastStop(reason).catch(() => {});
  }
}

on("u-login", "click", async () => {
  const username = byId("u-username").value.trim();
  const password = byId("u-password").value;
  if (!username || !password) {
    notifyError("请输入账号和密码");
    return;
  }
  try {
    const result = await apiRequest("/auth/user/login", {
      method: "POST",
      body: { username, password },
    });
    token = result.data?.token || "";
    setStorage("user_token", token);
    setAuthed(true);
    notifySuccess("登录成功");
    await loadOverview();
    await loadTemplates();
    await loadFirmwares();
  } catch (error) {
    print({ error: error.message || String(error) });
    notifyError(error.message || "登录失败");
  }
});

on("u-logout", "click", async () => {
  try {
    if (token) await apiRequest("/auth/logout", { method: "POST", token });
  } catch (_) {
    // ignore
  }
  token = "";
  setStorage("user_token", "");
  setAuthed(false);
  notifyInfo("已退出登录");
});

on("u-quick-pick", "click", async () => {
  try {
    await pickDevice();
  } catch (error) {
    notifyError(error.message || "选择设备失败");
  }
});

on("u-overview-refresh", "click", async () => {
  await execute("刷新概览", () => loadOverview(), "概览已更新");
});

on("u-bind-pin-btn", "click", async () => {
  const pin = byId("u-bind-pin").value.trim();
  if (!pin) return notifyError("请输入PIN码");
  const result = await execute("PIN绑定", () => request("/devices/bind-pin", { method: "POST", body: { pin } }));
  if (result?.data) setCurrentDevice(result.data);
});

on("u-delete-device", "click", async () => {
  if (!currentDevice) return notifyError("请先选择设备");
  await execute("删除设备", () => request(`/devices/${currentDevice.id}/delete`, { method: "POST" }));
  setCurrentDevice(null);
});

on("u-load-fw", "click", async () => {
  await execute("刷新固件列表", () => loadFirmwares(), "已刷新固件列表");
});

on("u-upgrade-fw", "click", async () => {
  ensureDevice();
  const firmwareId = byId("u-fw-select")?.value;
  if (!firmwareId) return notifyError("请选择固件版本");
  const scheduledAt = byId("u-fw-schedule")?.value;
  await execute("固件升级", () =>
    request("/firmware/upgrade", {
      method: "POST",
      body: {
        deviceId: currentDevice.id,
        firmwareId,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : "",
      },
    })
  );
});

on("u-todo-load", "click", async () => {
  await execute("加载TODO", () => loadTodoSheet());
});

on("u-todo-add", "click", () => {
  appendTodoRow({});
});

on("u-todo-save", "click", async () => {
  await execute("保存TODO", () => saveTodoSheet());
});

on("u-todo-reset", "click", async () => {
  await execute("回滚TODO", () => loadTodoSheet());
});

on("u-sch-load", "click", async () => {
  await execute("加载课程表", () => loadScheduleSheet());
});

on("u-sch-add", "click", () => {
  scheduleRowCount += 1;
  scheduleBodyEl.appendChild(createScheduleRow(scheduleRowCount, new Map()));
});

on("u-sch-remove", "click", () => {
  const rows = [...scheduleBodyEl.querySelectorAll("tr")];
  const selected = rows.filter((row) => row.querySelector(".row-selector")?.checked);
  if (selected.length === 0) {
    notifyInfo("请先勾选要删除的行");
    return;
  }
  selected.forEach((row) => {
    row.querySelectorAll("td[data-week]").forEach((cell) => {
      if (cell.dataset.id) scheduleDeletedIds.add(cell.dataset.id);
    });
    row.remove();
  });
  reindexScheduleRows();
});

on("u-sch-save", "click", async () => {
  await execute("保存课程表", () => saveScheduleSheet());
});

on("u-sch-reset", "click", async () => {
  await execute("回滚课程表", () => loadScheduleSheet());
});

on("u-sch-select-all", "change", (event) => {
  scheduleBodyEl.querySelectorAll(".row-selector").forEach((input) => {
    input.checked = event.target.checked;
  });
});

on("u-third-call", "click", async () => {
  await execute("调用API", () => callThirdApi());
});

on("u-third-push", "click", async () => {
  await execute("下发参数", () => pushThirdParamsToDevice());
});

on("u-third-slug", "change", async (event) => {
  const slug = event?.target?.value || "";
  renderThirdDynamicFields(slug);
  if (!currentDevice) return;
  try {
    await loadDeviceThirdParams(slug);
  } catch (error) {
    notifyError(`加载设备参数失败：${error.message || String(error)}`);
  }
});

on("u-tf-refresh", "click", async () => {
  await execute("刷新云端文件", () => loadTfFiles());
});

on("u-tf-local-refresh", "click", async () => {
  await execute("刷新本地文件", () => loadTfLocalFiles());
});

on("u-tf-upload", "click", async () => {
  await execute("上传文件", () => uploadTfFile());
  await loadTfFiles();
});

on("u-cast-image", "change", () => {
  const file = castImageInputEl?.files?.[0];
  if (!file || !castImagePreviewEl) return;
  const url = URL.createObjectURL(file);
  castImagePreviewEl.src = url;
  castImagePreviewEl.classList.remove("hidden");
  castImagePreviewEl.onload = () => URL.revokeObjectURL(url);
});

on("u-cast-image-send", "click", async () => {
  await execute("发送图片", () => sendRemoteImage());
});

on("u-cast-start", "click", async () => {
  try {
    await startCast();
    notifySuccess("开始投屏");
  } catch (error) {
    notifyError(error.message || "投屏失败");
  }
});

on("u-cast-stop", "click", () => {
  stopCast({ notifyDevice: true, reason: "manual_stop" });
  notifyInfo("已停止投屏");
});

on("u-remote-view-btn", "click", async () => {
  await execute("切换界面", () => switchRemoteView());
});

on("u-remote-text-btn", "click", async () => {
  await execute("发送文字", () => sendRemoteText());
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
  const collapsed = getStorage("user_output_collapsed") === "1";
  setOutputCollapsed(collapsed);
  outputToggleEl.addEventListener("click", () => {
    const next = !outputPanelEl.classList.contains("collapsed");
    setOutputCollapsed(next);
  });
}

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => showSection(btn.dataset.sectionTarget));
});

if (token) {
  setAuthed(true);
  loadOverview().catch(() => {});
  loadTemplates().catch(() => {});
  loadFirmwares().catch(() => {});
} else {
  setAuthed(false);
}

setScriptStatus("已加载");
console.log(`user.js ${VERSION} loaded`);


