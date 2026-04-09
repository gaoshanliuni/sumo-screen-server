const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess, resolveTargetDeviceIds } = require("../utils/access");
const { logOperation } = require("../utils/logging");
const { publishDeviceEvent } = require("../utils/realtime.hub");
const { getGridBucket } = require("../utils/mongo");
const { createPendingAck, waitForAckMap } = require("../utils/remoteAck");

const router = express.Router();
router.use(allowRoles("admin", "user"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const CATEGORY_SET = new Set(["fonts", "read", "photo", "update", "background", "config"]);
const TEXT_MIN_SECONDS = 10;
const TEXT_MAX_SECONDS = 7 * 24 * 60 * 60;
const SWITCH_VIEW_CANONICAL = new Set(["home", "weather", "badge", "todo", "settings", "network", "about"]);
const PAGE_TYPE_SET = new Set(["homepage", "weatherpage", "badgepage", "todo", "settings", "network", "about"]);

function normalizeSwitchViewAlias(view) {
  const v = String(view || "").trim().toLowerCase();
  if (!v) return "";
  if (v === "homepage") return "home";
  if (v === "weatherpage") return "weather";
  if (v === "badgepage" || v === "nameplate") return "badge";
  if (v === "reader") return "home";
  if (v === "file") return "network";
  return v;
}

function normalizeDuration(body = {}) {
  if (body.durationSec !== undefined) {
    const sec = Number(body.durationSec || 0);
    if (!Number.isFinite(sec)) throw new HttpError(400, "durationSec格式不正确");
    return Math.floor(sec);
  }
  const value = Number(body.durationValue || 0);
  const unit = String(body.durationUnit || "minute").toLowerCase();
  if (!Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, "durationValue格式不正确");
  }
  const multipliers = {
    minute: 60,
    minutes: 60,
    hour: 3600,
    hours: 3600,
    day: 86400,
    days: 86400,
  };
  const factor = multipliers[unit] || 60;
  return Math.floor(value * factor);
}

async function getBucket() {
  return await getGridBucket("tf_files");
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function saveRemoteFile({ ownerId, category, fileName, buffer, mime }) {
  if (!CATEGORY_SET.has(category)) {
    throw new HttpError(400, "category不合法");
  }
  const now = new Date().toISOString();
  const recordId = createId("tf");
  const filename = `${recordId}_${fileName}`;
  const hash = sha256Hex(buffer);
  const bucket = await getBucket();
  const uploadStream = bucket.openUploadStream(filename, {
    contentType: mime || "application/octet-stream",
    metadata: {
      ownerId,
      category,
      originalName: fileName,
      source: "remote",
      sha256: hash,
    },
  });

  const gridId = await new Promise((resolve, reject) => {
    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(uploadStream.id));
    uploadStream.end(buffer);
  });

  const record = {
    id: recordId,
    ownerId,
    category,
    name: filename,
    originalName: fileName,
    size: buffer.length,
    mime: mime || "",
    gridId: String(gridId),
    url: `/api/tf/${recordId}/download`,
    sha256: hash,
    createdAt: now,
    updatedAt: now,
  };

  await updateDB((draft) => {
    draft.tfFiles.unshift(record);
  });

  return record;
}

function getOwnerId(device, auth) {
  if (device?.ownerId) return device.ownerId;
  return auth.userId || "";
}

function normalizeIdList(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return [];
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return [...new Set(parsed.map((item) => String(item || "").trim()).filter(Boolean))];
        }
      } catch (_) {
        // ignore
      }
    }
    return [...new Set(text.split(",").map((item) => String(item || "").trim()).filter(Boolean))];
  }
  return [];
}

function sampleRandomIds(list, count) {
  if (!Number.isFinite(count) || count <= 0 || count >= list.length) return [...list];
  const next = [...list];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next.slice(0, count);
}

