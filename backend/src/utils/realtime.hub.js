const { EventEmitter } = require("events");
const createId = require("./id");

const emitter = new EventEmitter();
emitter.setMaxListeners(Math.max(200, Number(process.env.REALTIME_MAX_LISTENERS || 1000)));
const historyByDevice = new Map();
const presenceByDevice = new Map();
const HISTORY_LIMIT = Math.max(1, Number(process.env.REALTIME_HISTORY_LIMIT || 200));
const HISTORY_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.REALTIME_HISTORY_TTL_MS || 6 * 60 * 60 * 1000)
);
const PRESENCE_RETENTION_MS = Math.max(
  60 * 1000,
  Number(process.env.REALTIME_PRESENCE_RETENTION_MS || 60 * 60 * 1000)
);
const MAX_TRACKED_DEVICES = Math.max(100, Number(process.env.REALTIME_MAX_TRACKED_DEVICES || 10000));
const SWEEP_INTERVAL_MS = Math.max(
  30 * 1000,
  Number(process.env.REALTIME_SWEEP_INTERVAL_MS || 5 * 60 * 1000)
);
const TOUCH_TTL_MS = Math.max(30 * 1000, Number(process.env.DEVICE_PRESENCE_TOUCH_TTL_MS || 20 * 60 * 1000));

