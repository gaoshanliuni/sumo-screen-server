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
const config = require("./config");

const app = express();

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

app.get("/api/health", (req, res) => {
  res.success({ time: new Date().toISOString() }, "ok");
});

app.use("/api/auth", authRoutes);
app.use("/api/hardware", hardwareRoutes);
app.use("/api/devices", authRequired, deviceRoutes);
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

if (frontendDir) {
  app.use(express.static(frontendDir));
  const vueAppDir = path.join(frontendDir, "vue-app");
  if (fs.existsSync(path.join(vueAppDir, "index.html"))) {
    app.use("/vue-app", express.static(vueAppDir));
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
  return res.sendFile(indexPath);
});

app.use(errorMiddleware);

module.exports = app;