function resolveBatchTargets(db, auth, body = {}) {
  const singleId = String(body.deviceId || "").trim();
  const deviceIds = normalizeIdList(body.deviceIds);
  const clusterIds = normalizeIdList(body.clusterIds);
  const randomCountRaw = Number(body.randomCount || 0);

  const merged = new Set(resolveTargetDeviceIds(db, deviceIds, clusterIds));
  if (singleId) merged.add(singleId);

  if (merged.size === 0) {
    throw new HttpError(400, "至少提供一个目标设备");
  }

  const denied = [];
  const accessible = [];
  [...merged].forEach((id) => {
    try {
      ensureDeviceAccess(db, auth, id);
      accessible.push(id);
    } catch (error) {
      denied.push({ deviceId: id, reason: error?.message || "无权限或设备不存在" });
    }
  });

  const randomCount = Number.isFinite(randomCountRaw) && randomCountRaw > 0 ? Math.floor(randomCountRaw) : 0;
  const sampled = sampleRandomIds(accessible, randomCount);
  return {
    targetIds: sampled,
    denied,
    requestedCount: merged.size,
  };
}

function buildBatchResult({ requestedCount, denied, success, failed }) {
  return {
    total: requestedCount,
    successCount: success.length,
    failedCount: denied.length + failed.length,
    successDeviceIds: success.map((item) => item.deviceId),
    failed: [...denied, ...failed],
    results: success,
  };
}

async function createCommandAck({ deviceId, eventType, source, auth, meta }) {
  let row = null;
  await updateDB((draft) => {
    row = createPendingAck(draft, {
      deviceId,
      eventType,
      source,
      operatorId: auth?.userId || "",
      operatorRole: auth?.role || "",
      meta,
    });
  });
  return row;
}

const MAX_ACK_WAIT_MS = 30000;

function getAckWaitMs(body) {
  const raw = Number(body?.ackTimeoutMs);
  if (!Number.isFinite(raw)) return 2800;
  if (raw < 0) return 0;
  if (raw > MAX_ACK_WAIT_MS) return MAX_ACK_WAIT_MS;
  return Math.floor(raw);
}

async function buildAckedResponse({ req, target, sentSuccess, sendFailed }) {
  const waitMs = getAckWaitMs(req.body || {});
  const commandIds = sentSuccess.map((item) => String(item.commandId || "").trim()).filter(Boolean);
  const ackMap = commandIds.length ? await waitForAckMap({ readDB, commandIds, timeoutMs: waitMs }) : new Map();

  const finalSuccess = [];
  const ackFailed = [];
  const ackPending = [];

  for (const item of sentSuccess) {
    const ack = ackMap.get(String(item.commandId || "")) || { state: "pending", status: "pending", message: "" };
    const row = {
      ...item,
      ackState: ack.state,
      ackStatus: ack.status,
      ackMessage: ack.message || "",
    };
    if (ack.state === "success") {
      finalSuccess.push(row);
    } else if (ack.state === "failed") {
      ackFailed.push({ deviceId: item.deviceId, reason: row.ackMessage || "设备执行失败", commandId: item.commandId });
    } else {
      ackPending.push({
        deviceId: item.deviceId,
        reason: `设备未确认(${waitMs}ms)`,
        commandId: item.commandId,
      });
    }
  }

  const result = buildBatchResult({
    requestedCount: target.requestedCount,
    denied: target.denied,
    success: finalSuccess,
    failed: [...sendFailed, ...ackFailed, ...ackPending],
  });

  result.sentCount = sentSuccess.length;
  result.sentDeviceIds = sentSuccess.map((x) => x.deviceId);
  result.ackedSuccessCount = finalSuccess.length;
  result.ackedFailedCount = ackFailed.length;
  result.ackedPendingCount = ackPending.length;
  result.ackTimeoutMs = waitMs;
  return result;
}

