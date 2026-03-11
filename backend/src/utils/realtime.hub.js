const { EventEmitter } = require("events");
const createId = require("./id");

const emitter = new EventEmitter();
const historyByDevice = new Map();
const HISTORY_LIMIT = 200;

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
};
