const { decryptSecret } = require("./ai/credential_crypto.service");

const REMOTE_REPLAY_MAX_AGE_MS = 45000;
const E6_PACKED4_IMAGE_SIZE = 800 * 480 / 2;

const DIRECT_DEVICE_EVENT_TYPES = new Set([
  "collection.push",
  "e6.collection_push",
  "display.set",
  "display.set_boot_mode",
]);

const NVS_EVENT_TYPES = new Set([
  "nvs.write",
  "nvs.write_entries",
]);

function text(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function payloadOf(event = {}) {
  return isObject(event.payload) ? event.payload : {};
}

function commandIdOf(event = {}) {
  const payload = payloadOf(event);
  return text(payload.commandId || payload.command_id || event.commandId || event.command_id || event.eventId);
}

function shouldSkipHistoryReplay(event) {
  const t = text(event?.type);
  if (t.startsWith("homepage.") || t.startsWith("badgepage.") || t.startsWith("weatherpage.")) {
    return true;
  }
  if (t.startsWith("remote.")) {
    const ts = Date.parse(text(event?.timestamp));
    if (!Number.isFinite(ts)) return true;
    return Date.now() - ts > REMOTE_REPLAY_MAX_AGE_MS;
  }
  return false;
}

function shouldSkipCommandPoll(event) {
  const t = text(event?.type);
  if (!t.startsWith("remote.")) return false;
  const ts = Date.parse(text(event?.timestamp));
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > REMOTE_REPLAY_MAX_AGE_MS;
}

function imageFromPagePayload(event = {}) {
  const payload = payloadOf(event);
  const image = isObject(payload.image) ? payload.image : payload;
  const format = text(image.format || payload.format).toLowerCase();
  if (format && format !== "e6p4") return null;

  const imageId = text(
    image.image_id ||
      image.imageId ||
      image.id ||
      payload.imageId ||
      payload.image_id ||
      payload.image_key
  );
  const imageUrl = text(
    image.image_url ||
      image.imageUrl ||
      image.url ||
      payload.imageUrl ||
      payload.image_url
  );
  const width = Number(image.image_width || image.width || payload.width || payload.image_width || 0);
  const height = Number(image.image_height || image.height || payload.height || payload.image_height || 0);
  const size = Number(image.size || image.bytes || payload.size || payload.bytes || E6_PACKED4_IMAGE_SIZE);

  if (!imageId || !imageUrl || size <= 0) return null;
  return {
    image_id: imageId,
    id: imageId,
    url: imageUrl,
    image_url: imageUrl,
    size,
    bytes: size,
    format: "e6p4",
    width,
    height,
    etag: text(image.etag || payload.etag),
  };
}

function pageEventToPushImagesCommand(event = {}) {
  const type = text(event.type);
  if (!(type === "homepage.image.updated" || type === "homepage.updated")) return null;
  const image = imageFromPagePayload(event);
  if (!image) return null;
  const commandId = commandIdOf(event);
  return {
    id: commandId,
    command_id: commandId,
    type: "push_images",
    payload: {
      commandId,
      image,
      images: [image],
      sourceEventId: text(event.eventId),
      sourceEventType: type,
    },
    timestamp: text(event.timestamp),
  };
}

function nvsItemsToUpdateConfigPayload(event = {}) {
  const payload = payloadOf(event);
  const items = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.entries)
      ? payload.entries
      : [];
  const configPayload = {
    commandId: commandIdOf(event),
    sourceEventId: text(event.eventId),
    sourceEventType: text(event.type),
    reboot: Boolean(payload.reboot),
  };
  const keyMap = {
    wifi_ssid: "wifi_ssid",
    ssid: "wifi_ssid",
    wifi_password: "wifi_password",
    password: "wifi_password",
    server_url: "server_url",
    backend_url: "server_url",
    lan_server_url: "lan_server_url",
    local_server_url: "lan_server_url",
    wan_server_url: "wan_server_url",
    public_server_url: "wan_server_url",
    active_server_profile: "active_server_profile",
    display_mode: "display_mode",
    boot_mode: "boot_mode",
    album_collection_id: "album_collection_id",
    homepage_id: "homepage_id",
    firmware_channel: "firmware_channel",
    device_id: "device_id",
    device_token: "device_token",
    poll_interval_seconds: "poll_interval_seconds",
    poll_interval: "poll_interval_seconds",
  };

  items.forEach((item) => {
    if (!isObject(item)) return;
    const mappedKey = keyMap[text(item.key)];
    if (!mappedKey) return;
    let value = item.value !== undefined ? item.value : item.secretValue;
    if ((value === undefined || value === null) && item.encryptedValue) {
      value = decryptSecret(item.encryptedValue);
    }
    if (value === undefined || value === null) return;
    configPayload[mappedKey] = value;
  });

  return configPayload;
}

