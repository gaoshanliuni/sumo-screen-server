/* eslint-disable no-console */
const assert = require("assert");
const Jimp = require("jimp");

const { createAlbumSourceService } = require("../src/services/album/album_source.service");
const { mapOpenListEntry } = require("../src/services/album/openlist_provider.service");
const { resolveNasLocalPath } = require("../src/services/album/nas_provider.service");
const { createPlayCollectionService } = require("../src/services/play_collection.service");
const {
  convertImageBufferToE6P4,
  DEFAULT_E6_DITHER_MODE,
  E6_CONVERTER_VERSION,
  E6_PACKED4_SIZE,
  e6TransformKey,
  e6ConverterEngineForMode,
} = require("../src/services/e6/e6_converter.service");
const { createConcurrencyLimiter } = require("../src/utils/concurrency");

const NOW = "2026-06-06T00:00:00.000Z";
const authAdmin = { role: "admin", userId: "u_admin", username: "admin" };
const authAlice = { role: "user", userId: "u_alice", username: "alice" };
const authBob = { role: "user", userId: "u_bob", username: "bob" };
const authE6Device = { role: "device", deviceId: "dev_e6" };

function makeState() {
  return {
    users: [
      { id: "u_admin", username: "admin", role: "admin", status: "enabled" },
      { id: "u_alice", username: "alice", role: "user", status: "enabled" },
      { id: "u_bob", username: "bob", role: "user", status: "enabled" },
    ],
    devices: [
      { id: "dev_e6", ownerId: "u_alice", type: "e6-color-frame", status: "enabled" },
      { id: "dev_bw", ownerId: "u_alice", type: "ink-screen", status: "enabled" },
    ],
    albumSources: [],
    albumSourceCredentials: [],
    imageAssets: [
      {
        id: "img_1",
        ownerId: "u_alice",
        originalName: "one.png",
        sha256: "sha_one",
        tfFileId: "tf_1",
        e6AssetId: "e6_1",
        e6DitherMode: DEFAULT_E6_DITHER_MODE,
        status: "ready",
      },
      {
        id: "img_2",
        ownerId: "u_alice",
        originalName: "two.png",
        sha256: "sha_two",
        tfFileId: "tf_2",
        e6AssetId: "e6_2",
        e6DitherMode: DEFAULT_E6_DITHER_MODE,
        status: "ready",
      },
    ],
    playCollections: [],
    playCollectionItems: [],
    remoteCommandAcks: [],
    e6RenderedAssets: [
      {
        id: "e6_1",
        imageId: "img_1",
        binaryTfFileId: "tf_e6_1",
        previewTfFileId: "tf_e6_preview_1",
        binarySha256: "sha_e6",
        binarySize: E6_PACKED4_SIZE,
        ditherMode: DEFAULT_E6_DITHER_MODE,
        converterVersion: E6_CONVERTER_VERSION,
        converterEngine: e6ConverterEngineForMode(DEFAULT_E6_DITHER_MODE),
        imageTransform: { rotateDeg: 0, crop: { x: 0, y: 0, width: 1, height: 1 } },
        transformKey: e6TransformKey({}),
        convertStatus: "ready",
      },
      {
        id: "e6_2",
        imageId: "img_2",
        binaryTfFileId: "tf_e6_2",
        previewTfFileId: "tf_e6_preview_2",
        binarySha256: "sha_e6_2",
        binarySize: E6_PACKED4_SIZE,
        ditherMode: DEFAULT_E6_DITHER_MODE,
        converterVersion: E6_CONVERTER_VERSION,
        converterEngine: e6ConverterEngineForMode(DEFAULT_E6_DITHER_MODE),
        imageTransform: { rotateDeg: 0, crop: { x: 0, y: 0, width: 1, height: 1 } },
        transformKey: e6TransformKey({}),
        convertStatus: "ready",
      },
    ],
    tfFiles: [
      { id: "tf_1", ownerId: "u_alice", originalName: "one.png", size: 12, sha256: "sha_one" },
      { id: "tf_e6_1", ownerId: "u_alice", originalName: "one.e6p4", size: E6_PACKED4_SIZE, sha256: "sha_e6" },
      { id: "tf_e6_preview_1", ownerId: "u_alice", originalName: "one.e6-preview.png", mime: "image/png", size: 1024 },
      { id: "tf_2", ownerId: "u_alice", originalName: "two.png", size: 12, sha256: "sha_two" },
      { id: "tf_e6_2", ownerId: "u_alice", originalName: "two.e6p4", size: E6_PACKED4_SIZE, sha256: "sha_e6_2" },
      { id: "tf_e6_preview_2", ownerId: "u_alice", originalName: "two.e6-preview.png", mime: "image/png", size: 1024 },
    ],
  };
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[failed] ${name}: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}

