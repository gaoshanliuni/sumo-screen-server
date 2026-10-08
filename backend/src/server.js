require("dotenv").config();
const http = require("http");
const app = require("./app");
const config = require("./config");
const { initStore, closeStore } = require("./db/store");
const setupWebSocketServer = require("./ws");
const { startXiqueScheduler, stopXiqueScheduler } = require("./services/xique_scheduler.service");
const {
  startHomepageAutoPushScheduler,
  stopHomepageAutoPushScheduler,
} = require("./services/homepage_auto_push.service");
const {
  startApiTemplateRefreshScheduler,
  stopApiTemplateRefreshScheduler,
} = require("./services/api_template_refresh_scheduler.service");
const { startTaskPlanScheduler, stopTaskPlanScheduler } = require("./services/task_plan.service");
const {
  startTfFileCleanupScheduler,
  stopTfFileCleanupScheduler,
} = require("./services/tf_file_cleanup.service");
const { warmupOcrRuntime } = require("./services/captcha_ocr.service");
const { normalizeOrigin } = require("./utils/origin");
const { closeMongoClient } = require("./utils/mongo");
const { getCache } = require("./cache/redis");
const { stopRealtimeSweeper } = require("./utils/realtime.hub");

function isListenRecoverable(error) {
  return error?.code === "EACCES" || error?.code === "EADDRINUSE";
}

function buildPortCandidates(env = process.env) {
  const configuredPort = Number(env.PORT || config.port || 8890);
  const basePort = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
    ? configuredPort
    : 8890;
  if (String(env.PORT_FALLBACK_ENABLED || "0") !== "1") return [basePort];
  const candidates = [basePort];
  for (let offset = 1; offset <= 10; offset += 1) {
    if (basePort + offset <= 65535) candidates.push(basePort + offset);
  }
  [9000, 9999, 18080, 28080, 38080].forEach((port) => {
    if (!candidates.includes(port)) candidates.push(port);
  });
  return candidates;
}

function listenOnPort(server, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, config.listenHost, () => {
      cleanup();
      resolve(port);
    });
  });
}

async function listenWithFallback(server, env = process.env) {
  const candidates = buildPortCandidates(env);
  let lastError = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const port = candidates[index];
    try {
      // eslint-disable-next-line no-await-in-loop
      return await listenOnPort(server, port);
    } catch (error) {
      lastError = error;
      if (!isListenRecoverable(error) || port === candidates[candidates.length - 1]) {
        throw error;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `Listen ${config.listenHost}:${port} failed (${error.code}); trying ${config.listenHost}:${candidates[index + 1]}`
      );
    }
  }
  throw lastError || new Error("listen failed");
}

function validateProductionConfig(env = process.env) {
  const issues = [];
  const defaultJwtSecret = "ink-screen-super-secret-change-me";
  const resolvedJwtSecret = String(env.JWT_SECRET || config.jwtSecret || "").trim();
  if (!String(env.JWT_SECRET || "").trim() || resolvedJwtSecret === defaultJwtSecret) {
    issues.push("JWT_SECRET must be explicitly configured");
  }
  const requiredDbKeys = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"];
  const missingDbKeys = requiredDbKeys.filter((key) => !String(env[key] || "").trim());
  if (missingDbKeys.length) {
    issues.push(`database environment variables missing: ${missingDbKeys.join(", ")}`);
  }
  const resolvedDb = {
    host: String(env.DB_HOST || config.mysql.host || ""),
    user: String(env.DB_USER || config.mysql.user || ""),
    password: String(env.DB_PASSWORD || config.mysql.password || ""),
    database: String(env.DB_NAME || config.mysql.database || ""),
  };
  const usesBundledDbDefaults =
    resolvedDb.host === "gaoshanliuni.top" &&
    resolvedDb.user === "gly" &&
    resolvedDb.password === "XiBk2QSddRheG2Ya" &&
    resolvedDb.database === "shuimoping";
  if (usesBundledDbDefaults) issues.push("bundled default database connection is not allowed");

  if (issues.length && String(env.NODE_ENV || "development").toLowerCase() === "production") {
    throw new Error(`Production configuration invalid: ${issues.join("; ")}`);
  }
  if (issues.length) {
    // eslint-disable-next-line no-console
    console.warn(`[config] development defaults detected: ${issues.join("; ")}`);
  }
  return { valid: issues.length === 0, issues };
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.close(() => resolve());
  });
}

function closeWebSocketServer(wss) {
  return new Promise((resolve) => {
    if (!wss || typeof wss.close !== "function") return resolve();
    try {
      wss.clients?.forEach((socket) => {
        try {
          socket.close(1001, "server_shutdown");
        } catch (_) {
          // Ignore individual socket close errors.
        }
      });
      wss.close(() => resolve());
    } catch (_) {
      resolve();
    }
  });
}

