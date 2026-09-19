const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDBOptimistic } = require("../db/store");
const { publishDeviceEvent } = require("../utils/realtime.hub");
const { createPendingAck, waitForAckMap } = require("../utils/remoteAck");
const { createPlayCollectionService } = require("../services/play_collection.service");
const { ensureCollectionE6AssetsReady } = require("../services/e6/e6_asset_retry.service");
const HttpError = require("../utils/httpError");

const router = express.Router();
router.use(allowRoles("admin", "user"));

const collectionService = createPlayCollectionService();
const COLLECTION_ACK_WAIT_DEFAULT_MS = 5000;
const COLLECTION_ACK_WAIT_MAX_MS = 30000;

function getAckWaitMs(body) {
  const raw = Number(body?.ackTimeoutMs);
  if (!Number.isFinite(raw)) return COLLECTION_ACK_WAIT_DEFAULT_MS;
  if (raw < 0) return 0;
  return Math.min(COLLECTION_ACK_WAIT_MAX_MS, Math.floor(raw));
}

function validatePushManifests(db, auth, collectionId, deviceIds) {
  return deviceIds.map((deviceId) =>
    collectionService.buildManifest(db, auth, {
      collectionId,
      deviceId,
    })
  );
}

function normalizePushDeviceIds(body = {}, query = {}) {
  const rawDeviceIds = Array.isArray(body?.deviceIds)
    ? body.deviceIds
    : [body?.deviceId || query.deviceId || ""];
  const deviceIds = [...new Set(rawDeviceIds.map((item) => String(item || "").trim()).filter(Boolean))];
  if (!deviceIds.length) throw new HttpError(400, "deviceIds不能为空");
  return deviceIds;
}

async function buildCollectionPushResponse(req, sentEvents) {
  const waitMs = getAckWaitMs(req.body || {});
  const commandIds = sentEvents.map((event) => String(event.payload?.commandId || "").trim()).filter(Boolean);
  const ackMap = commandIds.length ? await waitForAckMap({ readDB, commandIds, timeoutMs: waitMs }) : new Map();
  let ackedSuccessCount = 0;
  let ackedFailedCount = 0;
  let ackedPendingCount = 0;
  const results = sentEvents.map((event) => {
    const commandId = String(event.payload?.commandId || "").trim();
    const ack = ackMap.get(commandId) || { state: "pending", status: "pending", message: "" };
    if (ack.state === "success") ackedSuccessCount += 1;
    else if (ack.state === "failed") ackedFailedCount += 1;
    else ackedPendingCount += 1;
    return {
      deviceId: event.deviceId,
      commandId,
      collectionId: event.payload?.collectionId || "",
      ackState: ack.state,
      ackStatus: ack.status,
      ackMessage: ack.message || "",
    };
  });
  return {
    count: sentEvents.length,
    sentCount: sentEvents.length,
    ackedSuccessCount,
    ackedFailedCount,
    ackedPendingCount,
    ackTimeoutMs: waitMs,
    results,
    events: sentEvents,
  };
}

async function pushCollectionToDevices(req, collectionId, deviceIds, options = {}) {
  let db = await readDB();
  deviceIds.forEach((deviceId) => {
    collectionService.buildPushEvent(db, req.auth, {
      collectionId,
      deviceId,
    });
  });
  const e6Result = await ensureCollectionE6AssetsReady({
    collectionId,
    deviceIds,
    auth: req.auth,
  });
  db = await readDB();
  validatePushManifests(db, req.auth, collectionId, deviceIds);
  const now = new Date().toISOString();
  const events = [];
  await updateDBOptimistic((draft) => {
    draft.devices = Array.isArray(draft.devices) ? draft.devices : [];
    deviceIds.forEach((deviceId) => {
      const command = createPendingAck(draft, {
        deviceId,
        eventType: "collection.push",
        source: options.source || "play_collection.push",
        operatorId: req.auth?.userId || "",
        operatorRole: req.auth?.role || "",
        meta: {
          collectionId,
        },
      });
      const event = collectionService.buildPushEvent(draft, req.auth, {
        collectionId,
        deviceId,
        commandId: command.commandId,
      });
      command.meta.commandPayload = { ...event.payload };
      events.push(event);
      const device = draft.devices.find((item) => item.id === event.deviceId);
      if (!device) return;
      device.currentPlayMode = "album";
      device.currentCollectionId = collectionId;
      device.lastDisplayCollectionId = collectionId;
      device.lastDisplayItemIndex = 0;
      device.currentCollectionPushedAt = now;
      device.updatedAt = now;
    });
  });
  events.forEach((event) => publishDeviceEvent(event));
  const response = await buildCollectionPushResponse(req, events);
  response.e6ConvertedCount = e6Result.convertedCount || 0;
  response.e6BrokenImageCount = e6Result.brokenImageCount || 0;
  if (e6Result.brokenImages && e6Result.brokenImages.length) {
    response.e6BrokenImages = e6Result.brokenImages;
  }
  return response;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(collectionService.listCollections(db, req.auth), "ok");
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    let created = null;
    await updateDBOptimistic((draft) => {
      created = collectionService.createCollection(draft, req.auth, req.body || {});
    });
    res.success(created, "播放集合已创建", 201);
  })
);

