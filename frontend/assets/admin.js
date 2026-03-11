
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
let token = getStorage("admin_token");
let currentDevice = null;
let keyDevice = null;
let batchKeyDeviceIds = [];
let upgradeDeviceIds = [];
let templatesCache = [];
let firmwareCache = [];
let userCache = [];
let todoDeletedIds = new Set();
let scheduleDeletedIds = new Set();
let scheduleRowCount = 1;

const outputEl = byId("a-output");
const outputPanelEl = byId("a-output-panel");
const outputHandleEl = byId("a-output-handle");
const outputToggleEl = byId("a-output-toggle");
const scriptStatusEl = byId("a-script-status");
const navGuestEl = byId("a-nav-guest");
const navAppEl = byId("a-nav-app");
const logoutBtn = byId("a-logout");
const currentDeviceEl = byId("a-current-device");
const quickDeviceEl = byId("a-quick-device");
const quickCurrentDeviceEl = byId("a-quick-current-device");
const keyDeviceEl = byId("a-key-device");
const batchDevicesEl = byId("a-batch-devices-label");
const upgradeDevicesEl = byId("a-upgrade-devices");
const templateBodyEl = byId("a-template-body");
const keyBodyEl = byId("a-key-body");
const todoBodyEl = byId("a-todo-body");
const scheduleBodyEl = byId("a-sch-body");
const scheduleSelectAllEl = byId("a-sch-select-all");
const userBodyEl = byId("a-user-body");
const tfBodyEl = byId("a-tf-body");
const tfLocalBodyEl = byId("a-tf-local-body");
const tfLocalTimeEl = byId("a-tf-local-time");
const tfCurrentDeviceEl = byId("a-tf-current-device");
const firmwareListBodyEl = byId("a-fw-list-body");
const remoteDeviceEl = byId("a-remote-device");
const castImageInputEl = byId("a-cast-image");
const castImagePreviewEl = byId("a-cast-image-preview");
const castFpsEl = byId("a-cast-fps");
const navButtons = [...document.querySelectorAll("[data-section-target]")];
const sections = [...document.querySelectorAll("[data-section]")];

let castStream = null;
let castTimer = null;
let castVideo = null;
let castCanvas = null;

let advancedModal = null;
let advancedDraft = null;
let advancedTarget = null;

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
  setStorage("admin_output_collapsed", collapsed ? "1" : "");
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
  if (name === "users" && token) {
    loadUserCache().catch((error) => {
      print({ error: error.message || String(error) });
      notifyError(`加载账号失败：${error.message || String(error)}`);
    });
  }
  if (name === "templates" && token) {
    loadTemplates().catch((error) => {
      print({ error: error.message || String(error) });
      notifyError(`加载模板失败：${error.message || String(error)}`);
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

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

async function request(path, options = {}) {
  if (!token) throw new Error("请先登录管理端");
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
    byId("a-device-status").value = currentDevice.status || "enabled";
    byId("a-device-remark").value = currentDevice.remark || "";
    byId("a-device-owner").value = currentDevice.ownerId || "";
  } else {
    byId("a-device-status").value = "enabled";
    byId("a-device-remark").value = "";
    byId("a-device-owner").value = "";
  }
}

function setKeyDevice(device) {
  keyDevice = device || null;
  keyDeviceEl.textContent = keyDevice ? `${keyDevice.id} (${keyDevice.mac})` : "未选择";
}

function setBatchDevices(ids) {
  batchKeyDeviceIds = [...ids];
  batchDevicesEl.textContent = batchKeyDeviceIds.length ? batchKeyDeviceIds.join(", ") : "未选择";
}

function setUpgradeDevices(ids) {
  upgradeDeviceIds = [...ids];
  upgradeDevicesEl.textContent = upgradeDeviceIds.length ? upgradeDeviceIds.join(", ") : "未选择";
}

async function pickDevice() {
  const result = await openDevicePicker({ token, title: "选择设备", multiple: false, bound: true });
  if (result.devices && result.devices[0]) setCurrentDevice(result.devices[0]);
}

async function pickKeyDevice() {
  const result = await openDevicePicker({ token, title: "选择设备", multiple: false, bound: true });
  if (result.devices && result.devices[0]) setKeyDevice(result.devices[0]);
}

async function pickBatchDevices() {
  const result = await openDevicePicker({ token, title: "选择设备", multiple: true, bound: true });
  if (result.ids) setBatchDevices(result.ids);
}

async function pickUpgradeDevices() {
  const result = await openDevicePicker({ token, title: "选择设备", multiple: true, bound: true });
  if (result.ids) setUpgradeDevices(result.ids);
}

async function loadOverview() {
  const result = await request("/admin/dashboard");
  const data = result.data || {};
  byId("a-overview-device-total").textContent = data.deviceTotal ?? 0;
  byId("a-overview-device-blocked").textContent = data.blockedDevices ?? 0;
  byId("a-overview-user-total").textContent = data.userTotal ?? 0;
  byId("a-overview-cluster-total").textContent = data.clusterTotal ?? 0;
  byId("a-overview-firmware-total").textContent = data.firmwareTotal ?? 0;

  const statEl = byId("a-overview-api-stat");
  if (statEl && data.apiStats) {
    const entries = Object.entries(data.apiStats)
      .slice(0, 6)
      .map(([slug, item]) => `${slug}: ${item.total}`);
    statEl.textContent = entries.length ? entries.join(" / ") : "-";
  }
  return result;
}

async function loadUserCache() {
  const result = await request("/admin/users");
  userCache = result.data || [];
  renderUserList();
  fillUserSelects();
  return userCache;
}

function fillUserSelects() {
  const bindSelect = byId("a-bind-user");
  const resourceUser = byId("a-resource-user");
  const resourceTarget = byId("a-resource-target");
  const tfOwner = byId("a-tf-owner");
  const options = userCache
    .map((user) => `<option value="${user.id}">${user.username} (${user.id})</option>`)
    .join("");
  if (bindSelect) bindSelect.innerHTML = options;
  if (resourceUser) resourceUser.innerHTML = options;
  if (resourceTarget) resourceTarget.innerHTML = options;
  if (tfOwner) tfOwner.innerHTML = `<option value="">全部</option>${options}`;
}

function renderUserList() {
  if (!userBodyEl) return;
  userBodyEl.innerHTML = userCache
    .map((user) => {
      return `
      <tr data-id="${user.id}">
        <td>${user.username}</td>
        <td>
          <select data-field="role">
            <option value="user" ${user.role === "user" ? "selected" : ""}>user</option>
            <option value="admin" ${user.role === "admin" ? "selected" : ""}>admin</option>
          </select>
        </td>
        <td>
          <select data-field="status">
            <option value="enabled" ${user.status === "enabled" ? "selected" : ""}>enabled</option>
            <option value="blocked" ${user.status === "blocked" ? "selected" : ""}>blocked</option>
          </select>
        </td>
        <td><input data-field="nickname" value="${user.nickname || ""}" /></td>
        <td>${user.deviceCount ?? 0}</td>
        <td><input data-field="password" type="password" placeholder="新密码" /></td>
        <td>
          <select data-field="delete-mode">
            <option value="detach">detach</option>
            <option value="purge">purge</option>
          </select>
        </td>
        <td>
          <button data-role="update">更新</button>
          <button data-role="delete" class="warn">删除</button>
        </td>
      </tr>
      `;
    })
    .join("");

  userBodyEl.querySelectorAll("[data-role='update']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("tr");
      const userId = row.dataset.id;
      const nickname = row.querySelector('[data-field="nickname"]').value;
      const status = row.querySelector('[data-field="status"]').value;
      const role = row.querySelector('[data-field="role"]').value;
      const password = row.querySelector('[data-field="password"]').value.trim();
      const payload = { nickname, status, role };
      if (password) payload.password = password;
      await execute("更新账号", () => request(`/admin/users/${userId}`, { method: "POST", body: payload }));
      await loadUserCache();
    });
  });
  userBodyEl.querySelectorAll("[data-role='delete']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("tr");
      const userId = row.dataset.id;
      const mode = row.querySelector('[data-field="delete-mode"]').value;
      await execute("删除账号", () => request(`/admin/users/${userId}/delete`, { method: "POST", body: { mode } }));
      await loadUserCache();
    });
  });
}
async function loadTemplates() {
  const result = await request("/templates");
  templatesCache = result.data || [];
  renderTemplates();
  renderTemplateOptions();
  await loadKeyDeviceKeys();
  return templatesCache;
}

