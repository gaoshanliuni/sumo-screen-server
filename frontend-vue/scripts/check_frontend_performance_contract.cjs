const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const router = fs.readFileSync(path.join(root, "src", "router", "index.ts"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "src", "views", "DashboardCore.vue"), "utf8");
const vite = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8");
const api = fs.readFileSync(path.join(root, "src", "services", "api.ts"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.ts"), "utf8");

assert.ok(!/^import\s+\w+App\s+from\s+"\.\.\/views\//m.test(router), "route views must not be eagerly imported");
assert.ok(router.includes('component: () => import("../views/'), "route views must use dynamic import");
assert.ok(dashboard.includes('apiRequest<DashboardOverviewPayload>("/api/dashboard/overview"'), "overview must use aggregate API");
assert.ok(dashboard.includes("loadInitialDashboardData"), "dashboard must expose a minimal initial loader");
assert.ok(dashboard.includes("Promise.allSettled([...loaders]"), "panel loaders must run concurrently and isolate failures");
assert.ok(dashboard.includes("defineAsyncComponent"), "heavy dashboard panels must be async components");
assert.ok(vite.includes('"vue-vendor"') && vite.includes('"element-plus"'), "vendor chunks must be stable and cacheable");
assert.ok(vite.includes('"element-plus-table"'), "large Element Plus table code must be isolated");
assert.ok(!main.includes('import ElementPlus from "element-plus"'), "Element Plus must not be registered as a full plugin");
assert.ok(!/from\s+["']element-plus["']/.test(main), "Element Plus components must use direct module imports");
assert.ok(!main.includes('element-plus/dist/index.css'), "Element Plus styles must be imported per component");
assert.ok(main.includes('element-plus/es/components/button/style/css'), "Element Plus component styles must be explicit");
assert.ok(api.includes("response.text()") && api.includes("JSON.parse(raw)"), "API client must report non-JSON server failures cleanly");
assert.ok(api.includes('removeEventListener("abort"'), "API client must detach upstream abort listeners");

console.log("[ok] frontend performance contract satisfied");
