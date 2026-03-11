require("dotenv").config();
const http = require("http");
const app = require("./app");
const config = require("./config");
const { initStore } = require("./db/store");
const setupWebSocketServer = require("./ws");

async function bootstrap() {
  await initStore();
  const server = http.createServer(app);
  setupWebSocketServer(server);
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running at http://localhost:${config.port}`);
    // eslint-disable-next-line no-console
    console.log(`WebSocket endpoint: ws://localhost:${config.port}/ws/hardware`);
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Bootstrap failed:", error);
  process.exit(1);
});
