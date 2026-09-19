const fs = require("fs");
const path = require("path");

const routePath = path.join(__dirname, "..", "src", "routes", "hardware.routes.js");
const source = fs.readFileSync(routePath, "utf8");

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function routeBlock(route) {
  const marker = `router.post(\n  "${route}"`;
  const start = source.indexOf(marker);
  if (start < 0) fail(`route ${route} not found`);
  const next = source.indexOf("\nrouter.", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

for (const route of ["/status", "/remote/ack"]) {
  const block = routeBlock(route);
  if (!block.includes("updateDBOptimistic(")) {
    fail(`hardware ${route} must use updateDBOptimistic for fast device responses`);
  }
  if (/\bupdateDB\s*\(/.test(block)) {
    fail(`hardware ${route} must not wait for synchronous updateDB`);
  }
}

const ackBlock = routeBlock("/remote/ack");
if (/await\s+logOperation\s*\(/.test(ackBlock)) {
  fail("hardware /remote/ack must not await operation logging before responding");
}

console.log("[OK] hardware fast write routes use optimistic persistence");
