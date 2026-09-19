/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const route = fs.readFileSync(path.join(root, "backend", "src", "routes", "album_import.routes.js"), "utf8");
const panel = fs.readFileSync(path.join(root, "frontend-vue", "src", "components", "E6AlbumPanel.vue"), "utf8");
const collectionService = fs.readFileSync(path.join(root, "backend", "src", "services", "play_collection.service.js"), "utf8");

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

const saveUploadedImageBody = route.match(/async function saveUploadedImage[\s\S]*?\n}\n\nasync function/)?.[0] || "";
const deleteSourceBody = panel.match(/async function deleteSource\(\)[\s\S]*?\n}\n\nasync function testSource/)?.[0] || "";

assert(
  route.includes("queueUploadedE6Conversion"),
  "upload route should queue E6 conversion in background"
);
assert(
  !/await\s+convertImageBufferToE6P4/.test(saveUploadedImageBody),
  "saveUploadedImage must not await E6 conversion before responding"
);
assert(
  panel.includes("uploadFileChunksWithLimit") && /const\s+UPLOAD_CHUNK_SIZE\s*=/.test(panel),
  "web album upload should use chunked uploads with a small concurrency limit"
);
assert(
  !/for\s*\(\s*const\s+file\s+of\s+filesToUpload[\s\S]*?files:\s*\[file\]/.test(panel),
  "web album upload must not upload files serially one request at a time"
);
assert(
  /deleteAlbumSource[\s\S]*?sources\.value = sources\.value\.filter/.test(deleteSourceBody) &&
    !deleteSourceBody.includes("await loadAll()"),
  "deleting an album source should update local state instead of triggering full loadAll"
);
assert(
  !panel.includes("collectionRows.slice(0, 8).forEach"),
  "album page should not eager-load the first 8 collection details on initial load"
);
assert(
  collectionService.includes("countByCollection") && collectionService.includes("imageById") && collectionService.includes("tfById"),
  "collection service should use maps for collection counts and detail item joins"
);

console.log("[ok] album upload and load performance contract passed");
