const { paginateRows } = require("./pagination");

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isDeviceOnline(device = {}, options = {}) {
  if (typeof options.presenceResolver === "function") {
    const presence = options.presenceResolver(device.id || device.deviceId || "");
    if (presence && typeof presence === "object") return Boolean(presence.online);
  }
  return Boolean(device.online || device.isOnline);
}

function getVisibleDevices(state = {}, auth = {}) {
  const devices = Array.isArray(state.devices) ? state.devices : [];
  if (auth.role === "admin") return devices;
  if (auth.role === "device") {
    return devices.filter((item) => String(item.id || "") === String(auth.deviceId || ""));
  }
  return devices.filter((item) => String(item.ownerId || "") === String(auth.userId || ""));
}

function buildClusterMap(state = {}) {
  const map = new Map();
  (state.clusters || []).forEach((cluster) => {
    (cluster.deviceIds || []).forEach((deviceId) => {
      if (!map.has(deviceId)) map.set(deviceId, []);
      map.get(deviceId).push({ id: cluster.id, name: cluster.name || "" });
    });
  });
  return map;
}

function buildUserMap(state = {}) {
  return new Map((state.users || []).map((user) => [String(user.id || ""), user]));
}

function decorateDevice(device = {}, state = {}, options = {}) {
  const clusterMap = options.clusterMap || buildClusterMap(state);
  const userMap = options.userMap || buildUserMap(state);
  const owner = userMap.get(String(device.ownerId || "")) || {};
  const clusters = clusterMap.get(device.id) || [];
  return {
    ...device,
    clusterIds: clusters.map((item) => item.id),
    clusterNames: clusters.map((item) => item.name).filter(Boolean),
    ownerUsername: owner.username || "",
    ownerNickname: owner.nickname || "",
    online: isDeviceOnline(device, options),
  };
}

function matchesKeyword(row = {}, keyword = "") {
  const text = normalizeText(keyword);
  if (!text) return true;
  const merged = [
    row.id,
    row.deviceId,
    row.mac,
    row.displayName,
    row.name,
    row.remark,
    row.type,
    row.deviceTypeName,
    row.ownerId,
    row.ownerUsername,
    row.ownerNickname,
    ...(row.clusterNames || []),
    row.online ? "online 在线" : "offline 离线",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return merged.includes(text);
}

function sortDevices(rows, options = {}) {
  const orderBy = String(options.orderBy || "updatedAt");
  const order = String(options.order || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const sorted = [...rows];
  sorted.sort((a, b) => {
    let av = a[orderBy] || "";
    let bv = b[orderBy] || "";
    if (orderBy === "updatedAt" || orderBy === "createdAt" || orderBy === "lastSeenAt") {
      av = Date.parse(av || "") || 0;
      bv = Date.parse(bv || "") || 0;
      return order === "asc" ? av - bv : bv - av;
    }
    av = String(av || "");
    bv = String(bv || "");
    return order === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
  });
  return sorted;
}

function listDevicesFromState(state = {}, options = {}) {
  const auth = options.auth || {};
  const clusterMap = buildClusterMap(state);
  const userMap = buildUserMap(state);
  let rows = getVisibleDevices(state, auth).map((device) =>
    decorateDevice(device, state, { ...options, clusterMap, userMap })
  );

  const status = String(options.status || "").trim().toLowerCase();
  if (status === "online") rows = rows.filter((item) => item.online);
  else if (status === "offline") rows = rows.filter((item) => !item.online && item.bindState === "bound");
  else if (status === "pending") rows = rows.filter((item) => item.bindState !== "bound");
  else if (status) rows = rows.filter((item) => String(item.status || "").toLowerCase() === status);

  if (options.online !== undefined && options.online !== "") {
    const expected = String(options.online) === "true" || options.online === true;
    rows = rows.filter((item) => item.online === expected);
  }
  if (options.bound !== undefined && options.bound !== "") {
    const value = String(options.bound || "").toLowerCase();
    if (value === "true" || value === "bound") rows = rows.filter((item) => item.bindState === "bound");
    if (value === "false" || value === "pending" || value === "unbound") {
      rows = rows.filter((item) => item.bindState !== "bound");
    }
  }
  if (options.ownerId && auth.role === "admin") {
    rows = rows.filter((item) => String(item.ownerId || "") === String(options.ownerId || ""));
  }
  if (options.mac) {
    const mac = String(options.mac || "").toUpperCase();
    rows = rows.filter((item) => String(item.mac || "").toUpperCase().includes(mac));
  }
  if (options.simulated !== undefined && options.simulated !== "") {
    const expected = String(options.simulated) === "true" || options.simulated === true;
    rows = rows.filter((item) => Boolean(item.simulated) === expected);
  }
  if (options.keyword) rows = rows.filter((item) => matchesKeyword(item, options.keyword));

  rows = sortDevices(rows, options);
  return paginateRows(rows, options);
}

function summarizeDevicesFromState(state = {}, auth = {}, options = {}) {
  const devices = getVisibleDevices(state, auth).map((device) => decorateDevice(device, state, options));
  const totalDevices = devices.length;
  const pendingBindDevices = devices.filter((item) => item.bindState !== "bound").length;
  const onlineDevices = devices.filter((item) => item.bindState === "bound" && item.online).length;
  const offlineDevices = devices.filter((item) => item.bindState === "bound" && !item.online).length;
  return {
    totalDevices,
    onlineDevices,
    offlineDevices,
    pendingBindDevices,
  };
}

function findDeviceFromState(state = {}, auth = {}, deviceId = "") {
  const safeId = String(deviceId || "").trim();
  return getVisibleDevices(state, auth).find((item) => String(item.id || "") === safeId || String(item.deviceId || "") === safeId) || null;
}

function findDeviceByKeyword(state = {}, auth = {}, keyword = "") {
  const text = normalizeText(keyword);
  if (!text) return null;
  const page = listDevicesFromState(state, { auth, keyword: text, page: 1, pageSize: 5 });
  return page.rows[0] || null;
}

module.exports = {
  decorateDevice,
  findDeviceByKeyword,
  findDeviceFromState,
  getVisibleDevices,
  isDeviceOnline,
  listDevicesFromState,
  summarizeDevicesFromState,
};