function renderTemplateOptions() {
  const select = byId("a-batch-template");
  if (!select) return;
  select.innerHTML = templatesCache
    .map((tpl) => `<option value="${tpl.slug}">${tpl.name || tpl.slug}</option>`)
    .join("");
}

function keyInLabel(list) {
  if (!list || list.length === 0) return "query";
  return list.join("+");
}

function renderKeyInPicker(values) {
  const list = Array.isArray(values) ? values : [values].filter(Boolean);
  const label = keyInLabel(list);
  return `
    <div class="keyin-picker" data-role="keyin-picker" data-value="${list.join(",")}">
      <button type="button" class="keyin-preview" data-role="keyin-preview">${label}</button>
      <div class="keyin-menu">
        <label><input type="checkbox" value="header" ${list.includes("header") ? "checked" : ""} /> header</label>
        <label><input type="checkbox" value="query" ${list.includes("query") ? "checked" : ""} /> query</label>
        <label><input type="checkbox" value="body" ${list.includes("body") ? "checked" : ""} /> body</label>
      </div>
    </div>
  `;
}

function bindKeyInPickers() {
  document.querySelectorAll("[data-role='keyin-picker']").forEach((picker) => {
    const preview = picker.querySelector('[data-role="keyin-preview"]');
    preview.addEventListener("click", (event) => {
      event.stopPropagation();
      picker.classList.toggle("open");
    });
    picker.querySelectorAll("input[type='checkbox']").forEach((input) => {
      input.addEventListener("change", () => {
        const selected = [...picker.querySelectorAll("input[type='checkbox']")]
          .filter((item) => item.checked)
          .map((item) => item.value);
        picker.dataset.value = selected.join(",");
        preview.textContent = keyInLabel(selected);
      });
    });
  });
}

document.addEventListener("click", () => {
  document.querySelectorAll(".keyin-picker.open").forEach((picker) => picker.classList.remove("open"));
});

function parseUserInputFieldLines(text) {
  const rows = [];
  String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [nameRaw, ...hintRaw] = line.split("|");
      const name = String(nameRaw || "").trim();
      const placeholder = String(hintRaw.join("|") || "").trim();
      if (!name) return;
      rows.push({ name, placeholder });
    });
  return rows;
}

