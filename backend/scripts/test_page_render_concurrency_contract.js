/* eslint-disable no-console */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "services", "page_profile.service.js"),
  "utf8"
);

assert.ok(source.includes("PAGE_RENDER_BROWSER_MAX_CONCURRENT"), "render concurrency must be configurable");
assert.ok(source.includes("createConcurrencyLimiter"), "browser rendering must use the shared concurrency limiter");
assert.match(
  source,
  /return\s+browserRenderLimit\(\(\)\s*=>\s*renderWithBrowserEngineUnbounded\(options\)\)/,
  "all browser renders must pass through the limiter"
);

console.log("[ok] browser render concurrency contract verified");
