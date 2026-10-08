/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const route = fs.readFileSync(path.join(root, "src", "routes", "album_import.routes.js"), "utf8");
const service = fs.readFileSync(path.join(root, "src", "services", "album", "album_import.service.js"), "utf8");
const converter = fs.readFileSync(path.join(root, "src", "services", "e6", "e6_converter.service.js"), "utf8");

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

assert(converter.includes("normalizeE6DitherMode"), "converter should expose a reusable dither mode normalizer");
assert(route.includes("normalizeUploadDitherMode"), "upload route should normalize requested E6 dither mode");
assert(route.includes("ditherMode") && route.includes("convertImageBufferToE6P4(buffer, { fit: \"contain\", ditherMode, preview: false })"),
  "upload route should pass ditherMode into E6 conversion");
assert(
  route.includes("preview: false"),
  "upload/import conversion should skip PNG preview generation unless explicitly requested"
);
assert(
  route.includes('"/e6-preview"') && route.includes("previewE6Images"),
  "album import route should expose on-demand E6 preview generation"
);
assert(
  route.includes('"/e6-dither"') && route.includes("e6DitherMode"),
  "album import route should persist selected E6 dither mode for one or more images"
);
assert(route.includes("ditherMode: converted.ditherMode"), "upload route should store ditherMode on rendered E6 assets");
assert(service.includes("resolveJobDitherMode"), "album import service should normalize requested E6 dither mode");
assert(service.includes("ditherMode: resolveJobDitherMode(payload)"), "import jobs should persist the selected dither mode");
assert(
  service.includes("convertImageBufferToE6P4(download.buffer, { fit: \"contain\", ditherMode: job.ditherMode, preview: false })"),
  "album import service should pass job.ditherMode into E6 conversion"
);
assert(service.includes("ditherMode: converted.ditherMode"), "import service should store ditherMode on rendered E6 assets");

console.log("[ok] album dither mode contract passed");