async function main() {
  await run("album source service encrypts credentials and redacts responses", async () => {
    const state = makeState();
    const service = createAlbumSourceService({ now: () => NOW, idFactory: (prefix) => `${prefix}_fixed` });
    const created = service.createSource(state, authAlice, {
      providerType: "openlist",
      name: "家庭 OpenList",
      baseUrl: "https://openlist.example.com",
      rootPath: "/Photos",
      username: "alice-openlist",
      password: "plain-secret",
      isPublic: false,
      config: { timeoutSec: 20, maxConcurrency: 4 },
    });

    assert.strictEqual(created.id, "src_fixed");
    assert.strictEqual(created.ownerId, "u_alice");
    assert.strictEqual(created.username, "alice-openlist");
    assert.strictEqual(created.password, undefined);
    assert.strictEqual(created.hasPassword, true);
    assert.strictEqual(state.albumSourceCredentials.length, 1);
    assert.ok(!JSON.stringify(state.albumSources).includes("plain-secret"));
    assert.ok(!JSON.stringify(state.albumSourceCredentials).includes("plain-secret"));

    const credential = service.getCredentialForProvider(state, created.id, authAlice);
    assert.strictEqual(credential.username, "alice-openlist");
    assert.strictEqual(credential.password, "plain-secret");

    assert.deepStrictEqual(service.listSources(state, authBob), []);
    service.patchSource(state, authAlice, created.id, { isPublic: true });
    assert.strictEqual(service.listSources(state, authBob).length, 1);
    assert.strictEqual(service.listSources(state, authAdmin).length, 1);
  });

  await run("openlist provider maps directory and image entries to a stable browser contract", async () => {
    const source = { id: "src_1", rootPath: "/Photos" };
    const dir = mapOpenListEntry(source, "/Trips", { name: "June", is_dir: true, modified: "2026-06-01T00:00:00Z" });
    const file = mapOpenListEntry(source, "/Trips", {
      name: "a.jpg",
      is_dir: false,
      size: 123,
      modified: "2026-06-01T00:00:00Z",
      thumb: "/thumb/a.jpg",
      type: 5,
    });
    assert.strictEqual(dir.type, "dir");
    assert.strictEqual(dir.path, "/Trips/June");
    assert.strictEqual(file.type, "file");
    assert.strictEqual(file.path, "/Trips/a.jpg");
    assert.strictEqual(file.mime, "image/jpeg");
    assert.ok(file.thumbnailUrl.includes("/api/album-sources/src_1/thumbnail"));
    assert.ok(file.previewUrl.includes("/api/album-sources/src_1/preview"));
  });

  await run("nas local provider rejects path traversal outside source root", async () => {
    const root = process.platform === "win32" ? "D:\\nas\\photos" : "/srv/nas/photos";
    const inside = resolveNasLocalPath({ rootPath: root }, "2026/june");
    assert.ok(inside.resolvedPath.includes("june"));
    assert.throws(() => resolveNasLocalPath({ rootPath: root }, "../../secret"), /越权访问/);
  });

  await run("e6 converter emits exact packed 4-bit frame size", async () => {
    const image = await new Jimp(20, 12, 0xff0000ff);
    const png = await image.getBufferAsync(Jimp.MIME_PNG);
    const result = await convertImageBufferToE6P4(png, { fit: "contain", dither: false });
    assert.strictEqual(result.buffer.length, E6_PACKED4_SIZE);
    assert.strictEqual(result.width, 800);
    assert.strictEqual(result.height, 480);
    assert.strictEqual(result.format, "e6p4");
  });

  await run("play collection service creates generic collections and e6 manifests", async () => {
    const state = makeState();
    const service = createPlayCollectionService({ now: () => NOW, idFactory: (prefix) => `${prefix}_fixed` });
    const collection = service.createCollection(state, authAlice, {
      name: "家庭相册",
      playMode: "slideshow",
      slideIntervalSec: 120,
      offlineSyncEnabled: true,
    });
    service.setItems(state, authAlice, collection.id, [
      { imageId: "img_1", sortOrder: 1 },
      { imageId: "img_2", sortOrder: 2 },
    ]);
    const manifest = service.buildManifest(state, authAlice, {
      collectionId: collection.id,
      deviceId: "dev_e6",
      baseUrl: "https://epd.example.com",
    });
    assert.strictEqual(manifest.deviceType, "e6-color-frame");
    assert.strictEqual(manifest.items.length, 2);
    assert.strictEqual(manifest.items[0].format, "e6p4");
    assert.strictEqual(manifest.items[1].imageId, "img_2");
    assert.strictEqual(manifest.items[0].downloadUrl, "/api/hardware/tf/download/tf_e6_1");
    assert.ok(!/^https?:\/\//i.test(manifest.items[0].downloadUrl));

    const event = service.buildPushEvent(state, authAlice, {
      collectionId: collection.id,
      deviceId: "dev_e6",
      baseUrl: "https://epd.example.com",
    });
    assert.strictEqual(event.type, "collection.push");
    assert.strictEqual(event.deviceId, "dev_e6");
    assert.strictEqual(event.payload.manifestUrl, "/api/hardware/collections/col_fixed/manifest?deviceId=dev_e6");
    assert.ok(!/^https?:\/\//i.test(event.payload.manifestUrl));
  });

  await run("hardware manifest skips invalid items so wheel navigation can continue", async () => {
    const state = makeState();
    const service = createPlayCollectionService({ now: () => NOW, idFactory: (prefix) => `${prefix}_fixed` });
    const collection = service.createCollection(state, authAlice, {
      name: "含坏图集合",
      playMode: "slideshow",
    });
    service.setItems(state, authAlice, collection.id, [{ imageId: "img_1", sortOrder: 1 }]);
    state.playCollectionItems.push(
      { id: "pci_missing", collectionId: collection.id, imageId: "img_missing", sortOrder: 2, enabled: true },
      { id: "pci_valid_2", collectionId: collection.id, imageId: "img_2", sortOrder: 3, enabled: true }
    );

    assert.throws(
      () => service.buildManifest(state, authE6Device, { collectionId: collection.id, deviceId: "dev_e6" }),
      /图片不存在/
    );
    const manifest = service.buildManifest(state, authE6Device, {
      collectionId: collection.id,
      deviceId: "dev_e6",
      skipInvalidItems: true,
    });
    assert.strictEqual(manifest.items.length, 2);
    assert.deepStrictEqual(manifest.items.map((item) => item.imageId), ["img_1", "img_2"]);
    assert.strictEqual(manifest.skippedItemCount, 1);
    assert.strictEqual(manifest.skippedItems[0].imageId, "img_missing");
  });

  await run("deleting a collection clears stale device playback state", async () => {
    const state = makeState();
    const service = createPlayCollectionService({ now: () => NOW, idFactory: (prefix) => `${prefix}_fixed` });
    const collection = service.createCollection(state, authAlice, {
      name: "待删除集合",
      playMode: "slideshow",
    });
    state.devices[0].currentPlayMode = "album";
    state.devices[0].currentCollectionId = collection.id;
    state.devices[0].lastDisplayCollectionId = collection.id;
    state.devices[0].lastDisplayItemIndex = 1;
    state.remoteCommandAcks.push({
      id: "cmd_deleted_collection",
      commandId: "cmd_deleted_collection",
      deviceId: "dev_e6",
      eventType: "collection.push",
      status: "pending",
      ackStatus: "",
      meta: { collectionId: collection.id, commandPayload: { collectionId: collection.id } },
    });

    service.deleteCollection(state, authAlice, collection.id);

    assert.strictEqual(state.devices[0].currentCollectionId, "");
    assert.strictEqual(state.devices[0].lastDisplayCollectionId, "");
    assert.strictEqual(state.devices[0].lastDisplayItemIndex, 0);
    assert.strictEqual(state.devices[0].currentPlayMode, "");
    assert.strictEqual(state.remoteCommandAcks[0].status, "canceled");
  });

  await run("e6 device token can read its owner collection manifest without source credentials", async () => {
    const state = makeState();
    const service = createPlayCollectionService({ now: () => NOW, idFactory: (prefix) => `${prefix}_fixed` });
    const collection = service.createCollection(state, authAlice, {
      name: "设备可读集合",
      playMode: "slideshow",
    });
    service.setItems(state, authAlice, collection.id, [{ imageId: "img_1", sortOrder: 1 }]);
    const manifest = service.buildManifest(state, authE6Device, {
      collectionId: collection.id,
      deviceId: "dev_e6",
      baseUrl: "https://epd.example.com",
    });
    assert.strictEqual(manifest.collectionId, collection.id);
    assert.strictEqual(manifest.items[0].downloadUrl, "/api/hardware/tf/download/tf_e6_1");
    assert.ok(!/^https?:\/\//i.test(manifest.items[0].downloadUrl));
  });

  await run("e6 device token can read currently pushed collection even when owner differs", async () => {
    const state = makeState();
    const service = createPlayCollectionService({ now: () => NOW, idFactory: (prefix) => `${prefix}_assigned` });
    const collection = service.createCollection(state, authAdmin, {
      ownerId: "u_bob",
      name: "管理员下发给设备的集合",
      playMode: "slideshow",
      targetDeviceType: "e6-color-frame",
    });
    service.setItems(state, authAdmin, collection.id, [{ imageId: "img_1", sortOrder: 1 }]);
    assert.throws(
      () =>
        service.buildManifest(state, authE6Device, {
          collectionId: collection.id,
          deviceId: "dev_e6",
          baseUrl: "https://epd.example.com",
        }),
      /设备无权限访问该集合/
    );

    state.devices[0].currentCollectionId = collection.id;
    state.devices[0].lastDisplayCollectionId = collection.id;
    const manifest = service.buildManifest(state, authE6Device, {
      collectionId: collection.id,
      deviceId: "dev_e6",
      baseUrl: "https://epd.example.com",
    });
    assert.strictEqual(manifest.collectionId, collection.id);
    assert.strictEqual(manifest.items.length, 1);
    assert.strictEqual(manifest.items[0].imageId, "img_1");
  });

  await run("concurrency limiter keeps 100 simultaneous tasks under configured pressure", async () => {
    const limit = createConcurrencyLimiter(7);
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        limit(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, index % 3));
          active -= 1;
          return index;
        })
      )
    );
    assert.ok(maxActive <= 7, `maxActive=${maxActive}`);
  });

  if (process.exitCode) {
    throw new Error("album/openlist/e6 tests failed");
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
