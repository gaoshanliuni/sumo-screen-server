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

const app = express();

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

const frontendDir = path.join(__dirname, "../../frontend");
app.use(express.static(frontendDir));
app.get("/openapi.yaml", (req, res) => {
  const filePath = path.join(__dirname, "../openapi/openapi.yaml");
  if (!fs.existsSync(filePath)) {
    return res.fail("openapi.yaml 不存在", 404);
  }
  return res.sendFile(filePath);
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  return res.sendFile(path.join(frontendDir, "index.html"));
});

app.use(errorMiddleware);

module.exports = app;

