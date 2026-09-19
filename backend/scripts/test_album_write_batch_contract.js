/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..", "..");
const route = fs.readFileSync(path.join(root, "backend", "src", "routes", "album_import.routes.js"), "utf8");
const store = fs.readFileSync(path.join(root, "backend", "src", "db", "store.js"), "utf8");

const uploadHandler = route.match(/const handleAlbumUpload = asyncHandler\([\s\S]*?\n}\);/)?.[0] || "";
assert.ok(uploadHandler, "album upload handler should be discoverable");
assert.ok(
  route.includes("saveUploadedImagesBatch"),
  "album upload should stage files and persist metadata in one batched DB update"
);
assert.ok(
  !/for\s*\([^)]*files\.entries\(\)[\s\S]*?await\s+saveUploadedImage/.test(uploadHandler),
  "album upload handler must not await a full DB update for each uploaded file"
);
assert.ok(
  /updateDBOptimistic/.test(route),
  "album upload/source routes should use optimistic store writes for user-facing metadata mutations"
);
assert.ok(
  store.includes("enqueueSnapshotPersist"),
  "store should keep optimistic writes backed by queued persistence"
);

console.log("[ok] album write batch performance contract passed");
