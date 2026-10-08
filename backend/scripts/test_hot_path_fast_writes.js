const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

const logging = read("src/utils/logging.js");
if (!logging.includes("updateDBOptimistic")) {
  fail("operation/api logging must use updateDBOptimistic so logs cannot block user requests");
}
if (/require\(["']\.\.\/db\/store["']\).*updateDB(?!Optimistic)/s.test(logging)) {
  fail("logging.js must not import synchronous updateDB");
}

const albumRoutes = read("src/routes/album_import.routes.js");
if (/\bawait\s+updateDB\s*\(/.test(albumRoutes)) {
  fail("album_import.routes.js hot request handlers must not await synchronous updateDB");
}
if (!albumRoutes.includes("updateDBOptimistic")) {
  fail("album_import.routes.js should use updateDBOptimistic for fast UI responses");
}
if (!/processJob\(\{[\s\S]*updateDB:\s*updateDBOptimistic/.test(albumRoutes)) {
  fail("album import background jobs should receive updateDBOptimistic to avoid blocking the global write queue");
}

const albumService = read("src/services/album/album_import.service.js");
if (/dither:\s*false/.test(albumService)) {
  fail("album source imports must not disable E6 dithering");
}

const store = read("src/db/store.js");
if (!store.includes("pendingOptimisticSnapshot")) {
  fail("updateDBOptimistic persistence must coalesce snapshots instead of queueing every hot-path write");
}
if (!store.includes("flushPendingOptimisticPersist")) {
  fail("synchronous updateDB must flush the latest optimistic snapshot before loading DB state");
}

console.log("[OK] hot path writes avoid synchronous DB blocking");
