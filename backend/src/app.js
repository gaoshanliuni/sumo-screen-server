const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const responseMiddleware = require("./middleware/response");
const errorMiddleware = require("./middleware/error");
const { authRequired } = require("./middleware/auth");
const authRoutes = require("./routes/auth.routes");
const hardwareRoutes = require("./routes/hardware.routes");
const deviceRoutes = require("./routes/device.routes");
const deviceVariableRoutes = require("./routes/device_variable.routes");
const clusterRoutes = require("./routes/cluster.routes");
const firmwareRoutes = require("./routes/firmware.routes");
const todoRoutes = require("./routes/todo.routes");
const scheduleRoutes = require("./routes/schedule.routes");
const templateRoutes = require("./routes/template.routes");
const thirdRoutes = require("./routes/third.routes");
const logRoutes = require("./routes/log.routes");
const adminRoutes = require("./routes/admin.routes");
const tfRoutes = require("./routes/tf.routes");
const remoteRoutes = require("./routes/remote.routes");
const nameplateRoutes = require("./routes/nameplate.routes");
const homepageRoutes = require("./routes/homepage.routes");
const badgepageRoutes = require("./routes/badgepage.routes");
const weatherpageRoutes = require("./routes/weatherpage.routes");
const systemUpgradeRoutes = require("./routes/system_upgrade.routes");
const taskPlanRoutes = require("./routes/task_plan.routes");
const mobileRoutes = require("./routes/mobile.routes");
const aiRoutes = require("./routes/ai.routes");
const taskRoutes = require("./routes/task.routes");
const albumSourceRoutes = require("./routes/album_source.routes");
const albumImportRoutes = require("./routes/album_import.routes");
const playCollectionRoutes = require("./routes/play_collection.routes");
const deviceTypeRoutes = require("./routes/device_type.routes");
const nvsRoutes = require("./routes/nvs.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const { getRealtimeRuntime } = require("./utils/realtime.hub");
const { getOptimisticPersistStatus } = require("./db/store");
const config = require("./config");

const app = express();
app.locals.runtime = {
  startedAt: new Date().toISOString(),
  storeReady: false,
  listening: false,
  port: null,
};

if (config.trustProxy) {
  app.set("trust proxy", 1);
}

app.use((req, res, next) => {
  const forwardedProtoRaw = req.headers["x-forwarded-proto"];
  const forwardedProto = Array.isArray(forwardedProtoRaw)
    ? String(forwardedProtoRaw[0] || "").split(",")[0].trim()
    : String(forwardedProtoRaw || "").split(",")[0].trim();
  const secure = req.secure || forwardedProto === "https";

  if (config.forceHttps && !secure) {
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
    if (host) {
      return res.redirect(308, `https://${host}${req.originalUrl || req.url || "/"}`);
    }
  }

  if (secure && Number(config.hstsMaxAgeSec || 0) > 0) {
    res.setHeader(
      "Strict-Transport-Security",
      `max-age=${Number(config.hstsMaxAgeSec)}; includeSubDomains`
    );
  }
  return next();
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(responseMiddleware);

function schedulerRuntime(globalKey) {
  const state = global[globalKey] || null;
  return {
    started: Boolean(state),
    running: Boolean(state?.running),
    startedAt: String(state?.startedAt || ""),
    lastTickAt: String(state?.lastTickAt || ""),
    intervalMs: Number(state?.intervalMs || 0),
  };
}

function storePersistenceRuntime() {
  try {
    const status = getOptimisticPersistStatus();
    const failedOutcome = status.lastOutcome === "failed" || status.lastOutcome === "skipped";
    const degraded = Boolean(status.hasPendingSnapshot && status.lastError && failedOutcome);
    return {
      available: true,
      durable: Boolean(status.durable),
      pending: Boolean(status.pending),
      inFlight: Boolean(status.inFlight),
      degraded,
      lastOutcome: String(status.lastOutcome || "idle"),
      lastAttemptAt: String(status.lastAttemptAt || ""),
      lastSuccessAt: String(status.lastSuccessAt || ""),
      lastFailureAt: String(status.lastFailureAt || ""),
      errorCode: degraded ? String(status.lastError?.code || "") : "",
    };
  } catch (_) {
    return {
      available: false,
      durable: false,
      pending: false,
      inFlight: false,
      degraded: true,
      lastOutcome: "unavailable",
      lastAttemptAt: "",
      lastSuccessAt: "",
      lastFailureAt: "",
      errorCode: "STORE_STATUS_UNAVAILABLE",
    };
  }
}

function buildRuntimeInfo(req) {
  const runtime = req.app.locals.runtime || {};
  let realtime = {};
  try {
    realtime = getRealtimeRuntime();
  } catch (_) {
    realtime = { available: false };
  }
  return {
    startedAt: String(runtime.startedAt || ""),
    uptimeSeconds: Math.floor(process.uptime()),
    pid: process.pid,
    nodeVersion: process.version,
    environment: String(process.env.NODE_ENV || "development"),
    listening: Boolean(runtime.listening),
    port: runtime.port || null,
    storeReady: runtime.storeReady === true,
    optionalDependencies: {
      mongoConfigured: Boolean(config.mongoUri),
      redisConfigured: Boolean(config.redis?.enabled && config.redis?.url),
    },
    schedulers: {
      homepageAutoPush: schedulerRuntime("__homepageAutoPushScheduler"),
      xique: schedulerRuntime("__xiqueSchedulerStarted"),
      taskPlan: schedulerRuntime("__taskPlanScheduler"),
      apiTemplateRefresh: schedulerRuntime("__apiTemplateRefreshScheduler"),
      tfFileCleanup: schedulerRuntime("__tfFileCleanupScheduler"),
    },
    storePersistence: storePersistenceRuntime(),
    realtime,
  };
}

app.get("/api/health", (req, res) => {
  res.success({ time: new Date().toISOString(), runtime: buildRuntimeInfo(req) }, "ok");
});

app.get("/api/health/live", (req, res) => {
  res.success({ time: new Date().toISOString(), runtime: buildRuntimeInfo(req) }, "ok");
});

app.get("/api/health/ready", (req, res) => {
  const runtime = buildRuntimeInfo(req);
  if (!runtime.storeReady || runtime.storePersistence.degraded) {
    const reason = runtime.storePersistence.degraded
      ? "store_persistence_degraded"
      : "service_not_ready";
    return res.fail(reason, 503, { time: new Date().toISOString(), runtime });
  }
  return res.success({ time: new Date().toISOString(), runtime }, "ok");
});

app.use("/api/auth", authRoutes);
app.use("/api/hardware", hardwareRoutes);
app.use("/api/device", hardwareRoutes);
app.use("/api/devices", authRequired, deviceRoutes);
app.use("/api/mobile", authRequired, mobileRoutes);
app.use("/api/ai", authRequired, aiRoutes);
app.use("/api/device-variables", authRequired, deviceVariableRoutes);
app.use("/api/clusters", authRequired, clusterRoutes);
app.use("/api/firmware", authRequired, firmwareRoutes);
app.use("/api/todos", authRequired, todoRoutes);
app.use("/api/schedules", authRequired, scheduleRoutes);
app.use("/api/schedule", authRequired, scheduleRoutes);
app.use("/api/templates", authRequired, templateRoutes);
app.use("/api/third", authRequired, thirdRoutes);
app.use("/api/logs", authRequired, logRoutes);
app.use("/api/admin", authRequired, adminRoutes);
app.use("/api/tf", authRequired, tfRoutes);
app.use("/api/remote", authRequired, remoteRoutes);
app.use("/api/nameplates", authRequired, nameplateRoutes);
app.use("/api/homepages", authRequired, homepageRoutes);
app.use("/api/badgepages", authRequired, badgepageRoutes);
app.use("/api/weatherpages", authRequired, weatherpageRoutes);
app.use("/api/system-upgrade", authRequired, systemUpgradeRoutes);
app.use("/api/task-plans", authRequired, taskPlanRoutes);
app.use("/api/tasks", authRequired, taskRoutes);
app.use("/api/album-sources", authRequired, albumSourceRoutes);
app.use("/api/album-imports", authRequired, albumImportRoutes);
app.use("/api/play-collections", authRequired, playCollectionRoutes);
app.use("/api/device-types", authRequired, deviceTypeRoutes);
app.use("/api/nvs", authRequired, nvsRoutes);
app.use("/api/dashboard", authRequired, dashboardRoutes);
app.use("/api", (req, res) => {
  return res.fail("接口不存在", 404);
});

const frontendCandidates = [
  String(process.env.FRONTEND_DIR || "").trim(),
  path.join(__dirname, "../../frontend"),
  path.join(process.cwd(), "frontend"),
  path.join(process.cwd(), "../frontend"),
].filter(Boolean);

const frontendDir =
  frontendCandidates.find((dir) => fs.existsSync(path.join(dir, "index.html"))) || "";

function setStaticCacheHeaders(res, filePath) {
  const fileName = path.basename(String(filePath || ""));
  if (/\.html?$/i.test(fileName)) {
    res.setHeader("Cache-Control", "no-cache");
    return;
  }
  if (/-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/i.test(fileName)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
}

if (frontendDir) {
  app.use(express.static(frontendDir, { setHeaders: setStaticCacheHeaders }));
  const vueAppDir = path.join(frontendDir, "vue-app");
  if (fs.existsSync(path.join(vueAppDir, "index.html"))) {
    app.use("/vue-app", express.static(vueAppDir, { setHeaders: setStaticCacheHeaders }));
  }
} else {
  console.warn(
    `[app] frontend directory not found. checked: ${frontendCandidates.join(" | ")}`
  );
}

app.get("/openapi.yaml", (req, res) => {
  const filePath = path.join(__dirname, "../openapi/openapi.yaml");
  if (!fs.existsSync(filePath)) {
    return res.fail("openapi.yaml 不存在", 404);
  }
  return res.sendFile(filePath);
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  if (!frontendDir) {
    return res.status(404).send("Frontend assets not found");
  }
  const indexPath = path.join(frontendDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    return res.status(404).send("Frontend index not found");
  }
  res.setHeader("Cache-Control", "no-cache");
  return res.sendFile(indexPath);
});

app.use(errorMiddleware);

module.exports = app;
module.exports.buildRuntimeInfo = buildRuntimeInfo;
module.exports.setStaticCacheHeaders = setStaticCacheHeaders;

