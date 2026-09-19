/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const retryService = fs.readFileSync(path.join(root, "src", "services", "e6", "e6_asset_retry.service.js"), "utf8");
const playRoutes = fs.readFileSync(path.join(root, "src", "routes", "play_collection.routes.js"), "utf8");
const hardwareRoutes = fs.readFileSync(path.join(root, "src", "routes", "hardware.routes.js"), "utf8");
const collectionService = fs.readFileSync(path.join(root, "src", "services", "play_collection.service.js"), "utf8");
const albumImportRoutes = fs.readFileSync(path.join(root, "src", "routes", "album_import.routes.js"), "utf8");
const albumImportService = fs.readFileSync(path.join(root, "src", "services", "album", "album_import.service.js"), "utf8");
const converter = fs.readFileSync(path.join(root, "src", "services", "e6", "e6_converter.service.js"), "utf8");
const tfRoutes = fs.readFileSync(path.join(root, "src", "routes", "tf.routes.js"), "utf8");

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) return "";
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

assert(
  retryService.includes("ensureCollectionE6AssetsReady") &&
    retryService.includes("readTfBuffer") &&
    retryService.includes("convertMissingJob"),
  "E6 retry service should rebuild missing E6 assets from original tf files"
);
assert(
  retryService.includes("preview: false"),
  "automatic E6 asset retry should not generate PNG previews on the push/manifest hot path"
);
assert(
  retryService.includes("previewE6Images") &&
    retryService.includes("ensureImageE6AssetReady") &&
    retryService.includes("previewE6Buffer(buffer)") &&
    !retryService.includes("preview: true"),
  "E6 preview should render the actual generated packed4 asset instead of a temporary conversion"
);
assert(
  retryService.includes("e6DitherMode") && collectionService.includes("isReadyE6AssetForImage"),
  "E6 manifest and retry should honor the selected image dither mode"
);
assert(
  converter.includes("E6_CONVERTER_VERSION") &&
    converter.includes("DEFAULT_E6_DITHER_MODE") &&
    retryService.includes("E6_CONVERTER_VERSION") &&
    collectionService.includes("E6_CONVERTER_VERSION"),
  "E6 rendered asset cache matching should include a converter version"
);
assert(
  converter.includes('DEFAULT_E6_DITHER_MODE = "waveshare_floyd"') &&
    converter.includes('E6_CONVERTER_VERSION = "e6-waveshare-v1"') &&
    converter.includes("waveshare_floyd") &&
    converter.includes('engine: "waveshare"'),
  "converter should expose waveshare_floyd as the default E6 dither mode"
);
assert(
  !functionBody(retryService, "e6AssetDitherMode").includes("photo_soft") &&
    !functionBody(collectionService, "e6AssetDitherMode").includes("photo_soft") &&
    !functionBody(albumImportRoutes, "e6AssetDitherMode").includes("photo_soft"),
  "legacy E6 assets without ditherMode must not be treated as photo_soft"
);
assert(
  retryService.includes("converterVersion: E6_CONVERTER_VERSION") &&
    albumImportRoutes.includes("converterVersion: E6_CONVERTER_VERSION") &&
    albumImportService.includes("converterVersion: E6_CONVERTER_VERSION") &&
    retryService.includes("converterEngine: converted.converterEngine") &&
    albumImportRoutes.includes("converterEngine: converted.converterEngine") &&
    albumImportService.includes("converterEngine: converted.converterEngine"),
  "all new E6 assets and tf metadata should store converterVersion"
);
assert(
  retryService.includes("previewTfFileId") &&
    albumImportRoutes.includes("previewTfFileId") &&
    albumImportService.includes("previewTfFileId"),
  "new E6 assets should store a real previewTfFileId from the same packed4 conversion"
);
assert(
  !functionBody(retryService, "isCurrentE6Asset").includes("previewTfFileId") &&
    !functionBody(collectionService, "isReadyE6AssetForImage").includes("previewTfFileId"),
  "E6 playback and push hot paths must not require previewTfFileId because previews can be rendered from the E6 binary"
);
assert(
  albumImportRoutes.includes("affectedCollectionIds") && albumImportRoutes.includes("collection.version = Number(collection.version || 1) + 1"),
  "changing image E6 dither mode should bump affected collection versions"
);
assert(
  retryService.includes("previewE6Buffer") && retryService.includes("ensureImageE6AssetReady"),
  "E6 preview endpoint should render the actual generated .e6p4 asset, not a separate temporary conversion"
);
assert(
  retryService.includes("previewUrl") && retryService.includes("/api/tf/${") && retryService.includes("previewTfFileId"),
  "E6 preview response should expose the stored real preview URL"
);
assert(
  collectionService.includes("previewTfFileId") && collectionService.includes("e6PreviewTf"),
  "collection item previews should prefer real E6 preview images"
);
assert(
  collectionService.includes("originalPreviewUrl") && collectionService.includes("e6PreviewUrl"),
  "collection item payloads should expose separate original and E6 preview URLs"
);
assert(
  tfRoutes.includes("/:fileId/e6-preview") && tfRoutes.includes("previewE6Buffer(buffer)"),
  "tf route should expose an actual .e6p4 binary preview endpoint"
);
assert(
  /\/:id\/manifest[\s\S]*ensureCollectionE6AssetsReady[\s\S]*buildManifest/.test(playRoutes),
  "web collection manifest route should generate missing E6 assets before building manifest"
);
assert(
  functionBody(playRoutes, "pushCollectionToDevices").includes("ensureCollectionE6AssetsReady") &&
    functionBody(playRoutes, "pushCollectionToDevices").includes("validatePushManifests") &&
    /\/:id\/push[\s\S]*pushCollectionToDevices/.test(playRoutes),
  "collection push should validate generated manifests before queueing commands"
);
assert(
  /\/collections\/:collectionId\/manifest[\s\S]*ensureCollectionE6AssetsReady[\s\S]*buildManifest/.test(hardwareRoutes),
  "hardware manifest route should generate missing E6 assets before responding to ESP32"
);
assert(
  collectionService.includes("unchanged: Number.isFinite(requestedVersion)") &&
    !/throw new HttpError\(409,[^\n]*unchanged/.test(collectionService),
  "collection manifest should return 200 with unchanged instead of 409 for same versions"
);

console.log("[ok] E6 asset retry and manifest contract passed");
