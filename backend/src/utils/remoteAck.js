const createId = require("./id");

const MAX_REMOTE_ACK_ROWS = 8000;

function ensureRemoteAckStore(state) {
  if (!state || typeof state !== "object") return [];
  state.remoteCommandAcks = Array.isArray(state.remoteCommandAcks) ? state.remoteCommandAcks : [];
  return state.remoteCommandAcks;
}

function normalizeAckStatus(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return "success";
  if (["ok", "success", "done", "accepted"].includes(s)) return "success";
  if (["fail", "failed", "error", "reject", "rejected"].includes(s)) return "failed";
  if (["pending", "processing", "in_progress"].includes(s)) return "pending";
  return "success";
}

function createPendingAck(draft, { deviceId, eventType, source = "remote", operatorId = "", operatorRole = "", meta = {} }) {
  const now = new Date().toISOString();
  const list = ensureRemoteAckStore(draft);
  const commandId = createId("rcm");
  const row = {
    id: commandId,
    commandId,
    deviceId: String(deviceId || ""),
    eventType: String(eventType || ""),
    source: String(source || "remote"),
    status: "pending",
    ackStatus: "",
    ackMessage: "",
    ackPayload: {},
    operatorId: String(operatorId || ""),
    operatorRole: String(operatorRole || ""),
    meta: meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {},
    createdAt: now,
    updatedAt: now,
    ackedAt: "",
  };
  list.unshift(row);
  if (list.length > MAX_REMOTE_ACK_ROWS) {
    list.splice(MAX_REMOTE_ACK_ROWS);
  }
  return row;
}

function markRemoteAck(draft, { commandId, deviceId, eventType, status, message, payload }) {
  const list = ensureRemoteAckStore(draft);
  const cid = String(commandId || "").trim();
  const did = String(deviceId || "").trim();
  if (!cid || !did) return null;

  const row = list.find((item) => String(item.commandId || "") === cid && String(item.deviceId || "") === did);
  if (!row) return null;

  const now = new Date().toISOString();
  const ackStatus = normalizeAckStatus(status);
  row.eventType = row.eventType || String(eventType || "");
  row.status = ackStatus === "failed" ? "ack_failed" : ackStatus === "pending" ? "ack_pending" : "ack_success";
  row.ackStatus = ackStatus;
  row.ackMessage = String(message || "");
  row.ackPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  row.ackedAt = now;
  row.updatedAt = now;
  return row;
}

function buildAckView(row) {
  if (!row) {
    return { state: "pending", status: "pending", message: "" };
  }
  const status = String(row.ackStatus || "").trim().toLowerCase();
  if (status === "failed") {
    return { state: "failed", status: "failed", message: String(row.ackMessage || "") };
  }
  if (status === "success") {
    return { state: "success", status: "success", message: String(row.ackMessage || "") };
  }
  return { state: "pending", status: status || "pending", message: String(row.ackMessage || "") };
}

function collectAcksByCommandIds(db, commandIds) {
  const map = new Map();
  if (!db || !Array.isArray(db.remoteCommandAcks) || !Array.isArray(commandIds)) return map;
  const wanted = new Set(commandIds.map((x) => String(x || "").trim()).filter(Boolean));
  if (!wanted.size) return map;
  for (const row of db.remoteCommandAcks) {
    const cid = String(row?.commandId || "").trim();
    if (!cid || !wanted.has(cid) || map.has(cid)) continue;
    map.set(cid, buildAckView(row));
  }
  return map;
}

async function waitForAckMap({ readDB, commandIds, timeoutMs = 2800, pollIntervalMs = 120 }) {
  const ids = Array.isArray(commandIds) ? commandIds.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const wanted = new Set(ids);
  const resolved = new Map();
  if (!wanted.size) return resolved;

  const start = Date.now();
  while (true) {
    const db = await readDB();
    const partial = collectAcksByCommandIds(db, ids);
    for (const [cid, ack] of partial.entries()) {
      // Always refresh latest ack state so "pending -> success/failed" can be observed.
      resolved.set(cid, ack);
    }

    let allSettled = true;
    for (const cid of wanted.values()) {
      const ack = resolved.get(cid);
      if (!ack || ack.state === "pending") {
        allSettled = false;
        break;
      }
    }
    if (allSettled) break;

    if (Date.now() - start >= Math.max(0, Number(timeoutMs || 0))) break;
    await new Promise((resolve) => setTimeout(resolve, Math.max(60, Number(pollIntervalMs || 120))));
  }

  return resolved;
}

module.exports = {
  ensureRemoteAckStore,
  normalizeAckStatus,
  createPendingAck,
  markRemoteAck,
  buildAckView,
  collectAcksByCommandIds,
  waitForAckMap,
};
