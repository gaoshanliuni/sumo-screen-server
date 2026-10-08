const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const {
  DEFAULT_E6_DITHER_MODE,
  E6_CONVERTER_VERSION,
  normalizeE6ImageTransform,
  e6TransformKey,
  e6ConverterEngineForMode,
} = require("./e6/e6_converter.service");

const DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC = 10 * 60;

function nowIso() {
  return new Date().toISOString();
}

function isAdmin(auth) {
  return auth?.role === "admin";
}

function ownerIdOf(auth) {
  return String(auth?.userId || "");
}

function canReadOwner(row = {}, auth) {
  if (isAdmin(auth)) return true;
  if (row.isPublic) return true;
  return String(row.ownerId || "") === ownerIdOf(auth);
}

function canWriteOwner(row = {}, auth) {
  if (isAdmin(auth)) return true;
  return String(row.ownerId || "") === ownerIdOf(auth);
}

function normalizeBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  return Boolean(value);
}

function normalizePositiveSeconds(value, fallback = DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC) {
  const n = Number(value);
  const candidate = Number.isFinite(n) ? n : Number(fallback);
  return Math.max(5, Math.min(86400, candidate));
}

function normalizeCollectionPayload(payload = {}, auth, options = {}) {
  const now = options.now ? options.now() : nowIso();
  const ownerId = isAdmin(auth) && payload.ownerId ? String(payload.ownerId) : ownerIdOf(auth);
  if (!ownerId) throw new HttpError(400, "ownerId不能为空");
  const name = String(payload.name || "").trim();
  if (!name) throw new HttpError(400, "集合名称不能为空");
  return {
    id: options.idFactory ? options.idFactory("col") : createId("col"),
    ownerId,
    name,
    description: String(payload.description || "").trim(),
    coverImageId: String(payload.coverImageId || ""),
    playMode: String(payload.playMode || "slideshow").trim() || "slideshow",
    slideIntervalSec: normalizePositiveSeconds(payload.slideIntervalSec, DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC),
    loopEnabled: normalizeBool(payload.loopEnabled, true),
    shuffleEnabled: normalizeBool(payload.shuffleEnabled, false),
    offlineSyncEnabled: normalizeBool(payload.offlineSyncEnabled, true),
    targetDeviceType: String(payload.targetDeviceType || ""),
    status: String(payload.status || "enabled"),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeItemPayload(payload = {}, collectionId, options = {}) {
  const now = options.now ? options.now() : nowIso();
  const imageId = String(payload.imageId || "").trim();
  if (!imageId) throw new HttpError(400, "imageId不能为空");
  return {
    id: options.idFactory ? options.idFactory("coli") : createId("coli"),
    collectionId,
    imageId,
    sortOrder: Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : 0,
    durationSec: Math.max(0, Number(payload.durationSec || 0)),
    enabled: normalizeBool(payload.enabled, true),
    createdAt: now,
  };
}

function ensureShape(state) {
  state.playCollections = Array.isArray(state.playCollections) ? state.playCollections : [];
  state.playCollectionItems = Array.isArray(state.playCollectionItems) ? state.playCollectionItems : [];
  state.imageAssets = Array.isArray(state.imageAssets) ? state.imageAssets : [];
  state.e6RenderedAssets = Array.isArray(state.e6RenderedAssets) ? state.e6RenderedAssets : [];
  state.tfFiles = Array.isArray(state.tfFiles) ? state.tfFiles : [];
  state.devices = Array.isArray(state.devices) ? state.devices : [];
  state.remoteCommandAcks = Array.isArray(state.remoteCommandAcks) ? state.remoteCommandAcks : [];
}

function isImageLike(image = {}, file = {}) {
  const mime = String(image.mime || file.mime || "").toLowerCase();
  const name = String(image.originalName || file.originalName || file.name || "").toLowerCase();
  return mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name);
}

function e6AssetDitherMode(asset = {}) {
  return String(asset.ditherMode || asset.meta?.ditherMode || "legacy_unknown");
}

function e6AssetConverterVersion(asset = {}) {
  return String(asset.converterVersion || asset.meta?.converterVersion || "");
}

function e6AssetConverterEngine(asset = {}) {
  return String(asset.converterEngine || asset.meta?.converterEngine || "");
}

function e6AssetTransformKey(asset = {}) {
  return String(asset.transformKey || asset.meta?.transformKey || "");
}

function isPlayableE6AssetBasic(asset = {}) {
  const status = String(asset.convertStatus || "").toLowerCase();
  return Boolean(asset.binaryTfFileId && (!status || status === "ready" || status === "success"));
}

function e6AssetCreatedAtMs(asset = {}) {
  const value = Date.parse(asset.updatedAt || asset.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

function findPlayableE6AssetByImageId(state, imageId) {
  const tfById = new Map((state.tfFiles || []).map((file) => [String(file.id || ""), file]));
  return (
    (state.e6RenderedAssets || [])
      .filter((asset) => String(asset.imageId || asset.meta?.imageAssetId || "") === String(imageId || ""))
      .filter(isPlayableE6AssetBasic)
      .filter((asset) => tfById.has(String(asset.binaryTfFileId || "")))
      .sort((a, b) => {
        const aCurrent = e6AssetConverterVersion(a) === E6_CONVERTER_VERSION ? 1 : 0;
        const bCurrent = e6AssetConverterVersion(b) === E6_CONVERTER_VERSION ? 1 : 0;
        if (aCurrent !== bCurrent) return bCurrent - aCurrent;
        return e6AssetCreatedAtMs(b) - e6AssetCreatedAtMs(a);
      })[0] || null
  );
}

function desiredImageDitherMode(image = {}) {
  return String(image.e6DitherMode || DEFAULT_E6_DITHER_MODE).trim();
}

function desiredImageTransformKey(image = {}) {
  return e6TransformKey(normalizeE6ImageTransform(image.e6ImageTransform || image.e6Transform || image.imageTransform || {}));
}

function isReadyE6AssetForImage(asset = {}, image = {}) {
  const status = String(asset.convertStatus || "").toLowerCase();
  if (!asset.binaryTfFileId || (status && status !== "ready" && status !== "success")) return false;
  if (e6AssetConverterVersion(asset) !== E6_CONVERTER_VERSION) return false;
  const desired = desiredImageDitherMode(image);
  if (desired === "legacy_unknown") return false;
  try {
    return (
      e6AssetDitherMode(asset) === desired &&
      e6AssetConverterEngine(asset) === e6ConverterEngineForMode(desired) &&
      e6AssetTransformKey(asset) === desiredImageTransformKey(image)
    );
  } catch (_) {
    return false;
  }
}

function createPlayCollectionService(options = {}) {
  const clock = options.now || nowIso;
  const idFactory = options.idFactory || createId;

  function listCollections(state, auth) {
    ensureShape(state);
    const countByCollection = new Map();
    state.playCollectionItems.forEach((item) => {
      if (item.enabled === false) return;
      const key = String(item.collectionId || "");
      countByCollection.set(key, Number(countByCollection.get(key) || 0) + 1);
    });
    return state.playCollections
      .filter((item) => canReadOwner(item, auth) && item.hidden !== true)
      .map((collection) => ({
        ...collection,
        itemCount: Number(countByCollection.get(collection.id) || 0),
      }))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  function getCollection(state, auth, collectionId) {
    ensureShape(state);
    const collection = state.playCollections.find((item) => item.id === collectionId);
    if (!collection) throw new HttpError(404, "播放集合不存在");
    if (!canReadOwner(collection, auth)) throw new HttpError(403, "无权限访问该集合");
    return collection;
  }

  function collectionIsAssignedToDevice(collection = {}, device = {}) {
    const collectionId = String(collection.id || "");
    const deviceId = String(device.id || "");
    if (!collectionId || !deviceId) return false;
    if (String(device.currentCollectionId || "") === collectionId) return true;
    if (String(device.lastDisplayCollectionId || "") === collectionId) return true;
    const explicitIds = [
      ...(Array.isArray(collection.targetDeviceIds) ? collection.targetDeviceIds : []),
      ...(Array.isArray(collection.deviceIds) ? collection.deviceIds : []),
      ...(Array.isArray(collection.assignedDeviceIds) ? collection.assignedDeviceIds : []),
    ].map((item) => String(item || ""));
    return explicitIds.includes(deviceId);
  }

  function getDeviceCollection(state, auth, collectionId, device) {
    ensureShape(state);
    const collection = state.playCollections.find((item) => item.id === collectionId);
    if (!collection) throw new HttpError(404, "播放集合不存在");
    if (
      collection.isPublic ||
      String(collection.ownerId || "") === String(device.ownerId || "") ||
      collectionIsAssignedToDevice(collection, device)
    ) {
      return collection;
    }
    throw new HttpError(403, "设备无权限访问该集合");
  }

  function getWritableCollection(state, auth, collectionId) {
    const collection = getCollection(state, auth, collectionId);
    if (!canWriteOwner(collection, auth)) throw new HttpError(403, "无权限修改该集合");
    return collection;
  }

  function ensureImageAccess(state, auth, imageId) {
    const image = state.imageAssets.find((item) => item.id === imageId);
    if (!image) throw new HttpError(404, `图片不存在: ${imageId}`);
    if (!canReadOwner(image, auth)) throw new HttpError(403, "无权限访问图片");
    return image;
  }

  function createCollection(state, auth, payload = {}) {
    ensureShape(state);
    const collection = normalizeCollectionPayload(payload, auth, { now: clock, idFactory });
    state.playCollections.unshift(collection);
    return collection;
  }

  function patchCollection(state, auth, collectionId, payload = {}) {
    const collection = getWritableCollection(state, auth, collectionId);
    if (payload.name !== undefined) {
      const name = String(payload.name || "").trim();
      if (!name) throw new HttpError(400, "集合名称不能为空");
      collection.name = name;
    }
    if (payload.description !== undefined) collection.description = String(payload.description || "").trim();
    if (payload.coverImageId !== undefined) collection.coverImageId = String(payload.coverImageId || "");
    if (payload.playMode !== undefined) collection.playMode = String(payload.playMode || "slideshow").trim() || "slideshow";
    if (payload.slideIntervalSec !== undefined) {
      collection.slideIntervalSec = normalizePositiveSeconds(
        payload.slideIntervalSec,
        collection.slideIntervalSec || DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC
      );
    }
    if (payload.loopEnabled !== undefined) collection.loopEnabled = normalizeBool(payload.loopEnabled, true);
    if (payload.shuffleEnabled !== undefined) collection.shuffleEnabled = normalizeBool(payload.shuffleEnabled, false);
    if (payload.offlineSyncEnabled !== undefined) collection.offlineSyncEnabled = normalizeBool(payload.offlineSyncEnabled, true);
    if (payload.targetDeviceType !== undefined) collection.targetDeviceType = String(payload.targetDeviceType || "");
    if (payload.status !== undefined) collection.status = String(payload.status || "enabled");
    collection.version = Number(collection.version || 1) + 1;
    collection.updatedAt = clock();
    return collection;
  }

  function deleteCollection(state, auth, collectionId) {
    const collection = getWritableCollection(state, auth, collectionId);
    state.playCollections = state.playCollections.filter((item) => item.id !== collection.id);
    state.playCollectionItems = state.playCollectionItems.filter((item) => item.collectionId !== collection.id);
    const now = clock();
    state.devices.forEach((device) => {
      const wasCurrent = String(device.currentCollectionId || "") === collection.id;
      const wasLast = String(device.lastDisplayCollectionId || "") === collection.id;
      if (!wasCurrent && !wasLast) return;
      if (wasCurrent) device.currentCollectionId = "";
      if (wasLast) device.lastDisplayCollectionId = "";
      device.lastDisplayItemIndex = 0;
      if (String(device.currentPlayMode || "") === "album" && !device.currentCollectionId) {
        device.currentPlayMode = "";
      }
      device.updatedAt = now;
    });
    state.remoteCommandAcks.forEach((ack) => {
      const meta = ack && typeof ack.meta === "object" && !Array.isArray(ack.meta) ? ack.meta : {};
      const payload = meta.commandPayload && typeof meta.commandPayload === "object" ? meta.commandPayload : {};
      const ackCollectionId = String(meta.collectionId || payload.collectionId || "");
      if (String(ack.eventType || "") !== "collection.push" || ackCollectionId !== collection.id) return;
      if (!["pending", "ack_pending"].includes(String(ack.status || "pending"))) return;
      ack.status = "canceled";
      ack.ackStatus = "canceled";
      ack.ackMessage = "播放集合已删除";
      ack.updatedAt = now;
    });
    return { id: collection.id };
  }

  function listItems(state, auth, collectionId) {
    getCollection(state, auth, collectionId);
    const imageById = new Map(state.imageAssets.map((item) => [item.id, item]));
    const tfById = new Map(state.tfFiles.map((item) => [item.id, item]));
    return state.playCollectionItems
      .filter((item) => item.collectionId === collectionId)
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
      .map((item) => {
        const image = imageById.get(item.imageId) || {};
        const tfFileId = image.tfFileId || image.originalTfFileId || "";
        const tfFile = tfById.get(tfFileId) || {};
        const e6PreviewAsset = image.id
          ? state.e6RenderedAssets.find((asset) => asset.id && asset.id === image.e6AssetId && isReadyE6AssetForImage(asset, image)) ||
            state.e6RenderedAssets.find((asset) => asset.imageId === image.id && isReadyE6AssetForImage(asset, image)) ||
            findPlayableE6AssetByImageId(state, image.id)
          : findPlayableE6AssetByImageId(state, item.imageId);
        const e6PreviewTf = e6PreviewAsset?.previewTfFileId ? tfById.get(e6PreviewAsset.previewTfFileId) : null;
        const originalPreviewUrl = tfFile.id ? `/api/tf/${tfFile.id}/download` : "";
        const e6PreviewUrl = e6PreviewTf?.id ? `/api/tf/${e6PreviewTf.id}/download` : "";
        const previewUrl = e6PreviewUrl || originalPreviewUrl;
        return {
          ...item,
          name: image.originalName || tfFile.originalName || item.imageId,
          originalName: image.originalName || tfFile.originalName || "",
          mime: image.mime || tfFile.mime || "",
          size: Number(image.size || tfFile.size || 0),
          status: image.status || (e6PreviewAsset ? "ready" : ""),
          path: image.sourcePath || "",
          thumbnailUrl: previewUrl,
          previewUrl,
          originalPreviewUrl,
          e6PreviewUrl,
          e6PreviewTfFileId: e6PreviewTf?.id || "",
          isImage: isImageLike(image, tfFile) || Boolean(e6PreviewAsset),
        };
      });
  }

  function setItems(state, auth, collectionId, items = []) {
    const collection = getWritableCollection(state, auth, collectionId);
    if (!Array.isArray(items)) throw new HttpError(400, "items必须是数组");
    const normalized = items.map((item, index) => {
      const row = normalizeItemPayload(
        {
          ...item,
          sortOrder: item.sortOrder !== undefined ? item.sortOrder : index + 1,
        },
        collection.id,
        { now: clock, idFactory }
      );
      ensureImageAccess(state, auth, row.imageId);
      return row;
    });
    state.playCollectionItems = state.playCollectionItems.filter((item) => item.collectionId !== collection.id);
    state.playCollectionItems.push(...normalized);
    collection.coverImageId = collection.coverImageId || normalized[0]?.imageId || "";
    collection.version = Number(collection.version || 1) + 1;
    collection.updatedAt = clock();
    return listItems(state, auth, collection.id);
  }

  function buildMergedCollectionName(mergedId) {
    const stamp = String(clock()).slice(0, 10).replace(/-/g, "");
    const suffix = String(mergedId || "").replace(/^merged_?/, "").slice(-6) || "temp";
    return `多集合播放-${stamp}-${suffix}`;
  }

  function createMergedPlayCollection(state, auth, payload = {}) {
    ensureShape(state);
    if (!Array.isArray(payload.collectionIds)) throw new HttpError(400, "collectionIds必须是非空数组");
    const sourceCollectionIds = payload.collectionIds.map((item) => String(item || "").trim()).filter(Boolean);
    if (!sourceCollectionIds.length) throw new HttpError(400, "collectionIds不能为空");

    const sourceCollections = sourceCollectionIds.map((collectionId) => {
      const collection = state.playCollections.find((item) => String(item.id || "") === collectionId);
      if (!collection) throw new HttpError(404, `源集合不存在: ${collectionId}`);
      if (!canReadOwner(collection, auth)) throw new HttpError(403, `无权限访问源集合: ${collectionId}`);
      return collection;
    });

    const ownerId = isAdmin(auth)
      ? String(payload.ownerId || sourceCollections[0]?.ownerId || ownerIdOf(auth) || "").trim()
      : ownerIdOf(auth);
    if (!ownerId) throw new HttpError(400, "ownerId不能为空");

    const now = clock();
    const mergedId = idFactory("merged");
    const dedupe = normalizeBool(payload.dedupe, true);
    const seenKeys = new Set();
    const mergedItems = [];

    sourceCollections.forEach((collection) => {
      state.playCollectionItems
        .filter((item) => String(item.collectionId || "") === String(collection.id || "") && item.enabled !== false)
        .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
        .forEach((item) => {
          const image = ensureImageAccess(state, auth, item.imageId);
          const dedupeKey = String(image.id || item.imageId || item.imageUrl || image.url || item.url || "").trim();
          if (dedupe && dedupeKey && seenKeys.has(dedupeKey)) return;
          if (dedupe && dedupeKey) seenKeys.add(dedupeKey);
          const order = mergedItems.length;
          mergedItems.push({
            id: idFactory("coli"),
            collectionId: mergedId,
            sourceCollectionId: collection.id,
            sourceItemId: String(item.id || ""),
            imageId: String(item.imageId || ""),
            imageUrl: String(item.imageUrl || image.url || ""),
            sortOrder: order + 1,
            order,
            durationSec: Math.max(0, Number(item.durationSec || 0)),
            enabled: item.enabled !== false,
            createdAt: now,
          });
        });
    });

    if (!mergedItems.length) throw new HttpError(400, "所选集合中没有可播放图片");

    const firstCollection = sourceCollections[0] || {};
    const collection = {
      id: mergedId,
      ownerId,
      name: String(payload.name || "").trim() || buildMergedCollectionName(mergedId),
      description: String(payload.description || "由多个播放集合自动合并生成").trim(),
      type: "merged",
      hidden: true,
      isSystemMerged: true,
      sourceCollectionIds,
      coverImageId: mergedItems[0]?.imageId || "",
      playMode: "slideshow",
      slideIntervalSec: normalizePositiveSeconds(payload.slideIntervalSec, DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC),
      loopEnabled: payload.loopEnabled !== undefined ? normalizeBool(payload.loopEnabled, true) : firstCollection.loopEnabled !== false,
      shuffleEnabled: false,
      offlineSyncEnabled:
        payload.offlineSyncEnabled !== undefined
          ? normalizeBool(payload.offlineSyncEnabled, true)
          : firstCollection.offlineSyncEnabled !== false,
      targetDeviceType: String(payload.targetDeviceType || firstCollection.targetDeviceType || ""),
      status: "enabled",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    state.playCollections.unshift(collection);
    state.playCollectionItems.push(...mergedItems);
    return {
      ...collection,
      items: mergedItems,
      itemCount: mergedItems.length,
    };
  }

  function hardwarePath(path = "") {
    const value = String(path || "");
    return value.startsWith("/") ? value : `/${value}`;
  }

  function buildManifestItem(state, image, item, deviceType) {
    if (deviceType === "e6-color-frame") {
      const imageId = String(image?.id || item?.imageId || "");
      const e6Asset =
        (image?.id
          ? state.e6RenderedAssets.find((asset) => asset.id && asset.id === image.e6AssetId && isReadyE6AssetForImage(asset, image)) ||
            state.e6RenderedAssets.find((asset) => asset.imageId === image.id && isReadyE6AssetForImage(asset, image))
          : null) || findPlayableE6AssetByImageId(state, imageId);
      if (!e6Asset || !e6Asset.binaryTfFileId) {
        throw new HttpError(409, `图片尚未生成E6文件: ${imageId}`);
      }
      const tfFile = state.tfFiles.find((file) => file.id === e6Asset.binaryTfFileId);
      if (!tfFile) throw new HttpError(409, `E6文件不存在: ${imageId}`);
      return {
        imageId,
        sortOrder: Number(item.sortOrder || 0),
        name: tfFile.originalName || `${imageId}.e6p4`,
        format: "e6p4",
        downloadUrl: hardwarePath(`/api/hardware/tf/download/${tfFile.id}`),
        sha256: e6Asset.binarySha256 || tfFile.sha256 || "",
        size: Number(e6Asset.binarySize || tfFile.size || 0),
      };
    }

    const tfFileId = image.tfFileId || image.originalTfFileId || "";
    const tfFile = state.tfFiles.find((file) => file.id === tfFileId);
    return {
      imageId: image.id,
      sortOrder: Number(item.sortOrder || 0),
      name: image.originalName || tfFile?.originalName || image.id,
      format: image.mime || tfFile?.mime || "image/*",
      downloadUrl: tfFile ? hardwarePath(`/api/hardware/tf/download/${tfFile.id}`) : "",
      sha256: image.sha256 || tfFile?.sha256 || "",
      size: Number(image.size || tfFile?.size || 0),
    };
  }

  function buildManifest(state, auth, params = {}) {
    ensureShape(state);
    const device = state.devices.find((item) => item.id === String(params.deviceId || ""));
    if (!device) throw new HttpError(404, "设备不存在");
    if (!canReadOwner(device, auth) && auth?.role !== "device") throw new HttpError(403, "无权限访问该设备");
    if (auth?.role === "device" && String(auth.deviceId || "") !== device.id) {
      throw new HttpError(403, "设备无权限访问该集合");
    }
    const collection =
      auth?.role === "device"
        ? getDeviceCollection(state, auth, String(params.collectionId || ""), device)
        : getCollection(state, auth, String(params.collectionId || ""));
    const deviceType = String(device.type || collection.targetDeviceType || "ink-screen");
    const enabledItems = state.playCollectionItems
      .filter((item) => item.collectionId === collection.id && item.enabled !== false)
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
    const skipInvalidItems = Boolean(params.skipInvalidItems);
    const skippedItems = [];
    const items = [];
    enabledItems.forEach((item) => {
      try {
        let image = null;
        try {
          image = ensureImageAccess(state, auth?.role === "device" ? { role: "admin" } : auth, item.imageId);
        } catch (error) {
          if (deviceType !== "e6-color-frame" || !findPlayableE6AssetByImageId(state, item.imageId)) throw error;
          image = { id: String(item.imageId || ""), originalName: String(item.imageId || "") };
        }
        const manifestItem = buildManifestItem(state, image, item, deviceType);
        if (!manifestItem.downloadUrl || !Number(manifestItem.size || 0)) {
          throw new HttpError(409, `图片没有可下载资源: ${item.imageId}`);
        }
        items.push(manifestItem);
      } catch (error) {
        if (!skipInvalidItems) throw error;
        skippedItems.push({
          imageId: String(item.imageId || ""),
          sortOrder: Number(item.sortOrder || 0),
          status: Number(error?.status || 500),
          reason: error?.message || String(error || "manifest item invalid"),
        });
      }
    });
    const version = Number(collection.version || 1);
    const requestedVersion = Number(params.version ?? params.localVersion ?? 0);
    return {
      ok: true,
      unchanged: Number.isFinite(requestedVersion) && requestedVersion > 0 && requestedVersion === version,
      deviceType,
      collectionId: collection.id,
      version,
      name: collection.name,
      playMode: collection.playMode || "slideshow",
      slideIntervalSec: Number(collection.slideIntervalSec || DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC),
      loopEnabled: collection.loopEnabled !== false,
      shuffleEnabled: Boolean(collection.shuffleEnabled),
      offlineSyncEnabled: collection.offlineSyncEnabled !== false,
      generatedAt: clock(),
      items,
      skippedItems,
      skippedItemCount: skippedItems.length,
    };
  }

  function buildPushEvent(state, auth, params = {}) {
    const collection = getCollection(state, auth, String(params.collectionId || ""));
    const device = state.devices.find((item) => item.id === String(params.deviceId || ""));
    if (!device) throw new HttpError(404, "设备不存在");
    if (!canReadOwner(device, auth)) throw new HttpError(403, "无权限访问该设备");
    const commandId = String(params.commandId || "").trim();
    return {
      type: "collection.push",
      deviceId: device.id,
      payload: {
        ...(commandId ? { commandId } : {}),
        deviceType: device.type || collection.targetDeviceType || "ink-screen",
        collectionId: collection.id,
        manifestUrl: hardwarePath(`/api/hardware/collections/${encodeURIComponent(collection.id)}/manifest?deviceId=${encodeURIComponent(device.id)}`),
        version: Number(collection.version || 1),
      },
    };
  }

  return {
    listCollections,
    getCollection,
    getWritableCollection,
    listItems,
    createCollection,
    patchCollection,
    deleteCollection,
    setItems,
    createMergedPlayCollection,
    buildManifest,
    buildPushEvent,
  };
}

module.exports = {
  DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC,
  createPlayCollectionService,
  canReadOwner,
  canWriteOwner,
};