router.post(
  "/merged-push",
  asyncHandler(async (req, res) => {
    const deviceIds = normalizePushDeviceIds(req.body || {}, req.query || {});
    let merged = null;
    await updateDBOptimistic((draft) => {
      merged = collectionService.createMergedPlayCollection(draft, req.auth, req.body || {});
    });
    const pushResult = await pushCollectionToDevices(req, merged.id, deviceIds, {
      source: "play_collection.merged_push",
    });
    const devices = pushResult.results.map((item) => ({
      deviceId: item.deviceId,
      ok: item.ackState !== "failed",
      acked: item.ackState === "success",
      ackState: item.ackState,
      ackStatus: item.ackStatus,
      ackMessage: item.ackMessage,
      commandId: item.commandId,
    }));
    res.success(
      {
        success: true,
        mergedCollectionId: merged.id,
        sourceCollectionIds: merged.sourceCollectionIds,
        itemCount: Number(merged.itemCount || merged.items?.length || 0),
        devices,
        ...pushResult,
      },
      pushResult.ackedSuccessCount > 0 ? "合并播放清单已确认" : "合并播放清单已下发，设备未确认"
    );
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const collection = collectionService.getCollection(db, req.auth, req.params.id);
    const items = collectionService.listItems(db, req.auth, collection.id);
    res.success({ ...collection, items }, "ok");
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    let updated = null;
    await updateDBOptimistic((draft) => {
      updated = collectionService.patchCollection(draft, req.auth, req.params.id, req.body || {});
    });
    res.success(updated, "播放集合已更新");
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    let output = null;
    await updateDBOptimistic((draft) => {
      output = collectionService.deleteCollection(draft, req.auth, req.params.id);
    });
    res.success(output, "播放集合已删除");
  })
);

router.put(
  "/:id/items",
  asyncHandler(async (req, res) => {
    let output = null;
    await updateDBOptimistic((draft) => {
      output = collectionService.setItems(draft, req.auth, req.params.id, req.body?.items || []);
    });
    res.success(output, "集合图片已保存");
  })
);

router.post(
  "/:id/items",
  asyncHandler(async (req, res) => {
    let output = null;
    await updateDBOptimistic((draft) => {
      const existing = collectionService.listItems(draft, req.auth, req.params.id);
      const additions = Array.isArray(req.body?.items) ? req.body.items : [];
      output = collectionService.setItems(draft, req.auth, req.params.id, [...existing, ...additions]);
    });
    res.success(output, "集合图片已添加");
  })
);

router.get(
  "/:id/manifest",
  asyncHandler(async (req, res) => {
    await ensureCollectionE6AssetsReady({
      collectionId: req.params.id,
      deviceIds: [String(req.query.deviceId || "")],
      auth: req.auth,
    });
    const db = await readDB();
    const manifest = collectionService.buildManifest(db, req.auth, {
      collectionId: req.params.id,
      deviceId: String(req.query.deviceId || ""),
      version: req.query.version ?? req.query.localVersion ?? req.query.local_version,
    });
    res.success(manifest, "ok");
  })
);

router.post(
  "/:id/push",
  asyncHandler(async (req, res) => {
    const deviceIds = normalizePushDeviceIds(req.body || {}, req.query || {});
    const result = await pushCollectionToDevices(req, req.params.id, deviceIds);
    res.success(result, result.ackedSuccessCount > 0 ? "集合播放已确认" : "集合已下发，设备未确认");
  })
);

module.exports = router;