router.post(
  "/switch-view",
  asyncHandler(async (req, res) => {
    const { view = "", saveToTf = true, setAsDefault = false } = req.body || {};
    const viewValue = normalizeSwitchViewAlias(view);
    if (!viewValue) throw new HttpError(400, "view不能为空");
    if (!SWITCH_VIEW_CANONICAL.has(viewValue)) {
      throw new HttpError(400, "view不支持，允许: home/weather/badge/todo/settings/network/about（兼容: homepage/weatherpage/badgepage）");
    }

    const db = await readDB();
    const target = resolveBatchTargets(db, req.auth, req.body || {});
    if (target.targetIds.length === 0) {
      return res.success(buildBatchResult({ requestedCount: target.requestedCount, denied: target.denied, success: [], failed: [] }), "没有可下发设备");
    }

    const sentSuccess = [];
    const failed = [];
    const fileByOwner = new Map();

    if (setAsDefault) {
      await updateDB((draft) => {
        target.targetIds.forEach((deviceId) => {
          const device = draft.devices.find((item) => item.id === deviceId);
          if (device) {
            device.defaultView = String(viewValue);
            device.updatedAt = new Date().toISOString();
          }
        });
      });
    }

    for (const deviceId of target.targetIds) {
      const device = db.devices.find((item) => item.id === deviceId);
      if (!device) {
        failed.push({ deviceId, reason: "设备不存在" });
        continue;
      }
      const ownerId = getOwnerId(device, req.auth);
      try {
        let saved = null;
        if (saveToTf && ownerId) {
          if (!fileByOwner.has(ownerId)) {
            const fileName = `remote_controls/view_${new Date().toISOString().replace(/[:.]/g, "")}.json`;
            const payload = JSON.stringify({ type: "switch_view", view: viewValue, createdAt: new Date().toISOString() });
            const record = await saveRemoteFile({
              ownerId,
              category: "config",
              fileName,
              buffer: Buffer.from(payload, "utf-8"),
              mime: "application/json",
            });
            fileByOwner.set(ownerId, record);
          }
          saved = fileByOwner.get(ownerId) || null;
        }

        const command = await createCommandAck({
          deviceId,
          eventType: "remote.switch_view",
          source: "remote.switch_view",
          auth: req.auth,
          meta: { view: viewValue },
        });

        publishDeviceEvent({
          type: "remote.switch_view",
          deviceId,
          payload: {
            commandId: command.commandId,
            view: viewValue,
            setAsDefault: Boolean(setAsDefault),
            file: saved ? { id: saved.id, url: saved.url, name: saved.originalName } : null,
          },
        });

        sentSuccess.push({
          deviceId,
          commandId: command.commandId,
          view: viewValue,
          file: saved
            ? {
                id: saved.id,
                name: saved.originalName || saved.name,
                url: saved.url,
              }
            : null,
          setAsDefault: Boolean(setAsDefault),
        });
      } catch (error) {
        failed.push({ deviceId, reason: error?.message || "下发失败" });
      }
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "remote.switch_view",
      targetType: "device_batch",
      targetId: `count:${target.targetIds.length}`,
      detail: {
        view: viewValue,
        setAsDefault: Boolean(setAsDefault),
        requestedCount: target.requestedCount,
        successCount: sentSuccess.length,
      },
    });

    const result = await buildAckedResponse({ req, target, sentSuccess, sendFailed: failed });
    res.success(result, result.ackedSuccessCount > 0 ? "切换指令已确认" : "切换指令未获设备确认");
  })
);

