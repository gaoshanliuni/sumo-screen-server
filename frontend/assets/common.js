export const API_BASE = "/api";

export function byId(id) {
  return document.getElementById(id);
}

export function parseJsonSafe(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

export function toast(el, payload) {
  if (!el) return;
  el.textContent = JSON.stringify(payload, null, 2);
}

let noticeRoot = null;

function ensureNoticeRoot() {
  if (noticeRoot) return noticeRoot;
  noticeRoot = document.createElement("div");
  noticeRoot.className = "notify-root";
  document.body.appendChild(noticeRoot);
  return noticeRoot;
}

export function notify(message, type = "info", timeoutMs = 2500) {
  const root = ensureNoticeRoot();
  const item = document.createElement("div");
  item.className = `notify-item notify-${type}`;
  item.textContent = String(message || "");
  root.appendChild(item);

  requestAnimationFrame(() => {
    item.classList.add("show");
  });

  const dispose = () => {
    item.classList.remove("show");
    setTimeout(() => {
      if (item.parentNode === root) root.removeChild(item);
    }, 180);
  };

  const timer = setTimeout(dispose, timeoutMs);
  item.addEventListener("click", () => {
    clearTimeout(timer);
    dispose();
  });
}

export function notifySuccess(message) {
  notify(message, "success");
}

export function notifyError(message) {
  notify(message, "error", 3200);
}

export function notifyInfo(message) {
  notify(message, "info");
}

export async function runAction(actionName, action, { outputEl, successMessage } = {}) {
  try {
    const result = await action();
    if (outputEl) toast(outputEl, result);
    if (successMessage) notifySuccess(successMessage);
    return result;
  } catch (error) {
    const message = error?.message || String(error);
    if (outputEl) toast(outputEl, { error: message });
    notifyError(`${actionName}失败：${message}`);
    throw error;
  }
}

export async function apiRequest(path, { method = "GET", token = "", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const json = parseJsonSafe(text);
  if (!response.ok) {
    const error = new Error(json.msg || json.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.payload = json;
    throw error;
  }
  return json;
}

export async function apiUpload(path, { token = "", formData } = {}) {
  if (!formData) throw new Error("formData 不能为空");
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: formData,
  });

  const text = await response.text();
  const json = parseJsonSafe(text);
  if (!response.ok) {
    const error = new Error(json.msg || json.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.payload = json;
    throw error;
  }
  return json;
}

export function setStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    // ignore storage errors
  }
}

export function getStorage(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch (_) {
    return "";
  }
}

export function makeDraggable(panelEl, handleEl) {
  if (!panelEl || !handleEl) return;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let dragging = false;

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true;
    const rect = panelEl.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    startX = event.clientX;
    startY = event.clientY;
    panelEl.style.left = `${startLeft}px`;
    panelEl.style.top = `${startTop}px`;
    panelEl.style.right = "auto";
    panelEl.style.bottom = "auto";
    handleEl.classList.add("dragging");
    event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    const nextLeft = startLeft + dx;
    const nextTop = startTop + dy;
    const maxLeft = window.innerWidth - panelEl.offsetWidth - 8;
    const maxTop = window.innerHeight - panelEl.offsetHeight - 8;
    const clampedLeft = Math.min(Math.max(nextLeft, 8), Math.max(maxLeft, 8));
    const clampedTop = Math.min(Math.max(nextTop, 8), Math.max(maxTop, 8));
    panelEl.style.left = `${clampedLeft}px`;
    panelEl.style.top = `${clampedTop}px`;
  };

  const onPointerUp = () => {
    if (!dragging) return;
    dragging = false;
    handleEl.classList.remove("dragging");
  };

  handleEl.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

export function makeResizable(panelEl, { minWidth = 260, minHeight = 180 } = {}) {
  if (!panelEl) return;
  panelEl.style.resize = "both";
  panelEl.style.overflow = "auto";
  panelEl.style.minWidth = `${minWidth}px`;
  panelEl.style.minHeight = `${minHeight}px`;
}
