const { EventEmitter } = require("events");
const createId = require("./id");

const emitter = new EventEmitter();
const historyByDevice = new Map();
const presenceByDevice = new Map();
const HISTORY_LIMIT = 200;
const TOUCH_TTL_MS = Math.max(30 * 1000, Number(process.env.DEVICE_PRESENCE_TOUCH_TTL_MS || 20 * 60 * 1000));

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
    presenceByDevice.set(id, {
      sse: 0,
      ws: 0,
      lastSeenAt: "",
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
  const row = ensurePresence(deviceId) || { sse: 0, ws: 0, lastSeenAt: "" };
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
  return [...(historyByDevice.get(deviceId) || [])];
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
};
