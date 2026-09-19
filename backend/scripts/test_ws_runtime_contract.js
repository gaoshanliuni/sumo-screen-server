/* eslint-disable no-console */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "ws.js"), "utf8");

assert.ok(source.includes("WS_MAX_PAYLOAD_BYTES"), "WebSocket max payload must be bounded");
assert.ok(source.includes("WS_HEARTBEAT_INTERVAL_MS"), "WebSocket heartbeat must be configurable");
assert.match(source, /ws\.isAlive\s*=\s*false[\s\S]*?ws\.ping\(\)/, "heartbeat must ping idle clients");
assert.match(source, /ws\.on\("pong"/, "heartbeat must observe pong frames");
assert.ok(source.includes("WS_MAX_BUFFERED_BYTES"), "outgoing WebSocket backpressure must be bounded");

console.log("[ok] WebSocket runtime contract verified");