function stringifyUserInputFields(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => `${String(item?.name || "").trim()}|${String(item?.placeholder || "").trim()}`)
    .filter((line) => !line.startsWith("|"))
    .join("\n");
}

function buildLegacyAdvancedConfigFromBasic(basicConfig = {}) {
  return {
    output: "",
    timeoutMs: 8000,
    steps: [
      {
        name: "step1",
        method: String(basicConfig.method || "GET").toUpperCase(),
        url: String(basicConfig.url || ""),
        legacyCompat: true,
        passInputParams: true,
        headers: {},
        params: {},
        body: {},
        extract: [],
      },
    ],
  };
}

function ensureRowAdvancedConfig(row) {
  const config = row?._advancedConfig;
  if (config && typeof config === "object" && Array.isArray(config.steps) && config.steps.length) return config;
  row._advancedConfig = buildLegacyAdvancedConfigFromBasic(row?._basicConfig || {});
  return row._advancedConfig;
}

function renderTemplates() {
  if (!templateBodyEl) return;
  templateBodyEl.innerHTML = templatesCache
    .map((tpl) => {
      const userInputFieldsText = stringifyUserInputFields(tpl.userInputFields);
      return `
      <tr data-id="${tpl.id || ""}">
        <td><input data-field="name" value="${tpl.name || ""}" /></td>
        <td><input data-field="slug" value="${tpl.slug || ""}" ${tpl.builtin ? "disabled" : ""} /></td>
        <td>
          <textarea data-field="userInputFieldsText" rows="4" placeholder="一行一个：参数名|提示文本">${userInputFieldsText}</textarea>
          <div class="tiny muted">例如：cityId|天气城市ID（101010100）</div>
        </td>
        <td><input data-field="deviceKeyRequired" type="checkbox" ${tpl.deviceKeyRequired ? "checked" : ""} /></td>
        <td><input data-field="enabled" type="checkbox" ${tpl.enabled ? "checked" : ""} /></td>
        <td data-role="template-actions">
          <button data-role="advanced-config" type="button" class="secondary">高级配置</button>
          <button data-role="save" type="button">保存</button>
          <button data-role="delete" type="button" class="warn" ${tpl.builtin ? "disabled" : ""}>删除</button>
        </td>
      </tr>
      `;
    })
    .join("");

  templateBodyEl.querySelectorAll("tr").forEach((row, index) => {
    const tpl = templatesCache[index] || {};
    const fallbackKeyIn = Array.isArray(tpl.keyIn) ? [...tpl.keyIn] : [tpl.keyIn || "query"];
    row._basicConfig = {
      method: tpl.method || "GET",
      url: tpl.url || "",
      keyField: tpl.keyField || "key",
      keyIn: fallbackKeyIn.length ? fallbackKeyIn : ["query"],
      defaultParams:
        tpl.defaultParams && typeof tpl.defaultParams === "object" && !Array.isArray(tpl.defaultParams)
          ? JSON.parse(JSON.stringify(tpl.defaultParams))
          : {},
      keyConcatEnabled: Boolean(tpl.keyConcatEnabled),
      keyConcatFields: Array.isArray(tpl.keyConcatFields) ? [...tpl.keyConcatFields] : [],
      keyConcatSeparator: String(tpl.keyConcatSeparator || "|"),
    };
    row._advancedConfig =
      tpl.advancedConfig && typeof tpl.advancedConfig === "object" && !Array.isArray(tpl.advancedConfig)
        ? JSON.parse(JSON.stringify(tpl.advancedConfig))
        : {};
    ensureRowAdvancedConfig(row);
  });

  templateBodyEl.querySelectorAll("[data-role='save']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("tr");
      const payload = readTemplateRow(row);
      if (!payload.slug || !payload.name) {
        notifyError("name/slug 不能为空");
        return;
      }
      if (row.dataset.id) {
        await execute("更新模板", () => request(`/templates/${row.dataset.id}`, { method: "POST", body: payload }));
      } else {
        await execute("新增模板", () => request("/templates", { method: "POST", body: payload }));
      }
      await loadTemplates();
    });
  });

  templateBodyEl.querySelectorAll("[data-role='delete']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("tr");
      if (!row.dataset.id) return;
      await execute("删除模板", () => request(`/templates/${row.dataset.id}/delete`, { method: "POST" }));
      await loadTemplates();
    });
  });

  templateBodyEl.querySelectorAll("[data-role='advanced-config']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("tr");
      ensureRowAdvancedConfig(row);
      openAdvancedEditor(row);
    });
  });
}

function readTemplateRow(row) {
  const basicConfig = row._basicConfig || {};
  const userInputFieldsText = row.querySelector('[data-field="userInputFieldsText"]')?.value || "";
  const userInputFields = parseUserInputFieldLines(userInputFieldsText);
  const advancedConfig = ensureRowAdvancedConfig(row);
  return {
    name: row.querySelector('[data-field="name"]').value.trim(),
    slug: row.querySelector('[data-field="slug"]').value.trim(),
    method: String(basicConfig.method || "GET").toUpperCase(),
    url: String(basicConfig.url || ""),
    keyField: String(basicConfig.keyField || "key"),
    keyIn: Array.isArray(basicConfig.keyIn) && basicConfig.keyIn.length ? [...basicConfig.keyIn] : ["query"],
    keyConcatEnabled: Boolean(basicConfig.keyConcatEnabled),
    keyConcatFields: Array.isArray(basicConfig.keyConcatFields) ? [...basicConfig.keyConcatFields] : [],
    keyConcatSeparator: String(basicConfig.keyConcatSeparator || "|"),
    userInputFields,
    deviceKeyRequired: row.querySelector('[data-field="deviceKeyRequired"]').checked,
    defaultParams:
      basicConfig.defaultParams && typeof basicConfig.defaultParams === "object" && !Array.isArray(basicConfig.defaultParams)
        ? JSON.parse(JSON.stringify(basicConfig.defaultParams))
        : {},
    enabled: row.querySelector('[data-field="enabled"]').checked,
    advancedConfig,
  };
}