router.post(
  "/refresh-page-image",
  asyncHandler(async (req, res) => {
    const pageType = String(req.body?.pageType || "homepage").trim().toLowerCase();
    if (!PAGE_TYPE_SET.has(pageType)) {
      throw new HttpError(400, "pageType不支持，允许: homepage/weatherpage/badgepage/todo/settings/network/about");
    }

    const db = await readDB();
    const target = resolveBatchTargets(db, req.auth, req.body || {});
    if (target.targetIds.length === 0) {
      return res.success(buildBatchResult({ requestedCount: target.requestedCount, denied: target.denied, success: [], failed: [] }), "没有可下发设备");
    }

    const sentSuccess = [];
    const failed = [];
    for (const deviceId of target.targetIds) {
      try {
        const command = await createCommandAck({
          deviceId,
          eventType: "remote.refresh_page_image",
          source: "remote.refresh_page_image",
          auth: req.auth,
          meta: { pageType },
        });

        publishDeviceEvent({
          type: "remote.refresh_page_image",
          deviceId,
          payload: {
            commandId: command.commandId,
            pageType,
            requestedAt: new Date().toISOString(),
          },
        });

        sentSuccess.push({
          deviceId,
          commandId: command.commandId,
          pageType,
        });
      } catch (error) {
        failed.push({ deviceId, reason: error?.message || "下发失败" });
      }
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "remote.refresh_page_image",
      targetType: "device_batch",
      targetId: `count:${target.targetIds.length}`,
      detail: {
        pageType,
        requestedCount: target.requestedCount,
        successCount: sentSuccess.length,
      },
    });

    const result = await buildAckedResponse({ req, target, sentSuccess, sendFailed: failed });
    res.success(result, result.ackedSuccessCount > 0 ? "刷新图片指令已确认" : "刷新图片指令未获设备确认");
  })
);

router.post(
  "/request-screen-state",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const target = resolveBatchTargets(db, req.auth, req.body || {});
    if (target.targetIds.length === 0) {
      return res.success(buildBatchResult({ requestedCount: target.requestedCount, denied: target.denied, success: [], failed: [] }), "没有可下发设备");
    }

    const include = Array.isArray(req.body?.include)
      ? req.body.include.map((v) => String(v || "").trim()).filter(Boolean)
      : [];
    const sentSuccess = [];
    const failed = [];
    for (const deviceId of target.targetIds) {
      try {
        const command = await createCommandAck({
          deviceId,
          eventType: "remote.request_screen_state",
          source: "remote.request_screen_state",
          auth: req.auth,
          meta: { include },
        });

        publishDeviceEvent({
          type: "remote.request_screen_state",
          deviceId,
          payload: {
            commandId: command.commandId,
            include,
            requestedAt: new Date().toISOString(),
          },
        });

        sentSuccess.push({
          deviceId,
          commandId: command.commandId,
          include,
        });
      } catch (error) {
        failed.push({ deviceId, reason: error?.message || "下发失败" });
      }
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "remote.request_screen_state",
      targetType: "device_batch",
      targetId: `count:${target.targetIds.length}`,
      detail: {
        requestedCount: target.requestedCount,
        successCount: sentSuccess.length,
      },
    });

    const result = await buildAckedResponse({ req, target, sentSuccess, sendFailed: failed });
    res.success(result, result.ackedSuccessCount > 0 ? "状态请求已确认" : "状态请求未获设备确认");
  })
);