function timestampOf(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function trimOldestDevices(map, maxSize = MAX_TRACKED_DEVICES) {
  if (map.size <= maxSize) return 0;
  const rows = [...map.entries()].sort((a, b) => {
    const aValue = Array.isArray(a[1]) ? a[1][a[1].length - 1]?.timestamp : a[1]?.lastSeenAt;
    const bValue = Array.isArray(b[1]) ? b[1][b[1].length - 1]?.timestamp : b[1]?.lastSeenAt;
    return timestampOf(aValue) - timestampOf(bValue);
  });
  const removeCount = Math.max(0, rows.length - maxSize);
  rows.slice(0, removeCount).forEach(([deviceId]) => map.delete(deviceId));
  return removeCount;
}

function pruneDeviceHistory(deviceId, now = Date.now()) {
  const id = String(deviceId || "").trim();
  if (!id) return 0;
  const current = historyByDevice.get(id);
  if (!Array.isArray(current) || !current.length) return 0;
  const historyCutoff = Number(now) - HISTORY_TTL_MS;
  const retained = current.filter((event) => timestampOf(event?.timestamp) >= historyCutoff);
  const removed = current.length - retained.length;
  if (!retained.length) historyByDevice.delete(id);
  else if (removed > 0) historyByDevice.set(id, retained);
  return removed;
}

function pruneRealtimeState(now = Date.now()) {
  let removedHistoryDevices = 0;
  let removedHistoryEvents = 0;
  let removedPresenceDevices = 0;

  historyByDevice.forEach((_events, deviceId) => {
    const removed = pruneDeviceHistory(deviceId, now);
    removedHistoryEvents += removed;
    if (!historyByDevice.has(deviceId)) removedHistoryDevices += 1;
  });

  presenceByDevice.forEach((row, deviceId) => {
    const activeConnections = Number(row?.sse || 0) > 0 || Number(row?.ws || 0) > 0;
    const touchActive = Number(row?.touchUntil || 0) > Number(now);
    const lastSeenAt = timestampOf(row?.lastSeenAt);
    if (!activeConnections && !touchActive && (!lastSeenAt || Number(now) - lastSeenAt >= PRESENCE_RETENTION_MS)) {
      presenceByDevice.delete(deviceId);
      removedPresenceDevices += 1;
    }
  });

  removedHistoryDevices += trimOldestDevices(historyByDevice);
  removedPresenceDevices += trimOldestDevices(presenceByDevice);
  return { removedHistoryDevices, removedHistoryEvents, removedPresenceDevices };
}

const sweepTimer = setInterval(() => {
  pruneRealtimeState();
}, SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === "function") sweepTimer.unref();

function createEvent({ type, deviceId, payload = {} }) {
  return {
    eventId: createId("evt"),
    type: String(type || "unknown"),
    deviceId: String(deviceId || ""),
    timestamp: new Date().toISOString(),
    payload,
  };
}

function saveHistory(event) {
  const deviceId = event.deviceId;
  if (!deviceId) return;
  const list = historyByDevice.get(deviceId) || [];
  list.push(event);
  if (list.length > HISTORY_LIMIT) {
    list.splice(0, list.length - HISTORY_LIMIT);
  }
  historyByDevice.set(deviceId, list);
  if (historyByDevice.size > MAX_TRACKED_DEVICES) trimOldestDevices(historyByDevice);
}

function normalizeChannel(channel) {
  const raw = String(channel || "").trim().toLowerCase();
  if (raw === "ws") return "ws";
  return "sse";
}

function ensurePresence(deviceId) {
  const id = String(deviceId || "").trim();
  if (!id) return null;
  if (!presenceByDevice.has(id)) {
    if (presenceByDevice.size >= MAX_TRACKED_DEVICES) {
      trimOldestDevices(presenceByDevice, Math.max(0, MAX_TRACKED_DEVICES - 1));
    }
    presenceByDevice.set(id, {
      sse: 0,
      ws: 0,
      lastSeenAt: new Date().toISOString(),
      touchUntil: 0,
    });
  }
  return presenceByDevice.get(id);
}

function markDeviceOnline(deviceId, channel = "sse") {
  const row = ensurePresence(deviceId);
  if (!row) return;
  const key = normalizeChannel(channel);
  row[key] = Number(row[key] || 0) + 1;
  row.lastSeenAt = new Date().toISOString();
}

function markDeviceOffline(deviceId, channel = "sse") {
  const row = ensurePresence(deviceId);
  if (!row) return;
  const key = normalizeChannel(channel);
  row[key] = Math.max(0, Number(row[key] || 0) - 1);
  row.lastSeenAt = new Date().toISOString();
}

function touchDevicePresence(deviceId, ttlMs = TOUCH_TTL_MS) {
  const row = ensurePresence(deviceId);
  if (!row) return;
  const ttl = Math.max(10 * 1000, Number(ttlMs || TOUCH_TTL_MS));
  row.touchUntil = Date.now() + ttl;
  row.lastSeenAt = new Date().toISOString();
}

function getDevicePresence(deviceId) {
  const id = String(deviceId || "").trim();
  const row = presenceByDevice.get(id) || { sse: 0, ws: 0, lastSeenAt: "", touchUntil: 0 };
  const sse = Number(row.sse || 0);
  const ws = Number(row.ws || 0);
  const touchActive = Number(row.touchUntil || 0) > Date.now();
  return {
    online: sse > 0 || ws > 0 || touchActive,
    channels: { sse, ws, touch: touchActive ? 1 : 0 },
    lastSeenAt: row.lastSeenAt || "",
  };
}

function publishDeviceEvent({ type, deviceId, payload = {} }) {
  const event = createEvent({ type, deviceId, payload });
  saveHistory(event);
  emitter.emit(`device:${event.deviceId}`, event);
  emitter.emit("device:*", event);
  return event;
}

function subscribeDevice(deviceId, handler) {
  const key = `device:${deviceId}`;
  emitter.on(key, handler);
  return () => emitter.off(key, handler);
}

function subscribeAll(handler) {
  emitter.on("device:*", handler);
  return () => emitter.off("device:*", handler);
}

function getDeviceHistory(deviceId) {
  pruneDeviceHistory(deviceId);
  return [...(historyByDevice.get(deviceId) || [])];
}

function getRealtimeRuntime() {
  let historyEvents = 0;
  historyByDevice.forEach((events) => {
    historyEvents += Array.isArray(events) ? events.length : 0;
  });
  return {
    historyDevices: historyByDevice.size,
    historyEvents,
    presenceDevices: presenceByDevice.size,
    limits: {
      historyPerDevice: HISTORY_LIMIT,
      historyTtlMs: HISTORY_TTL_MS,
      presenceRetentionMs: PRESENCE_RETENTION_MS,
      maxTrackedDevices: MAX_TRACKED_DEVICES,
    },
  };
}

function stopRealtimeSweeper() {
  clearInterval(sweepTimer);
}

module.exports = {
  publishDeviceEvent,
  subscribeDevice,
  subscribeAll,
  getDeviceHistory,
  markDeviceOnline,
  markDeviceOffline,
  touchDevicePresence,
  getDevicePresence,
  pruneRealtimeState,
  getRealtimeRuntime,
  stopRealtimeSweeper,
};