function createShutdownHandler({ server, wss, exit = (code) => process.exit(code) }) {
  let shutdownPromise = null;
  return function shutdown(signal = "shutdown", exitCode = 0) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      // eslint-disable-next-line no-console
      console.info(`[server] graceful shutdown started signal=${signal}`);
      app.locals.runtime.storeReady = false;
      app.locals.runtime.listening = false;
      stopXiqueScheduler();
      stopHomepageAutoPushScheduler();
      stopApiTemplateRefreshScheduler();
      stopTaskPlanScheduler();
      stopTfFileCleanupScheduler();
      stopRealtimeSweeper();

      const requestedGraceMs = Number(process.env.SHUTDOWN_GRACE_MS || 10000);
      const shutdownGraceMs = Number.isFinite(requestedGraceMs)
        ? Math.max(1000, requestedGraceMs)
        : 10000;
      const forceTimer = setTimeout(() => {
        try {
          wss?.clients?.forEach((socket) => socket.terminate?.());
          server?.closeAllConnections?.();
        } catch (_) {
          // Ignore forced connection close errors.
        }
      }, shutdownGraceMs);
      if (typeof forceTimer.unref === "function") forceTimer.unref();

      // Stop accepting work and drain active HTTP/WS requests before closing
      // the storage clients those requests may still be using.
      await Promise.allSettled([
        closeWebSocketServer(wss),
        closeServer(server),
      ]);
      const closeTasks = [
        ["store", () => closeStore()],
        ["mongo", () => closeMongoClient()],
        ["redis", () => Promise.resolve().then(() => getCache().close?.())],
      ];
      const closeResults = await Promise.allSettled(closeTasks.map(([, close]) => close()));
      closeResults.forEach((result, index) => {
        if (result.status !== "rejected") return;
        // Shutdown must continue, but persistence/driver failures must remain
        // visible to operators instead of being silently discarded.
        // eslint-disable-next-line no-console
        console.error(
          `[server] graceful shutdown resource=${closeTasks[index][0]} failed:`,
          result.reason
        );
      });
      clearTimeout(forceTimer);
      // eslint-disable-next-line no-console
      console.info("[server] graceful shutdown complete");
      exit(exitCode);
    })();
    return shutdownPromise;
  };
}

async function bootstrap() {
  validateProductionConfig();
  await initStore();
  app.locals.runtime.storeReady = true;
  const server = http.createServer(app);
  server.keepAliveTimeout = Math.max(5000, Number(config.httpKeepAliveTimeoutMs || 65000));
  server.headersTimeout = Math.max(server.keepAliveTimeout + 1000, Number(config.httpHeadersTimeoutMs || 66000));
  const wss = setupWebSocketServer(server);
  const actualPort = await listenWithFallback(server);
  app.locals.runtime.listening = true;
  app.locals.runtime.port = actualPort;
  const shutdown = createShutdownHandler({ server, wss });
  process.once("SIGINT", () => shutdown("SIGINT", 0));
  process.once("SIGTERM", () => shutdown("SIGTERM", 0));
  server.on("error", (error) => {
    const message = String(error?.message || error);
    if (isListenRecoverable(error)) {
      // eslint-disable-next-line no-console
      console.error(
        `Server listen failed on ${config.listenHost}:${actualPort}: ${message}. ` +
          "Set LISTEN_HOST=127.0.0.1 or change PORT if this address is unavailable."
      );
      process.exit(1);
      return;
    }
    // eslint-disable-next-line no-console
    console.error("Server error:", error);
    process.exit(1);
  });
  startXiqueScheduler();
  startHomepageAutoPushScheduler();
  startApiTemplateRefreshScheduler();
  startTaskPlanScheduler();
  startTfFileCleanupScheduler();
  const localOrigin = `http://localhost:${actualPort}`;
  const publicOrigin = normalizeOrigin(config.publicOrigin);
  const effectiveOrigin = publicOrigin || localOrigin;
  const wsPublic = effectiveOrigin.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  // eslint-disable-next-line no-console
  console.log(`Server running at ${localOrigin} (listen ${config.listenHost}:${actualPort})`);
  // eslint-disable-next-line no-console
  console.log(`WebSocket endpoint: ${wsPublic}/ws/hardware`);
  if (publicOrigin) {
    // eslint-disable-next-line no-console
    console.log(`Public origin: ${publicOrigin}`);
  } else {
    // eslint-disable-next-line no-console
    console.log("Public origin not set. Set PUBLIC_ORIGIN=https://your-domain for HTTPS/WSS reverse proxy.");
  }
  warmupOcrRuntime()
    .then((state) => {
      // eslint-disable-next-line no-console
      console.log(`[xique-ocr] ready=${state.ready} reason=${state.reason || "ok"} interpreter=${state.interpreter || "-"}`);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(`[xique-ocr] warmup failed: ${error?.message || error}`);
    });
  return { server, wss, actualPort, shutdown };
}

if (require.main === module) {
  bootstrap().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Bootstrap failed:", error);
    process.exit(1);
  });
}

module.exports = {
  bootstrap,
  buildPortCandidates,
  isListenRecoverable,
  listenOnPort,
  listenWithFallback,
  validateProductionConfig,
  createShutdownHandler,
};