async function loadKeyDeviceKeys() {
  if (!keyDevice) {
    keyBodyEl.innerHTML = "";
    return;
  }
  const result = await request(`/templates/device/${keyDevice.id}/keys`);
  const keys = result.data || {};
  keyBodyEl.innerHTML = templatesCache
    .map((tpl) => {
      const value = keys[tpl.slug] || "";
      const concatHint =
        tpl.keyConcatEnabled && Array.isArray(tpl.keyConcatFields) && tpl.keyConcatFields.length > 1
          ? `拼接格式：${tpl.keyConcatFields.join(String(tpl.keyConcatSeparator || "|"))}`
          : "单Key（可空清空）";
      return `
      <tr data-slug="${tpl.slug}">
        <td>${tpl.name || tpl.slug}<div class="tiny muted">${concatHint}</div></td>
        <td><input data-field="key" value="${value}" placeholder="${concatHint}" /></td>
      </tr>
      `;
    })
    .join("");
}

async function saveKeyDeviceKeys() {
  if (!keyDevice) throw new Error("请先选择设备");
  const keys = {};
  keyBodyEl.querySelectorAll("tr").forEach((tr) => {
    const slug = tr.dataset.slug;
    const value = tr.querySelector('[data-field="key"]').value.trim();
    if (value) keys[slug] = value;
  });
  return await request(`/templates/device/${keyDevice.id}/keys`, { method: "POST", body: { keys } });
}

function ensureAdvancedModal() {
  if (advancedModal) return advancedModal;
  advancedModal = document.createElement("div");
  advancedModal.className = "modal hidden";
  advancedModal.innerHTML = `
    <div class="modal-backdrop" data-role="close"></div>
    <div class="modal-dialog">
      <div class="modal-header">
        <div>
          <h3>高级配置步骤编辑器</h3>
          <p class="tiny muted">支持多步骤调用、变量、正则与 JSONPath 提取。</p>
        </div>
        <button type="button" class="ghost" data-role="close">关闭</button>
      </div>
      <div class="modal-body">
        <div class="row row-2">
          <div>
            <label>输出模板（可空）</label>
            <textarea id="adv-output" placeholder="例如：{{vars.city}}"></textarea>
          </div>
          <div>
            <label>超时(ms)</label>
            <input id="adv-timeout" type="number" min="0" placeholder="例如 5000" />
          </div>
        </div>
        <div id="adv-steps" class="stack"></div>
        <button id="adv-add-step" type="button" class="secondary">新增步骤</button>
      </div>
      <div class="modal-footer actions">
        <button id="adv-save" type="button">保存配置</button>
        <button id="adv-cancel" type="button" class="ghost">取消</button>
      </div>
    </div>
  `;
  document.body.appendChild(advancedModal);
  return advancedModal;
}

function createEmptyStep() {
  return {
    name: "",
    method: "GET",
    url: "",
    legacyCompat: false,
    passInputParams: false,
    headers: [],
    params: [],
    body: [],
    extract: [],
  };
}

function openAdvancedEditor(row) {
  const modal = ensureAdvancedModal();
  ensureRowAdvancedConfig(row);
  const existing = row._advancedConfig || {};
  advancedDraft = {
    output: existing.output || "",
    timeoutMs: existing.timeoutMs || existing.timeout || 0,
    steps:
      Array.isArray(existing.steps) && existing.steps.length
          ? existing.steps.map((step) => ({
              name: step.name || "",
              method: step.method || "GET",
              url: step.url || "",
              legacyCompat: Boolean(step.legacyCompat),
              passInputParams: Boolean(step.passInputParams),
              headers: objectToPairs(step.headers),
              params: objectToPairs(step.params),
              body: objectToPairs(step.body),
            extract: Array.isArray(step.extract)
              ? step.extract.map((item) => ({
                  type: item.type || "regex",
                  source: item.source || "body",
                  pattern: item.pattern || item.regex || "",
                  flags: item.flags || "",
                  group: item.group || "1",
                  path: item.path || "",
                  saveAs: item.saveAs || "",
                }))
              : [],
          }))
        : [createEmptyStep()],
  };
  advancedTarget = row;
  renderAdvancedEditor();
  modal.classList.remove("hidden");

  modal.querySelectorAll('[data-role="close"]').forEach((el) => {
    el.onclick = () => closeAdvancedEditor(false);
  });
  modal.querySelector("#adv-cancel").onclick = () => closeAdvancedEditor(false);
  modal.querySelector("#adv-save").onclick = () => closeAdvancedEditor(true);
  modal.querySelector("#adv-add-step").onclick = () => {
    advancedDraft.steps.push(createEmptyStep());
    renderAdvancedEditor();
  };
}