router.post(
  "/show-text",
  asyncHandler(async (req, res) => {
    const { text = "", saveToTf = true } = req.body || {};
    const content = String(text || "").trim();
    if (!content) throw new HttpError(400, "text不能为空");

    const normalizedDuration = normalizeDuration(req.body || {});
    if (normalizedDuration < TEXT_MIN_SECONDS || normalizedDuration > TEXT_MAX_SECONDS) {
      throw new HttpError(400, "持续时间必须在10秒到7天之间");
    }
    const modeRaw = String(req.body?.announcementMode || req.body?.channel || "status").toLowerCase();
    const announcementMode = modeRaw === "fullscreen" ? "fullscreen" : "status";
    const hideInViews = Array.isArray(req.body?.hideInViews)
      ? req.body.hideInViews.map((x) => String(x || "").trim()).filter(Boolean)
      : [];

    const db = await readDB();
    const target = resolveBatchTargets(db, req.auth, req.body || {});
    if (target.targetIds.length === 0) {
      return res.success(buildBatchResult({ requestedCount: target.requestedCount, denied: target.denied, success: [], failed: [] }), "没有可下发设备");
    }
    const expiresAt = new Date(Date.now() + normalizedDuration * 1000).toISOString();

    const fileByOwner = new Map();
    const sentSuccess = [];
    const failed = [];

    for (const deviceId of target.targetIds) {
      const device = db.devices.find((item) => item.id === deviceId);
      if (!device) {
        failed.push({ deviceId, reason: "设备不存在" });
        continue;
      }
      const ownerId = getOwnerId(device, req.auth);
      try {
        let saved = null;
        if (saveToTf && ownerId) {
          if (!fileByOwner.has(ownerId)) {
            const fileName = `remote_controls/text_${new Date().toISOString().replace(/[:.]/g, "")}.txt`;
            const record = await saveRemoteFile({
              ownerId,
              category: "config",
              fileName,
              buffer: Buffer.from(content, "utf-8"),
              mime: "text/plain",
            });
            fileByOwner.set(ownerId, record);
          }
          saved = fileByOwner.get(ownerId) || null;
        }

        const command = await createCommandAck({
          deviceId,
          eventType: "remote.show_text",
          source: "remote.show_text",
          auth: req.auth,
          meta: { durationSec: normalizedDuration },
        });

        publishDeviceEvent({
          type: "remote.show_text",
          deviceId,
          payload: {
            commandId: command.commandId,
            text: content,
            durationSec: normalizedDuration,
            announcementMode,
            hideInViews,
            expiresAt,
            file: saved ? { id: saved.id, url: saved.url, name: saved.originalName } : null,
          },
        });

        sentSuccess.push({
          deviceId,
          commandId: command.commandId,
          durationSec: normalizedDuration,
          announcementMode,
          hideInViews,
          expiresAt,
          file: saved
            ? {
                id: saved.id,
                name: saved.originalName || saved.name,
                url: saved.url,
              }
            : null,
        });
      } catch (error) {
        failed.push({ deviceId, reason: error?.message || "下发失败" });
      }
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "remote.show_text",
      targetType: "device_batch",
      targetId: `count:${target.targetIds.length}`,
      detail: {
        durationSec: normalizedDuration,
        announcementMode,
        requestedCount: target.requestedCount,
        successCount: sentSuccess.length,
      },
    });

    const result = await buildAckedResponse({ req, target, sentSuccess, sendFailed: failed });
    res.success(result, result.ackedSuccessCount > 0 ? "文字下发已确认" : "文字下发未获设备确认");
  })
);

