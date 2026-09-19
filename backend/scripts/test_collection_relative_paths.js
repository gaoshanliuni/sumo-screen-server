/* eslint-disable no-console */
const assert = require("assert");
const { createPlayCollectionService } = require("../src/services/play_collection.service");
const {
  DEFAULT_E6_DITHER_MODE,
  E6_CONVERTER_VERSION,
  e6TransformKey,
  e6ConverterEngineForMode,
} = require("../src/services/e6/e6_converter.service");

function main() {
  let counter = 0;
  const service = createPlayCollectionService({
    now: () => "2026-06-06T00:00:00.000Z",
    idFactory: (prefix) => `${prefix}_${++counter}`,
  });
  const auth = { role: "user", userId: "u_relative" };
  const state = {
    playCollections: [],
    playCollectionItems: [],
    imageAssets: [
      {
        id: "img_relative",
        ownerId: "u_relative",
        originalName: "demo.jpg",
        e6AssetId: "e6_relative",
        e6DitherMode: DEFAULT_E6_DITHER_MODE,
        status: "ready",
      },
    ],
    e6RenderedAssets: [
      {
        id: "e6_relative",
        imageId: "img_relative",
        binaryTfFileId: "tf_relative",
        previewTfFileId: "tf_relative_preview",
        binarySize: 192000,
        ditherMode: DEFAULT_E6_DITHER_MODE,
        converterVersion: E6_CONVERTER_VERSION,
        converterEngine: e6ConverterEngineForMode(DEFAULT_E6_DITHER_MODE),
        imageTransform: { rotateDeg: 0, crop: { x: 0, y: 0, width: 1, height: 1 } },
        transformKey: e6TransformKey({}),
        convertStatus: "success",
      },
    ],
    tfFiles: [
      {
        id: "tf_relative",
        ownerId: "u_relative",
        originalName: "demo.e6p4",
        size: 192000,
      },
      {
        id: "tf_relative_preview",
        ownerId: "u_relative",
        originalName: "demo.e6-preview.png",
        mime: "image/png",
        size: 1024,
      },
    ],
    devices: [
      {
        id: "dev_relative",
        ownerId: "u_relative",
        type: "e6-color-frame",
      },
    ],
  };

  const collection = service.createCollection(state, auth, {
    name: "relative-paths",
    targetDeviceType: "e6-color-frame",
  });
  service.setItems(state, auth, collection.id, [{ imageId: "img_relative", sortOrder: 1 }]);

  const manifest = service.buildManifest(state, auth, {
    collectionId: collection.id,
    deviceId: "dev_relative",
    baseUrl: "https://epd.example.com",
  });
  const downloadUrl = manifest.items[0].downloadUrl;
  assert.strictEqual(downloadUrl, "/api/hardware/tf/download/tf_relative");
  assert.ok(!/^https?:\/\//i.test(downloadUrl), "manifest downloadUrl must be relative");

  const event = service.buildPushEvent(state, auth, {
    collectionId: collection.id,
    deviceId: "dev_relative",
    baseUrl: "https://epd.example.com",
  });
  assert.strictEqual(
    event.payload.manifestUrl,
    `/api/hardware/collections/${collection.id}/manifest?deviceId=dev_relative`
  );
  assert.ok(!/^https?:\/\//i.test(event.payload.manifestUrl), "push manifestUrl must be relative");

  console.log("[ok] collection manifest and push payload use relative hardware paths");
}

main();