function closeAdvancedEditor(save) {
  if (!advancedModal) return;
  if (save && advancedTarget) {
    advancedTarget._advancedConfig = buildAdvancedConfig(advancedDraft);
    notifySuccess("高级配置已更新（记得点击保存模板）");
  }
  advancedModal.classList.add("hidden");
}

function objectToPairs(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj).map((key) => ({ key, value: obj[key] }));
}

function pairsToObject(list) {
  const result = {};
  (list || []).forEach((item) => {
    if (!item.key) return;
    result[item.key] = item.value ?? "";
  });
  return result;
}

function buildAdvancedConfig(draft) {
  return {
    output: draft.output || "",
    timeoutMs: draft.timeoutMs ? Number(draft.timeoutMs) : undefined,
    steps: draft.steps.map((step) => ({
      name: step.name || "",
      method: step.method || "GET",
      url: step.url || "",
      legacyCompat: Boolean(step.legacyCompat),
      passInputParams: Boolean(step.passInputParams),
      headers: pairsToObject(step.headers),
      params: pairsToObject(step.params),
      body: pairsToObject(step.body),
      extract: (step.extract || []).filter((item) => item.saveAs || item.pattern || item.path),
    })),
  };
}

function renderAdvancedEditor() {
  const modal = ensureAdvancedModal();
  const outputEl = modal.querySelector("#adv-output");
  const timeoutEl = modal.querySelector("#adv-timeout");
  const stepsEl = modal.querySelector("#adv-steps");

  outputEl.value = advancedDraft.output || "";
  timeoutEl.value = advancedDraft.timeoutMs || "";

  outputEl.oninput = () => {
    advancedDraft.output = outputEl.value;
  };
  timeoutEl.oninput = () => {
    advancedDraft.timeoutMs = Number(timeoutEl.value || 0);
  };

  stepsEl.innerHTML = advancedDraft.steps
    .map((step, idx) => {
      return `
      <div class="card stack" data-step="${idx}">
        <div class="actions">
          <strong>步骤 ${idx + 1}</strong>
          <button type="button" class="ghost" data-role="remove-step">删除步骤</button>
        </div>
        <div class="row row-3">
          <div>
            <label>名称</label>
            <input data-field="name" value="${step.name || ""}" placeholder="step name" />
          </div>
          <div>
            <label>方法</label>
            <select data-field="method">
              <option value="GET" ${step.method === "GET" ? "selected" : ""}>GET</option>
              <option value="POST" ${step.method === "POST" ? "selected" : ""}>POST</option>
              <option value="PUT" ${step.method === "PUT" ? "selected" : ""}>PUT</option>
              <option value="PATCH" ${step.method === "PATCH" ? "selected" : ""}>PATCH</option>
            </select>
          </div>
          <div>
            <label>URL</label>
            <input data-field="url" value="${step.url || ""}" placeholder="https://..." />
          </div>
        </div>
        ${renderPairSection("headers", "Headers", step.headers)}
        ${renderPairSection("params", "Query 参数", step.params)}
        ${renderPairSection("body", "Body 参数", step.body)}
        ${renderExtractSection(step.extract)}
      </div>
      `;
    })
    .join("");

  stepsEl.querySelectorAll("[data-role='remove-step']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const stepIndex = Number(btn.closest("[data-step]").dataset.step);
      advancedDraft.steps.splice(stepIndex, 1);
      if (advancedDraft.steps.length === 0) advancedDraft.steps.push(createEmptyStep());
      renderAdvancedEditor();
    });
  });

  stepsEl.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("input", () => {
      const stepIndex = Number(input.closest("[data-step]").dataset.step);
      const field = input.dataset.field;
      advancedDraft.steps[stepIndex][field] = input.value;
    });
  });

  stepsEl.querySelectorAll("[data-role='add-pair']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const stepIndex = Number(btn.closest("[data-step]").dataset.step);
      const type = btn.dataset.type;
      advancedDraft.steps[stepIndex][type].push({ key: "", value: "" });
      renderAdvancedEditor();
    });
  });

  stepsEl.querySelectorAll("[data-role='remove-pair']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const stepIndex = Number(btn.closest("[data-step]").dataset.step);
      const type = btn.dataset.type;
      const rowIndex = Number(btn.dataset.index);
      advancedDraft.steps[stepIndex][type].splice(rowIndex, 1);
      renderAdvancedEditor();
    });
  });

  stepsEl.querySelectorAll("[data-role='pair-key']").forEach((input) => {
    input.addEventListener("input", () => {
      const stepIndex = Number(input.closest("[data-step]").dataset.step);
      const type = input.dataset.type;
      const rowIndex = Number(input.dataset.index);
      advancedDraft.steps[stepIndex][type][rowIndex].key = input.value;
    });
  });

  stepsEl.querySelectorAll("[data-role='pair-value']").forEach((input) => {
    input.addEventListener("input", () => {
      const stepIndex = Number(input.closest("[data-step]").dataset.step);
      const type = input.dataset.type;
      const rowIndex = Number(input.dataset.index);
      advancedDraft.steps[stepIndex][type][rowIndex].value = input.value;
    });
  });

  stepsEl.querySelectorAll("[data-role='add-extract']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const stepIndex = Number(btn.closest("[data-step]").dataset.step);
      advancedDraft.steps[stepIndex].extract.push({
        type: "regex",
        source: "body",
        pattern: "",
        flags: "",
        group: "1",
        path: "",
        saveAs: "",
      });
      renderAdvancedEditor();
    });
  });

  stepsEl.querySelectorAll("[data-role='remove-extract']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const stepIndex = Number(btn.closest("[data-step]").dataset.step);
      const rowIndex = Number(btn.dataset.index);
      advancedDraft.steps[stepIndex].extract.splice(rowIndex, 1);
      renderAdvancedEditor();
    });
  });

  stepsEl.querySelectorAll("[data-role='extract-field']").forEach((input) => {
    input.addEventListener("input", () => {
      const stepIndex = Number(input.closest("[data-step]").dataset.step);
      const rowIndex = Number(input.dataset.index);
      const field = input.dataset.field;
      advancedDraft.steps[stepIndex].extract[rowIndex][field] = input.value;
    });
  });
}