router.post(
  "/show-image",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const { saveToTf = true } = req.body || {};
    if (!req.file) throw new HttpError(400, "请先选择图片");

    const db = await readDB();
    const target = resolveBatchTargets(db, req.auth, req.body || {});
    if (target.targetIds.length === 0) {
      return res.success(buildBatchResult({ requestedCount: target.requestedCount, denied: target.denied, success: [], failed: [] }), "没有可下发设备");
    }

    const sentSuccess = [];
    const failed = [];
    const fileByOwner = new Map();

    for (const deviceId of target.targetIds) {
      const device = db.devices.find((item) => item.id === deviceId);
      if (!device) {
        failed.push({ deviceId, reason: "设备不存在" });
        continue;
      }

      const ownerId = getOwnerId(device, req.auth);
      try {
        let saved = null;
        if (saveToTf && ownerId) {
          if (!fileByOwner.has(ownerId)) {
            const suffix = req.file.originalname || "image.png";
            const fileName = `remote_controls/image_${new Date().toISOString().replace(/[:.]/g, "")}_${suffix}`;
            const record = await saveRemoteFile({
              ownerId,
              category: "photo",
              fileName,
              buffer: req.file.buffer,
              mime: req.file.mimetype,
            });
            fileByOwner.set(ownerId, record);
          }
          saved = fileByOwner.get(ownerId) || null;
        }

        const command = await createCommandAck({
          deviceId,
          eventType: "remote.show_image",
          source: "remote.show_image",
          auth: req.auth,
          meta: { fileName: req.file.originalname || "" },
        });

        publishDeviceEvent({
          type: "remote.show_image",
          deviceId,
          payload: {
            commandId: command.commandId,
            fileId: saved ? saved.id : "",
            downloadUrl: saved ? `/api/hardware/tf/download/${saved.id}` : "",
            mime: saved ? saved.mime : "",
            sha256: saved ? saved.sha256 || "" : "",
            file: saved ? { id: saved.id, url: saved.url, name: saved.originalName } : null,
          },
        });

        sentSuccess.push({
          deviceId,
          commandId: command.commandId,
          fileId: saved ? saved.id : "",
          downloadUrl: saved ? `/api/hardware/tf/download/${saved.id}` : "",
          mime: saved ? saved.mime : "",
          sha256: saved ? saved.sha256 || "" : "",
          file: saved
            ? {
                id: saved.id,
                name: saved.originalName || saved.name,
                url: saved.url,
              }
            : null,
        });
      } catch (error) {
        failed.push({ deviceId, reason: error?.message || "下发失败" });
      }
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "remote.show_image",
      targetType: "device_batch",
      targetId: `count:${target.targetIds.length}`,
      detail: {
        fileName: req.file.originalname || "",
        requestedCount: target.requestedCount,
        successCount: sentSuccess.length,
      },
    });

    const result = await buildAckedResponse({ req, target, sentSuccess, sendFailed: failed });
    res.success(result, result.ackedSuccessCount > 0 ? "图片下发已确认" : "图片下发未获设备确认");
  })
);

router.post(
  "/cast-frame",
  asyncHandler(async (req, res) => {
    const { deviceId, imageData = "", width = 0, height = 0 } = req.body || {};
    if (!deviceId) throw new HttpError(400, "deviceId不能为空");
    const data = String(imageData || "");
    if (!data.startsWith("data:image")) throw new HttpError(400, "imageData格式错误");
    if (data.length > 1500000) throw new HttpError(413, "帧数据过大");

    const db = await readDB();
    ensureDeviceAccess(db, req.auth, deviceId);

    publishDeviceEvent({
      type: "remote.cast_frame",
      deviceId,
      payload: { imageData: data, width: Number(width || 0), height: Number(height || 0) },
    });

    res.success({ ok: true }, "ok");
  })
);

router.post(
  "/cast-stop",
  asyncHandler(async (req, res) => {
    const { reason = "ended" } = req.body || {};

    const db = await readDB();
    const target = resolveBatchTargets(db, req.auth, req.body || {});
    if (target.targetIds.length === 0) {
      return res.success(buildBatchResult({ requestedCount: target.requestedCount, denied: target.denied, success: [], failed: [] }), "没有可下发设备");
    }

    const success = [];
    const failed = [];
    for (const deviceId of target.targetIds) {
      try {
        publishDeviceEvent({
          type: "remote.cast_stop",
          deviceId,
          payload: {
            reason: String(reason || "ended"),
            at: new Date().toISOString(),
          },
        });
        success.push({ deviceId, reason: String(reason || "ended") });
      } catch (error) {
        failed.push({ deviceId, reason: error?.message || "下发失败" });
      }
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "remote.cast_stop",
      targetType: "device_batch",
      targetId: `count:${target.targetIds.length}`,
      detail: {
        reason: String(reason || "ended"),
        requestedCount: target.requestedCount,
        successCount: success.length,
      },
    });

    res.success(buildBatchResult({ requestedCount: target.requestedCount, denied: target.denied, success, failed }), "ok");
  })
);

module.exports = router;
