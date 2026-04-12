require("dotenv").config();
const http = require("http");
const app = require("./app");
const config = require("./config");
const { initStore } = require("./db/store");
const setupWebSocketServer = require("./ws");
const { startXiqueScheduler } = require("./services/xique_scheduler.service");
const { startHomepageAutoPushScheduler } = require("./services/homepage_auto_push.service");
const { warmupOcrRuntime } = require("./services/captcha_ocr.service");
const { normalizeOrigin } = require("./utils/origin");

async function bootstrap() {
  await initStore();
  startXiqueScheduler();
  startHomepageAutoPushScheduler();
  const server = http.createServer(app);
  setupWebSocketServer(server);
  server.listen(config.port, () => {
    const localOrigin = `http://localhost:${config.port}`;
    const publicOrigin = normalizeOrigin(config.publicOrigin);
    const effectiveOrigin = publicOrigin || localOrigin;
    const wsPublic = effectiveOrigin.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
    // eslint-disable-next-line no-console
    console.log(`Server running at ${localOrigin}`);
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
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Bootstrap failed:", error);
  process.exit(1);
});