function renderPairSection(type, title, list) {
  const rows = (list || []).length ? list : [];
  const rowsHtml = rows
    .map((row, index) => {
      return `
        <div class="row row-2" data-row="${index}">
          <input data-role="pair-key" data-type="${type}" data-index="${index}" placeholder="key" value="${row.key || ""}" />
          <div class="inline-inputs">
            <input data-role="pair-value" data-type="${type}" data-index="${index}" placeholder="value" value="${row.value || ""}" />
            <button type="button" class="ghost" data-role="remove-pair" data-type="${type}" data-index="${index}">删除</button>
          </div>
        </div>
      `;
    })
    .join("");
  return `
    <div class="stack">
      <div class="actions">
        <strong>${title}</strong>
        <button type="button" class="ghost" data-role="add-pair" data-type="${type}">新增</button>
      </div>
      ${rowsHtml || `<div class="tiny muted">暂无${title}</div>`}
    </div>
  `;
}

function renderExtractSection(list) {
  const rows = (list || []).map((row, index) => {
    return `
      <div class="row row-3">
        <div>
          <label>类型</label>
          <select data-role="extract-field" data-field="type" data-index="${index}">
            <option value="regex" ${row.type === "regex" ? "selected" : ""}>regex</option>
            <option value="jsonpath" ${row.type === "jsonpath" ? "selected" : ""}>jsonpath</option>
          </select>
        </div>
        <div>
          <label>来源</label>
          <select data-role="extract-field" data-field="source" data-index="${index}">
            <option value="body" ${row.source === "body" ? "selected" : ""}>body</option>
            <option value="headers" ${row.source === "headers" ? "selected" : ""}>headers</option>
          </select>
        </div>
        <div>
          <label>保存为</label>
          <input data-role="extract-field" data-field="saveAs" data-index="${index}" value="${row.saveAs || ""}" />
        </div>
      </div>
      <div class="row row-3">
        <div>
          <label>正则/路径</label>
          <input data-role="extract-field" data-field="pattern" data-index="${index}" value="${row.pattern || row.path || ""}" />
        </div>
        <div>
          <label>Flags</label>
          <input data-role="extract-field" data-field="flags" data-index="${index}" value="${row.flags || ""}" />
        </div>
        <div>
          <label>Group</label>
          <input data-role="extract-field" data-field="group" data-index="${index}" value="${row.group || "1"}" />
        </div>
      </div>
      <div class="actions">
        <button type="button" class="ghost" data-role="remove-extract" data-index="${index}">删除规则</button>
      </div>
    `;
  });

  return `
    <div class="stack">
      <div class="actions">
        <strong>提取规则</strong>
        <button type="button" class="ghost" data-role="add-extract">新增规则</button>
      </div>
      ${rows.length ? rows.join("") : `<div class="tiny muted">暂无提取规则</div>`}
    </div>
  `;
}
async function loadFirmwares() {
  const result = await request("/firmware");
  firmwareCache = (result.data || []).slice().sort((a, b) => {
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });
  renderFirmwareList();

  const latest = firmwareCache[0] || null;
  const select = byId("a-upgrade-fw");
  if (select) {
    if (latest) {
      select.innerHTML = `<option value="${latest.id}">${latest.version} (${latest.deviceType || "all"}) [最新]</option>`;
      select.value = latest.id;
    } else {
      select.innerHTML = `<option value="">暂无固件</option>`;
    }
  }
  return firmwareCache;
}

function renderFirmwareList() {
  if (!firmwareListBodyEl) return;
  if (!firmwareCache.length) {
    firmwareListBodyEl.innerHTML = `<tr><td colspan="6" class="muted">暂无固件</td></tr>`;
    return;
  }

  const latestId = firmwareCache[0]?.id || "";
  firmwareListBodyEl.innerHTML = firmwareCache
    .map((item) => {
      const latestTag = item.id === latestId ? " <span class='pill'>最新</span>" : "";
      return `
        <tr>
          <td>${item.version || "-"}${latestTag}</td>
          <td>${item.deviceType || "-"}</td>
          <td>${item.fileName || "-"}</td>
          <td>${formatSize(item.fileSize || 0)}</td>
          <td>${formatDateTime(item.updatedAt || item.createdAt || "")}</td>
          <td>
            <button type="button" data-role="delete-firmware" data-id="${item.id}" class="warn">删除</button>
          </td>
        </tr>
      `;
    })
    .join("");

  firmwareListBodyEl.querySelectorAll("[data-role='delete-firmware']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const firmwareId = btn.dataset.id;
      const item = firmwareCache.find((row) => row.id === firmwareId);
      if (!firmwareId || !item) return;
      const ok = window.confirm(`确认删除固件 ${item.version || firmwareId} 吗？`);
      if (!ok) return;
      await execute("删除固件", () => request(`/firmware/${firmwareId}/delete`, { method: "POST" }));
      await loadFirmwares();
    });
  });
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

