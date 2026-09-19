const { WebSocketServer } = require("ws");
const { verifyToken } = require("./utils/jwt");
const { readDB } = require("./db/store");
const { ensureDeviceAccess } = require("./utils/access");
const { subscribeDevice, getDeviceHistory, markDeviceOnline, markDeviceOffline } = require("./utils/realtime.hub");
const { resolveRequestOrigin } = require("./utils/origin");
const { sanitizeDeviceEventForRealtime } = require("./services/hardware_command_bridge.service");

const REMOTE_REPLAY_MAX_AGE_MS = 45000;
const WS_MAX_PAYLOAD_BYTES = Math.max(1024, Number(process.env.WS_MAX_PAYLOAD_BYTES || 1024 * 1024));
const WS_MAX_BUFFERED_BYTES = Math.max(64 * 1024, Number(process.env.WS_MAX_BUFFERED_BYTES || 2 * 1024 * 1024));
const WS_HEARTBEAT_INTERVAL_MS = Math.max(10000, Number(process.env.WS_HEARTBEAT_INTERVAL_MS || 30000));

function shouldSkipHistoryReplay(event) {
  const t = String(event?.type || "");
  if (t.startsWith("homepage.") || t.startsWith("badgepage.") || t.startsWith("weatherpage.")) {
    return true;
  }
  if (t.startsWith("remote.")) {
    const ts = Date.parse(String(event?.timestamp || ""));
    if (!Number.isFinite(ts)) return true;
    return Date.now() - ts > REMOTE_REPLAY_MAX_AGE_MS;
  }
  return false;
}

function safeSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return false;
  if (Number(ws.bufferedAmount || 0) > WS_MAX_BUFFERED_BYTES) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

function closeSocket(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch (_) {
    // Ignore close errors.
  }
}

function setupWebSocketServer(httpServer) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (_) {
        ws.terminate();
      }
    });
  }, WS_HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  wss.once("close", () => clearInterval(heartbeatTimer));

  httpServer.on("upgrade", (req, socket, head) => {
    const baseOrigin = resolveRequestOrigin(req);
    const url = new URL(req.url, baseOrigin);
    if (url.pathname !== "/ws/hardware") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, url);
    });
  });

  wss.on("connection", async (ws, req, url) => {
    let unsubscribe = () => {};
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    try {
      const token = url.searchParams.get("token") || "";
      const deviceId = url.searchParams.get("deviceId") || "";
      if (!token || !deviceId) {
        closeSocket(ws, 1008, "token_or_deviceId_missing");
        return;
      }

      const auth = verifyToken(token);
      const db = await readDB();
      ensureDeviceAccess(db, auth, deviceId);
      markDeviceOnline(deviceId, "ws");

      safeSend(ws, {
        channel: "ws",
        type: "ready",
        deviceId,
        authRole: auth.role,
        timestamp: new Date().toISOString(),
      });

      const history = getDeviceHistory(deviceId);
      history.forEach((event) => {
        if (shouldSkipHistoryReplay(event)) return;
        safeSend(ws, { channel: "ws", type: "device-event", event: sanitizeDeviceEventForRealtime(event) });
      });

      unsubscribe = subscribeDevice(deviceId, (event) => {
        safeSend(ws, { channel: "ws", type: "device-event", event: sanitizeDeviceEventForRealtime(event) });
      });

      ws.on("message", () => {
        safeSend(ws, { channel: "ws", type: "pong", time: new Date().toISOString() });
      });
    } catch (error) {
      safeSend(ws, { channel: "ws", type: "error", message: error.message || "forbidden" });
      closeSocket(ws, 1008, "forbidden");
      return;
    }

    ws.on("close", () => {
      unsubscribe();
      try {
        const deviceId = url.searchParams.get("deviceId") || "";
        if (deviceId) markDeviceOffline(deviceId, "ws");
      } catch (_) {
        // ignore
      }
    });
  });

  return wss;
}

module.exports = setupWebSocketServer;
