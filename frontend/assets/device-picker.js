import { apiRequest } from "./common.js?v=20260227-3";

let modalRoot = null;

function createModalRoot() {
  if (modalRoot) return modalRoot;

  modalRoot = document.createElement("div");
  modalRoot.className = "device-picker hidden";
  modalRoot.innerHTML = `
    <div class="device-picker-backdrop" data-role="close"></div>
    <div class="device-picker-dialog">
      <div class="device-picker-header">
        <h3 id="dp-title">选择设备</h3>
        <button type="button" class="ghost" data-role="close">关闭</button>
      </div>
      <div class="device-picker-body">
        <input id="dp-search" placeholder="搜索设备ID / MAC / 备注" />
        <div id="dp-list" class="device-picker-list"></div>
      </div>
      <div class="device-picker-footer">
        <button type="button" class="ghost" id="dp-cancel">取消</button>
        <button type="button" id="dp-confirm">确定</button>
      </div>
    </div>
  `;

  document.body.appendChild(modalRoot);
  return modalRoot;
}

function filterDevices(devices, keyword) {
  const text = String(keyword || "").trim().toLowerCase();
  if (!text) return devices;
  return devices.filter((item) => {
    const source = `${item.id} ${item.mac} ${item.remark || ""}`.toLowerCase();
    return source.includes(text);
  });
}

export async function openDevicePicker({
  token,
  title = "选择设备",
  multiple = false,
  simulated,
  bound,
  selectedIds = [],
}) {
  const root = createModalRoot();
  const titleEl = root.querySelector("#dp-title");
  const searchEl = root.querySelector("#dp-search");
  const listEl = root.querySelector("#dp-list");
  const confirmEl = root.querySelector("#dp-confirm");
  const cancelEl = root.querySelector("#dp-cancel");
  const closeEls = root.querySelectorAll('[data-role="close"]');

  titleEl.textContent = title;
  searchEl.value = "";
  root.classList.remove("hidden");

  const query = new URLSearchParams();
  if (simulated === true) query.set("simulated", "true");
  if (simulated === false) query.set("simulated", "false");
  if (bound === true) query.set("bound", "true");
  if (bound === false) query.set("bound", "false");

  const result = await apiRequest(`/devices${query.toString() ? `?${query.toString()}` : ""}`, {
    token,
  });
  const allDevices = result.data || [];
  const selectedSet = new Set(selectedIds);

  function render() {
    const rows = filterDevices(allDevices, searchEl.value);
    if (rows.length === 0) {
      listEl.innerHTML = `<div class="tiny muted">没有匹配设备</div>`;
      return;
    }
    listEl.innerHTML = rows
      .map((item) => {
        const checked = selectedSet.has(item.id) ? "checked" : "";
        const inputType = multiple ? "checkbox" : "radio";
        return `
          <label class="device-picker-item">
            <input type="${inputType}" name="dp-item" value="${item.id}" ${checked} />
            <div>
              <strong>${item.id}</strong>
              <div class="tiny muted">MAC: ${item.mac}</div>
              <div class="tiny muted">备注: ${item.remark || "-"}</div>
              <div class="tiny muted">状态: ${item.status}</div>
            </div>
          </label>
        `;
      })
      .join("");

    listEl.querySelectorAll("input[name='dp-item']").forEach((input) => {
      input.addEventListener("change", () => {
        const id = input.value;
        if (multiple) {
          if (input.checked) selectedSet.add(id);
          else selectedSet.delete(id);
        } else {
          selectedSet.clear();
          if (input.checked) selectedSet.add(id);
        }
      });
    });
  }

  render();

  return await new Promise((resolve) => {
    let closed = false;
    function done(resultValue) {
      if (closed) return;
      closed = true;
      root.classList.add("hidden");
      searchEl.removeEventListener("input", render);
      confirmEl.removeEventListener("click", onConfirm);
      cancelEl.removeEventListener("click", onCancel);
      closeEls.forEach((el) => el.removeEventListener("click", onCancel));
      resolve(resultValue);
    }
    function onConfirm() {
      const ids = [...selectedSet];
      const devices = allDevices.filter((item) => ids.includes(item.id));
      done({ ids, devices });
    }
    function onCancel() {
      done({ ids: [], devices: [] });
    }
    searchEl.addEventListener("input", render);
    confirmEl.addEventListener("click", onConfirm);
    cancelEl.addEventListener("click", onCancel);
    closeEls.forEach((el) => el.addEventListener("click", onCancel));
  });
}