async function loadTfFiles() {
  const ownerId = byId("a-tf-owner")?.value || "";
  const category = byId("a-tf-category")?.value || "";
  const query = new URLSearchParams();
  if (ownerId) query.set("ownerId", ownerId);
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
          <td>${item.ownerId || "-"}</td>
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
  const fileInput = byId("a-tf-file");
  const category = byId("a-tf-category").value;
  const ownerId = byId("a-tf-owner").value;
  if (!fileInput?.files?.length) throw new Error("请先选择文件");
  const formData = new FormData();
  formData.append("file", fileInput.files[0]);
  formData.append("category", category);
  if (ownerId) formData.append("ownerId", ownerId);
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

async function createFirmware() {
  const fileInput = byId("a-fw-file");
  const version = byId("a-fw-version").value.trim();
  const deviceType = byId("a-fw-type").value.trim();
  const releaseNote = byId("a-fw-note").value.trim();
  if (!fileInput?.files?.length) throw new Error("请先选择固件文件");
  if (!version) throw new Error("请输入版本号");
  const formData = new FormData();
  formData.append("file", fileInput.files[0]);
  formData.append("version", version);
  formData.append("deviceType", deviceType || "ink-screen");
  formData.append("releaseNote", releaseNote);
  return await apiUpload("/firmware/upload", { token, formData });
}

async function batchUpgrade() {
  const latest = firmwareCache[0] || null;
  if (!latest?.id) throw new Error("暂无可用固件，请先上传固件");
  const scheduledAt = byId("a-upgrade-time")?.value;
  const clusterIds = (byId("a-upgrade-clusters")?.value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return await request("/firmware/batch-upgrade", {
    method: "POST",
    body: {
      firmwareId: latest.id,
      deviceIds: upgradeDeviceIds,
      clusterIds,
      scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : "",
    },
  });
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
  const view = byId("a-remote-view")?.value;
  if (!view) throw new Error("请选择界面");
  return await request("/remote/switch-view", {
    method: "POST",
    body: { deviceId: currentDevice.id, view, saveToTf: true },
  });
}

async function sendRemoteText() {
  ensureDevice();
  const text = byId("a-remote-text")?.value.trim();
  const durationRaw = byId("a-remote-duration")?.value;
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
      // ignore
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
on("a-login", "click", async () => {
  const username = byId("a-username").value.trim();
  const password = byId("a-password").value;
  if (!username || !password) {
    notifyError("请输入账号和密码");
    return;
  }
  try {
    const result = await apiRequest("/auth/admin/login", {
      method: "POST",
      body: { username, password },
    });
    token = result.data?.token || "";
    setStorage("admin_token", token);
    setAuthed(true);
    notifySuccess("登录成功");
    await loadOverview();
    await loadUserCache();
    await loadTemplates();
    await loadFirmwares();
  } catch (error) {
    print({ error: error.message || String(error) });
    notifyError(error.message || "登录失败");
  }
});

on("a-logout", "click", async () => {
  try {
    if (token) await apiRequest("/auth/logout", { method: "POST", token });
  } catch (_) {
    // ignore
  }
  token = "";
  setStorage("admin_token", "");
  setAuthed(false);
  notifyInfo("已退出登录");
});

on("a-quick-pick", "click", async () => {
  try {
    await pickDevice();
  } catch (error) {
    notifyError(error.message || "选择设备失败");
  }
});

on("a-overview-refresh", "click", async () => {
  await execute("刷新概览", () => loadOverview(), "概览已更新");
});

on("a-user-refresh", "click", async () => {
  await execute("刷新账号", () => loadUserCache());
});

on("a-user-create", "click", async () => {
  const username = byId("a-user-create-username").value.trim();
  const password = byId("a-user-create-password").value.trim();
  const role = byId("a-user-create-role").value;
  const nickname = byId("a-user-create-nickname").value.trim();
  await execute("创建账号", () =>
    request("/admin/users", { method: "POST", body: { username, password, role, nickname } })
  );
  await loadUserCache();
});

on("a-resource-apply", "click", async () => {
  const userId = byId("a-resource-user").value;
  const action = byId("a-resource-action").value;
  const targetUserId = byId("a-resource-target").value;
  await execute("资源处理", () =>
    request(`/admin/users/${userId}/resources`, { method: "POST", body: { action, targetUserId } })
  );
  await loadUserCache();
});

on("a-delete-device", "click", async () => {
  if (!currentDevice) return notifyError("请先选择设备");
  await execute("删除设备", () => request(`/devices/${currentDevice.id}/delete`, { method: "POST" }));
  setCurrentDevice(null);
});

on("a-update-device", "click", async () => {
  ensureDevice();
  const status = byId("a-device-status").value;
  const remark = byId("a-device-remark").value;
  const ownerId = byId("a-device-owner").value.trim();
  await execute("更新设备", () =>
    request(`/devices/${currentDevice.id}`, { method: "POST", body: { status, remark, ownerId } })
  );
});

on("a-bind-pin-btn", "click", async () => {
  const pin = byId("a-bind-pin").value.trim();
  const ownerId = byId("a-bind-user").value;
  if (!pin) return notifyError("请输入PIN码");
  await execute("管理员绑定", () => request("/devices/bind-pin", { method: "POST", body: { pin, ownerId } }));
});

on("a-todo-load", "click", async () => {
  await execute("加载TODO", () => loadTodoSheet());
});

on("a-todo-add", "click", () => {
  appendTodoRow({});
});

on("a-todo-save", "click", async () => {
  await execute("保存TODO", () => saveTodoSheet());
});

on("a-todo-reset", "click", async () => {
  await execute("回滚TODO", () => loadTodoSheet());
});

on("a-sch-load", "click", async () => {
  await execute("加载课程表", () => loadScheduleSheet());
});

on("a-sch-add", "click", () => {
  scheduleRowCount += 1;
  scheduleBodyEl.appendChild(createScheduleRow(scheduleRowCount, new Map()));
});

on("a-sch-remove", "click", () => {
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

on("a-sch-save", "click", async () => {
  await execute("保存课程表", () => saveScheduleSheet());
});

on("a-sch-reset", "click", async () => {
  await execute("回滚课程表", () => loadScheduleSheet());
});

on("a-sch-select-all", "change", (event) => {
  scheduleBodyEl.querySelectorAll(".row-selector").forEach((input) => {
    input.checked = event.target.checked;
  });
});

on("a-list-templates", "click", async () => {
  await execute("刷新模板", () => loadTemplates());
});

on("a-template-add", "click", () => {
  templatesCache.unshift({
    id: "",
    name: "新模板",
    slug: "",
    method: "GET",
    url: "",
    keyField: "key",
    keyIn: ["query"],
    keyConcatEnabled: false,
    keyConcatFields: [],
    keyConcatSeparator: "|",
    deviceKeyRequired: true,
    userInputFields: [],
    defaultParams: {},
    enabled: true,
    advancedConfig: {
      output: "",
      timeoutMs: 8000,
      steps: [
        {
          name: "step1",
          method: "GET",
          url: "",
          legacyCompat: false,
          passInputParams: false,
          headers: {},
          params: {},
          body: {},
          extract: [],
        },
      ],
    },
  });
  renderTemplates();
});

on("a-key-pick-device", "click", async () => {
  try {
    await pickKeyDevice();
    await loadKeyDeviceKeys();
  } catch (error) {
    notifyError(error.message || "选择设备失败");
  }
});

on("a-key-save", "click", async () => {
  await execute("保存模板Key", () => saveKeyDeviceKeys());
});

on("a-batch-pick-devices", "click", async () => {
  try {
    await pickBatchDevices();
  } catch (error) {
    notifyError(error.message || "选择设备失败");
  }
});

on("a-batch-apply", "click", async () => {
  const slug = byId("a-batch-template").value;
  const key = byId("a-batch-key").value.trim();
  const clusterIds = (byId("a-batch-clusters").value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!slug) return notifyError("请选择模板");
  if (!key) return notifyError("请输入Key");
  await execute("批量下发", () =>
    request("/devices/batch/config", {
      method: "POST",
      body: { deviceIds: batchKeyDeviceIds, clusterIds, keys: { [slug]: key } },
    })
  );
});

on("a-load-firmware", "click", async () => {
  await execute("刷新固件", () => loadFirmwares());
});

on("a-create-firmware", "click", async () => {
  await execute("新增固件", () => createFirmware());
  await loadFirmwares();
});

on("a-pick-upgrade-devices", "click", async () => {
  try {
    await pickUpgradeDevices();
  } catch (error) {
    notifyError(error.message || "选择设备失败");
  }
});

on("a-batch-upgrade", "click", async () => {
  await execute("批量升级", () => batchUpgrade());
});

on("a-tf-refresh", "click", async () => {
  await execute("刷新云端文件", () => loadTfFiles());
});

on("a-tf-local-refresh", "click", async () => {
  await execute("刷新本地文件", () => loadTfLocalFiles());
});

on("a-tf-upload", "click", async () => {
  await execute("上传文件", () => uploadTfFile());
  await loadTfFiles();
});

on("a-cast-image", "change", () => {
  const file = castImageInputEl?.files?.[0];
  if (!file || !castImagePreviewEl) return;
  const url = URL.createObjectURL(file);
  castImagePreviewEl.src = url;
  castImagePreviewEl.classList.remove("hidden");
  castImagePreviewEl.onload = () => URL.revokeObjectURL(url);
});

on("a-cast-image-send", "click", async () => {
  await execute("发送图片", () => sendRemoteImage());
});

on("a-cast-start", "click", async () => {
  try {
    await startCast();
    notifySuccess("开始投屏");
  } catch (error) {
    notifyError(error.message || "投屏失败");
  }
});

on("a-cast-stop", "click", () => {
  stopCast({ notifyDevice: true, reason: "manual_stop" });
  notifyInfo("已停止投屏");
});

on("a-remote-view-btn", "click", async () => {
  await execute("切换界面", () => switchRemoteView());
});

on("a-remote-text-btn", "click", async () => {
  await execute("发送文字", () => sendRemoteText());
});

on("a-log-ops", "click", async () => {
  await execute("查询操作日志", () => request("/logs/operations"));
});

on("a-log-api", "click", async () => {
  await execute("查询API日志", () => request("/logs/apis"));
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
  const collapsed = getStorage("admin_output_collapsed") === "1";
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
  loadUserCache().catch(() => {});
  loadTemplates().catch(() => {});
  loadFirmwares().catch(() => {});
} else {
  setAuthed(false);
}

setScriptStatus("已加载");
console.log(`admin.js ${VERSION} loaded`);