function nvsEventToUpdateConfigCommand(event = {}) {
  if (!NVS_EVENT_TYPES.has(text(event.type))) return null;
  const payload = nvsItemsToUpdateConfigPayload(event);
  const usefulKeys = Object.keys(payload).filter((key) => !["commandId", "sourceEventId", "sourceEventType", "reboot"].includes(key));
  if (!usefulKeys.length) return null;
  const commandId = commandIdOf(event);
  return {
    id: commandId,
    command_id: commandId,
    type: "update_config",
    payload,
    timestamp: text(event.timestamp),
  };
}

function directEventToDeviceCommand(event = {}) {
  const type = text(event.type);
  if (type === "remote.ack" || type === "device.status" || type === "tf.reported") {
    return null;
  }
  if (!DIRECT_DEVICE_EVENT_TYPES.has(type) && !type.startsWith("remote.") && !type.startsWith("firmware.") && !type.startsWith("tf.")) {
    return null;
  }
  const commandId = commandIdOf(event);
  return {
    id: commandId,
    command_id: commandId,
    type,
    payload: payloadOf(event),
    timestamp: text(event.timestamp),
  };
}

function eventToDeviceCommand(event = {}) {
  return pageEventToPushImagesCommand(event) || nvsEventToUpdateConfigCommand(event) || directEventToDeviceCommand(event);
}

function pendingAckToDeviceCommand(row = {}) {
  const status = text(row.status || "pending");
  const ackStatus = text(row.ackStatus);
  if (!["pending", "ack_pending"].includes(status) || (ackStatus && ackStatus !== "pending")) {
    return null;
  }
  const meta = isObject(row.meta) ? row.meta : {};
  const payload = isObject(meta.commandPayload) ? { ...meta.commandPayload } : {};
  const commandId = text(row.commandId || row.id);
  const type = text(row.eventType || payload.type);
  if (!commandId || !type || !Object.keys(payload).length) return null;
  payload.commandId = text(payload.commandId || commandId);
  return {
    id: commandId,
    command_id: commandId,
    type,
    payload,
    timestamp: text(row.createdAt || row.updatedAt),
    persisted: true,
  };
}

function isDeviceCommandEvent(event = {}) {
  return Boolean(eventToDeviceCommand(event));
}

function eventMatchesCursor(event = {}, cursor = "") {
  const value = text(cursor);
  if (!value) return false;
  if (text(event.eventId) === value) return true;
  const command = eventToDeviceCommand(event);
  return text(command?.command_id) === value || text(command?.id) === value;
}

function sanitizeDeviceEventForRealtime(event = {}) {
  const clone = JSON.parse(JSON.stringify(event || {}));
  const payload = isObject(clone.payload) ? clone.payload : null;
  if (!payload || !NVS_EVENT_TYPES.has(text(clone.type))) return clone;

  const sanitizeItems = (items) => {
    if (!Array.isArray(items)) return items;
    return items.map((item) => {
      if (!isObject(item) || !item.secret) return item;
      const next = { ...item };
      delete next.value;
      delete next.secretValue;
      delete next.encryptedValue;
      next.value = "********";
      next.redacted = true;
      return next;
    });
  };

  payload.items = sanitizeItems(payload.items);
  payload.entries = sanitizeItems(payload.entries);
  return clone;
}

module.exports = {
  E6_PACKED4_IMAGE_SIZE,
  eventMatchesCursor,
  eventToDeviceCommand,
  isDeviceCommandEvent,
  pendingAckToDeviceCommand,
  sanitizeDeviceEventForRealtime,
  shouldSkipCommandPoll,
  shouldSkipHistoryReplay,
};
