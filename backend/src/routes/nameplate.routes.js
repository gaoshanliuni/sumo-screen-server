const express = require("express");
const crypto = require("crypto");
const Jimp = require("jimp");
const { createCanvas } = require("@napi-rs/canvas");

const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess, resolveTargetDeviceIds } = require("../utils/access");
const { publishDeviceEvent } = require("../utils/realtime.hub");
const { logOperation } = require("../utils/logging");
const { getGridBucket } = require("../utils/mongo");
const { createPendingAck, waitForAckMap } = require("../utils/remoteAck");
const { buildCommonDataModel, interpolateForTemplate } = require("../services/page_profile.service");

const router = express.Router();
router.use(allowRoles("admin", "user"));

const CATEGORY_SET = new Set(["fonts", "read", "photo", "update", "background", "config"]);
const DEVICE_TYPE_RESOLUTION = {
  "ink-screen": { width: 2560, height: 1600 },
  "4d_systems_esp32s3_gen4_r8n16": { width: 2560, height: 1600 },
  "epd-13.3": { width: 1600, height: 1200 },
};

const FONT_KEYS = {
  8: Jimp.FONT_SANS_8_BLACK,
  16: Jimp.FONT_SANS_16_BLACK,
  32: Jimp.FONT_SANS_32_BLACK,
  64: Jimp.FONT_SANS_64_BLACK,
  128: Jimp.FONT_SANS_128_BLACK,
};

const fontCache = new Map();

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
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
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
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

function getAckWaitMs(input) {
  const raw = Number(input);
  if (!Number.isFinite(raw)) return 2800;
  if (raw < 0) return 0;
  if (raw > 30000) return 30000;
  return Math.floor(raw);
}

function normalizeText(input, maxLen = 80) {
  const s = String(input || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...`;
}

function alignToJimp(align) {
  const key = String(align || "center").toLowerCase();
  if (key === "left") return Jimp.HORIZONTAL_ALIGN_LEFT;
  if (key === "right") return Jimp.HORIZONTAL_ALIGN_RIGHT;
  return Jimp.HORIZONTAL_ALIGN_CENTER;
}

function getResolutionForType(deviceType) {
  const key = String(deviceType || "ink-screen").trim().toLowerCase();
  return DEVICE_TYPE_RESOLUTION[key] || DEVICE_TYPE_RESOLUTION["ink-screen"];
}

function nearestFontBucket(size) {
  if (size >= 96) return 128;
  if (size >= 48) return 64;
  if (size >= 28) return 32;
  if (size >= 14) return 16;
  return 8;
}

async function getFontForSize(size) {
  const bucket = nearestFontBucket(Number(size || 32));
  const cacheKey = String(bucket);
  if (!fontCache.has(cacheKey)) {
    const font = await Jimp.loadFont(FONT_KEYS[bucket]);
    fontCache.set(cacheKey, font);
  }
  return fontCache.get(cacheKey);
}

function clampNumber(input, min, max, fallback) {
  const value = Number(input);
  if (!Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizeLayoutPayload(payload, fallback = {}) {
  return {
    layoutName: normalizeText(payload.layoutName || fallback.layoutName || "默认桌牌", 40),
    fontFamily: normalizeText(payload.fontFamily || fallback.fontFamily || "Microsoft YaHei", 80),
    nameFontSize: clampNumber(payload.nameFontSize, 28, 320, Number(fallback.nameFontSize || 180)),
    nameOffsetX: clampNumber(payload.nameOffsetX, -1200, 1200, Number(fallback.nameOffsetX || 0)),
    nameOffsetY: clampNumber(payload.nameOffsetY, -900, 900, Number(fallback.nameOffsetY || 0)),
    titleFontSize: clampNumber(payload.titleFontSize, 12, 200, Number(fallback.titleFontSize || 76)),
    titleOffsetX: clampNumber(payload.titleOffsetX, -1200, 1200, Number(fallback.titleOffsetX || 0)),
    titleOffsetY: clampNumber(payload.titleOffsetY, -220, 420, Number(fallback.titleOffsetY || 88)),
    align: ["left", "center", "right"].includes(String(payload.align || fallback.align || "center").toLowerCase())
      ? String(payload.align || fallback.align || "center").toLowerCase()
      : "center",
    margin: clampNumber(payload.margin, 0, 240, Number(fallback.margin || 40)),
  };
}

function ensureLayoutAccess(layout, auth) {
  if (!layout) throw new HttpError(404, "布局不存在");
  if (auth.role === "admin") return;
  if (String(layout.ownerId || "") !== String(auth.userId || "")) {
    throw new HttpError(403, "无权限访问该布局");
  }
}

function ensurePlanAccess(plan, auth) {
  if (!plan) throw new HttpError(404, "方案不存在");
  if (auth.role === "admin") return;
  if (String(plan.ownerId || "") !== String(auth.userId || "")) {
    throw new HttpError(403, "无权限访问该方案");
  }
}

function normalizePlanEntries(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const name = normalizeText(item?.name, 80);
      const title = normalizeText(item?.title, 120);
      const deviceIds = normalizeIdList(item?.deviceIds);
      const clusterIds = normalizeIdList(item?.clusterIds);
      const randomCount = Math.max(0, Math.floor(Number(item?.randomCount || 0)));
      return { name, title, deviceIds, clusterIds, randomCount };
    })
    .filter((item) => item.name);
}

async function getBucket() {
  return await getGridBucket("tf_files");
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
      source: "nameplate",
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

function getCanvasTextAlign(align) {
  const key = String(align || "center").toLowerCase();
  if (key === "left") return "left";
  if (key === "right") return "right";
  return "center";
}

function fitFontSize(ctx, text, maxWidth, size, family, weight = "normal") {
  let current = Math.max(12, Math.floor(size));
  while (current > 12) {
    ctx.font = `${weight} ${current}px "${family}", "Microsoft YaHei", "SimHei", "SimSun", sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return current;
    current -= 2;
  }
  return 12;
}

async function renderNameplateWithCanvas({ layout, name, title, deviceType }) {
  const resolution = getResolutionForType(deviceType);
  const width = resolution.width;
  const height = resolution.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const margin = clampNumber(layout.margin, 0, Math.floor(width * 0.2), 40);
  const align = getCanvasTextAlign(layout.align);
  const safeName = normalizeText(name, 60) || "-";
  const safeTitle = normalizeText(title, 80);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const nameTopBase = Math.max(20, Math.floor(height * 0.16));
  const nameAreaH = Math.max(120, Math.floor(height * 0.48));
  const nameTop = clampNumber(nameTopBase + Number(layout.nameOffsetY || 0), 0, height - 120, nameTopBase);
  const nameX = clampNumber(margin + Number(layout.nameOffsetX || 0), 0, width - 100, margin);
  const nameW = Math.max(100, width - nameX - margin);

  const titleTop = clampNumber(nameTopBase + nameAreaH + Number(layout.titleOffsetY || 0), 0, height - 80, Math.floor(height * 0.74));
  const titleX = clampNumber(margin + Number(layout.titleOffsetX || 0), 0, width - 100, margin);
  const titleW = Math.max(100, width - titleX - margin);

  const family = String(layout.fontFamily || "Microsoft YaHei");
  const nameSize = fitFontSize(ctx, safeName, nameW, Number(layout.nameFontSize || 180), family, "700");
  const titleSize = fitFontSize(ctx, safeTitle || "", titleW, Number(layout.titleFontSize || 76), family, "400");

  const anchorNameX = align === "left" ? nameX : align === "right" ? nameX + nameW : nameX + nameW / 2;
  const anchorTitleX = align === "left" ? titleX : align === "right" ? titleX + titleW : titleX + titleW / 2;

  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#000000";
  ctx.font = `700 ${nameSize}px "${family}", "Microsoft YaHei", "SimHei", "SimSun", sans-serif`;
  const nameDrawY = Math.max(0, Math.floor(nameTop + (nameAreaH - nameSize) / 2));
  ctx.fillText(safeName, anchorNameX, nameDrawY, nameW);

  if (safeTitle) {
    ctx.font = `400 ${titleSize}px "${family}", "Microsoft YaHei", "SimHei", "SimSun", sans-serif`;
    ctx.fillText(safeTitle, anchorTitleX, titleTop, titleW);
  }

  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, width - 2, height - 2);

  return await canvas.encode("png");
}

async function renderNameplateImageBuffer({ layout, name, title, deviceType }) {
  try {
    // Preferred path: Canvas supports UTF-8 CJK text with system fonts.
    return await renderNameplateWithCanvas({ layout, name, title, deviceType });
  } catch (_) {
    // Fallback path: keep compatibility if canvas runtime fails.
    const resolution = getResolutionForType(deviceType);
    const width = resolution.width;
    const height = resolution.height;
    const image = new Jimp(width, height, 0xffffffff);
    const margin = clampNumber(layout.margin, 0, Math.floor(width * 0.2), 40);
    const alignX = alignToJimp(layout.align);
    const nameFont = await getFontForSize(layout.nameFontSize);
    const titleFont = await getFontForSize(layout.titleFontSize);
    const safeName = normalizeText(name, 60) || "-";
    const safeTitle = normalizeText(title, 80);
    const nameTopBase = Math.max(20, Math.floor(height * 0.16));
    const nameAreaH = Math.max(120, Math.floor(height * 0.48));
    const nameTop = clampNumber(nameTopBase + Number(layout.nameOffsetY || 0), 0, height - 120, nameTopBase);
    const nameX = clampNumber(margin + Number(layout.nameOffsetX || 0), 0, width - 100, margin);
    const nameW = Math.max(100, width - nameX - margin);
    image.print(
      nameFont,
      nameX,
      nameTop,
      {
        text: safeName,
        alignmentX: alignX,
        alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE,
      },
      nameW,
      nameAreaH
    );
    if (safeTitle) {
      const titleTop = clampNumber(nameTopBase + nameAreaH + Number(layout.titleOffsetY || 0), 0, height - 80, Math.floor(height * 0.74));
      const titleX = clampNumber(margin + Number(layout.titleOffsetX || 0), 0, width - 100, margin);
      const titleW = Math.max(100, width - titleX - margin);
      image.print(
        titleFont,
        titleX,
        titleTop,
        {
          text: safeTitle,
          alignmentX: alignX,
          alignmentY: Jimp.VERTICAL_ALIGN_TOP,
        },
        titleW,
        Math.max(80, height - titleTop - 20)
      );
    }
    return await image.getBufferAsync(Jimp.MIME_PNG);
  }
}

async function pushRenderedNameplateToDevices({
  db,
  auth,
  layout,
  name,
  title,
  targetIds,
  denied = [],
  switchView = true,
  ackTimeoutMs = 2800,
  fileCache,
}) {
  const sentSuccess = [];
  const failed = [];
  const requestedCount = targetIds.length + denied.length;

  for (const deviceId of targetIds) {
    const device = db.devices.find((item) => item.id === deviceId);
    if (!device) {
      failed.push({ deviceId, reason: "设备不存在" });
      continue;
    }
    const ownerId = String(device.ownerId || auth.userId || "");
    if (!ownerId) {
      failed.push({ deviceId, reason: "设备未绑定owner" });
      continue;
    }

    const deviceType = String(device.type || layout.deviceType || "ink-screen");
    const dataModel = buildCommonDataModel(db, device, {});
    const resolvedName = (interpolateForTemplate(name, dataModel) || name || "").trim();
    const resolvedTitle = (interpolateForTemplate(title, dataModel) || title || "").trim();
    const cacheKey = `${ownerId}|${deviceType}|${resolvedName}|${resolvedTitle}`;

    try {
      let saved = fileCache.get(cacheKey);
      if (!saved) {
        const pngBuffer = await renderNameplateImageBuffer({ layout, name: resolvedName, title: resolvedTitle, deviceType });
        const fileName = `nameplate_${deviceType}_${Date.now()}.png`;
        saved = await saveRemoteFile({
          ownerId,
          category: "photo",
          fileName,
          buffer: pngBuffer,
          mime: Jimp.MIME_PNG,
        });
        fileCache.set(cacheKey, saved);
      }

      if (switchView) {
        const viewCommand = await createCommandAck({
          deviceId,
          eventType: "remote.switch_view",
          source: "nameplate.switch_view",
          auth,
          meta: { view: "nameplate", layoutId: layout.id },
        });
        publishDeviceEvent({
          type: "remote.switch_view",
          deviceId,
          payload: {
            commandId: viewCommand.commandId,
            view: "nameplate",
            source: "nameplate.render-push",
          },
        });
      }

      const imageCommand = await createCommandAck({
        deviceId,
        eventType: "remote.show_image",
        source: "nameplate.show_image",
        auth,
        meta: { layoutId: layout.id, name: resolvedName, title: resolvedTitle, templateName: name, templateTitle: title },
      });

      publishDeviceEvent({
        type: "remote.show_image",
        deviceId,
        payload: {
          commandId: imageCommand.commandId,
          fileId: saved.id,
          downloadUrl: `/api/hardware/tf/download/${saved.id}`,
          mime: saved.mime || Jimp.MIME_PNG,
          sha256: saved.sha256 || "",
          file: {
            id: saved.id,
            url: saved.url,
            name: saved.originalName || saved.name,
          },
          meta: {
            mode: "nameplate",
            name: resolvedName,
            title: resolvedTitle,
            templateName: name,
            templateTitle: title,
            layoutId: layout.id,
          },
        },
      });

      sentSuccess.push({
        deviceId,
        commandId: imageCommand.commandId,
        layoutId: layout.id,
        fileId: saved.id,
        downloadUrl: `/api/hardware/tf/download/${saved.id}`,
        mime: saved.mime || Jimp.MIME_PNG,
        sha256: saved.sha256 || "",
      });
    } catch (error) {
      failed.push({ deviceId, reason: error?.message || "桌牌下发失败" });
    }
  }

  const commandIds = sentSuccess.map((item) => String(item.commandId || "").trim()).filter(Boolean);
  const ackMap = commandIds.length ? await waitForAckMap({ readDB, commandIds, timeoutMs: getAckWaitMs(ackTimeoutMs) }) : new Map();

  const success = [];
  const ackFailed = [];
  const ackPending = [];
  const waitMs = getAckWaitMs(ackTimeoutMs);
  for (const item of sentSuccess) {
    const ack = ackMap.get(String(item.commandId || "")) || { state: "pending", status: "pending", message: "" };
    const row = {
      ...item,
      ackState: ack.state,
      ackStatus: ack.status,
      ackMessage: ack.message || "",
    };
    if (ack.state === "success") {
      success.push(row);
    } else if (ack.state === "failed") {
      ackFailed.push({ deviceId: item.deviceId, reason: row.ackMessage || "设备执行失败", commandId: item.commandId });
    } else {
      ackPending.push({ deviceId: item.deviceId, reason: `设备未确认(${waitMs}ms)`, commandId: item.commandId });
    }
  }

  const result = buildBatchResult({
    requestedCount,
    denied,
    success,
    failed: [...failed, ...ackFailed, ...ackPending],
  });
  result.sentCount = sentSuccess.length;
  result.sentDeviceIds = sentSuccess.map((x) => x.deviceId);
  result.ackedSuccessCount = success.length;
  result.ackedFailedCount = ackFailed.length;
  result.ackedPendingCount = ackPending.length;
  result.ackTimeoutMs = waitMs;
  return result;
}

router.get(
  "/layouts",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const deviceType = String(req.query?.deviceType || "").trim().toLowerCase();
    const ownerId = req.auth.role === "admin" ? String(req.query?.ownerId || "").trim() : req.auth.userId;

    let rows = db.nameplateLayouts || [];
    if (req.auth.role !== "admin" || ownerId) {
      rows = rows.filter((item) => String(item.ownerId || "") === String(ownerId || req.auth.userId));
    }
    if (deviceType) {
      rows = rows.filter((item) => String(item.deviceType || "").toLowerCase() === deviceType);
    }

    rows = [...rows].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    res.success(rows, "ok");
  })
);

router.post(
  "/layouts",
  asyncHandler(async (req, res) => {
    const now = new Date().toISOString();
    const body = req.body || {};
    const normalized = normalizeLayoutPayload(body);
    const deviceType = String(body.deviceType || "ink-screen").trim() || "ink-screen";
    const ownerId = req.auth.role === "admin" ? String(body.ownerId || req.auth.userId || "").trim() : req.auth.userId;

    if (!ownerId) throw new HttpError(400, "ownerId不能为空");

    const row = {
      id: createId("npl"),
      ownerId,
      deviceType,
      layoutName: normalized.layoutName,
      fontFamily: normalized.fontFamily,
      nameFontSize: normalized.nameFontSize,
      nameOffsetX: normalized.nameOffsetX,
      nameOffsetY: normalized.nameOffsetY,
      titleFontSize: normalized.titleFontSize,
      titleOffsetX: normalized.titleOffsetX,
      titleOffsetY: normalized.titleOffsetY,
      align: normalized.align,
      margin: normalized.margin,
      createdAt: now,
      updatedAt: now,
    };

    await updateDB((draft) => {
      draft.nameplateLayouts = Array.isArray(draft.nameplateLayouts) ? draft.nameplateLayouts : [];
      draft.nameplateLayouts.unshift(row);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "nameplate.layout.create",
      targetType: "nameplate_layout",
      targetId: row.id,
      detail: { ownerId, deviceType },
    });

    res.success(row, "布局已创建");
  })
);

router.post(
  "/layouts/:layoutId",
  asyncHandler(async (req, res) => {
    const layoutId = String(req.params.layoutId || "");
    if (!layoutId) throw new HttpError(400, "layoutId不能为空");

    const db = await readDB();
    const current = (db.nameplateLayouts || []).find((item) => item.id === layoutId);
    ensureLayoutAccess(current, req.auth);

    const updates = normalizeLayoutPayload(req.body || {}, current || {});
    let updated = null;

    await updateDB((draft) => {
      draft.nameplateLayouts = Array.isArray(draft.nameplateLayouts) ? draft.nameplateLayouts : [];
      const target = draft.nameplateLayouts.find((item) => item.id === layoutId);
      if (!target) throw new HttpError(404, "布局不存在");
      target.layoutName = updates.layoutName;
      target.fontFamily = updates.fontFamily;
      target.nameFontSize = updates.nameFontSize;
      target.nameOffsetX = updates.nameOffsetX;
      target.nameOffsetY = updates.nameOffsetY;
      target.titleFontSize = updates.titleFontSize;
      target.titleOffsetX = updates.titleOffsetX;
      target.titleOffsetY = updates.titleOffsetY;
      target.align = updates.align;
      target.margin = updates.margin;
      if (req.body?.deviceType) target.deviceType = String(req.body.deviceType);
      target.updatedAt = new Date().toISOString();
      updated = { ...target };
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "nameplate.layout.update",
      targetType: "nameplate_layout",
      targetId: layoutId,
      detail: { deviceType: updated?.deviceType || "" },
    });

    res.success(updated, "布局已更新");
  })
);

router.post(
  "/layouts/:layoutId/delete",
  asyncHandler(async (req, res) => {
    const layoutId = String(req.params.layoutId || "");
    const db = await readDB();
    const current = (db.nameplateLayouts || []).find((item) => item.id === layoutId);
    ensureLayoutAccess(current, req.auth);

    await updateDB((draft) => {
      draft.nameplateLayouts = (draft.nameplateLayouts || []).filter((item) => item.id !== layoutId);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "nameplate.layout.delete",
      targetType: "nameplate_layout",
      targetId: layoutId,
      detail: { deviceType: current?.deviceType || "" },
    });

    res.success({ id: layoutId }, "布局已删除");
  })
);

router.get(
  "/history",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const deviceType = String(req.query?.deviceType || "").trim().toLowerCase();

    let rows = db.nameplateHistory || [];
    if (req.auth.role !== "admin") {
      rows = rows.filter((item) => String(item.ownerId || "") === String(req.auth.userId || ""));
    }
    if (deviceType) {
      rows = rows.filter((item) => String(item.deviceType || "").toLowerCase() === deviceType);
    }

    rows = [...rows]
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, 200);

    res.success(rows, "ok");
  })
);

router.post(
  "/history/:historyId/delete",
  asyncHandler(async (req, res) => {
    const historyId = String(req.params.historyId || "").trim();
    if (!historyId) throw new HttpError(400, "historyId不能为空");

    const db = await readDB();
    const current = (db.nameplateHistory || []).find((item) => String(item.id || "") === historyId);
    if (!current) throw new HttpError(404, "历史记录不存在");
    if (req.auth.role !== "admin" && String(current.ownerId || "") !== String(req.auth.userId || "")) {
      throw new HttpError(403, "无权限删除该历史记录");
    }

    await updateDB((draft) => {
      draft.nameplateHistory = (draft.nameplateHistory || []).filter((item) => String(item.id || "") !== historyId);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "nameplate.history.delete",
      targetType: "nameplate_history",
      targetId: historyId,
      detail: {
        deviceType: String(current.deviceType || ""),
        name: String(current.name || ""),
      },
    });

    res.success({ id: historyId }, "历史记录已删除");
  })
);

router.post(
  "/render-push",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const layoutId = String(body.layoutId || "").trim();
    const name = normalizeText(body.name, 80);
    const title = normalizeText(body.title, 120);
    const switchView = body.switchView !== false;
    const ackTimeoutMs = getAckWaitMs(body.ackTimeoutMs);

    if (!layoutId) throw new HttpError(400, "layoutId不能为空");
    if (!name) throw new HttpError(400, "name不能为空");

    const db = await readDB();
    const layout = (db.nameplateLayouts || []).find((item) => item.id === layoutId);
    ensureLayoutAccess(layout, req.auth);

    const target = resolveBatchTargets(db, req.auth, body);
    if (target.targetIds.length === 0) {
      return res.success(
        buildBatchResult({ requestedCount: target.requestedCount, denied: target.denied, success: [], failed: [] }),
        "没有可下发设备"
      );
    }

    const result = await pushRenderedNameplateToDevices({
      db,
      auth: req.auth,
      layout,
      name,
      title,
      targetIds: target.targetIds,
      denied: target.denied,
      switchView,
      ackTimeoutMs,
      fileCache: new Map(),
    });

    if (result.successCount > 0) {
      const now = new Date().toISOString();
      await updateDB((draft) => {
        draft.nameplateHistory = Array.isArray(draft.nameplateHistory) ? draft.nameplateHistory : [];
        draft.nameplateHistory.unshift({
          id: createId("nph"),
          ownerId: req.auth.role === "admin" ? String(layout.ownerId || req.auth.userId || "") : String(req.auth.userId || ""),
          deviceType: String(layout.deviceType || "ink-screen"),
          layoutSnapshot: {
            id: layout.id,
            layoutName: layout.layoutName,
            fontFamily: layout.fontFamily,
            nameFontSize: layout.nameFontSize,
            nameOffsetX: layout.nameOffsetX,
            nameOffsetY: layout.nameOffsetY,
            titleFontSize: layout.titleFontSize,
            titleOffsetX: layout.titleOffsetX,
            titleOffsetY: layout.titleOffsetY,
            align: layout.align,
            margin: layout.margin,
          },
          name,
          title,
          targetDeviceIds: result.successDeviceIds || [],
          createdAt: now,
        });
        if (draft.nameplateHistory.length > 500) {
          draft.nameplateHistory = draft.nameplateHistory.slice(0, 500);
        }
      });
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "nameplate.render_push",
      targetType: "device_batch",
      targetId: `count:${target.targetIds.length}`,
      detail: {
        layoutId,
        name,
        title,
        requestedCount: target.requestedCount,
        successCount: result.successCount,
      },
    });

    res.success(result, result.ackedSuccessCount > 0 ? "桌牌下发已确认" : "桌牌下发未获设备确认");
  })
);

router.get(
  "/plans",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const ownerId = req.auth.role === "admin" ? String(req.query?.ownerId || "").trim() : String(req.auth.userId || "");
    const deviceType = String(req.query?.deviceType || "").trim().toLowerCase();

    let rows = db.nameplateBatchPlans || [];
    if (req.auth.role !== "admin" || ownerId) {
      rows = rows.filter((item) => String(item.ownerId || "") === String(ownerId || req.auth.userId || ""));
    }
    if (deviceType) {
      rows = rows.filter((item) => String(item.deviceType || "").toLowerCase() === deviceType);
    }
    rows = [...rows].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    res.success(rows, "ok");
  })
);

router.post(
  "/plans",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const ownerId = req.auth.role === "admin" ? String(body.ownerId || req.auth.userId || "").trim() : String(req.auth.userId || "");
    if (!ownerId) throw new HttpError(400, "ownerId不能为空");

    const entries = normalizePlanEntries(body.entries);
    if (!entries.length) throw new HttpError(400, "方案至少包含一条记录");

    const now = new Date().toISOString();
    const row = {
      id: createId("npp"),
      ownerId,
      planName: normalizeText(body.planName || "批量桌牌方案", 60),
      deviceType: String(body.deviceType || "ink-screen"),
      layoutId: String(body.layoutId || ""),
      entries,
      createdAt: now,
      updatedAt: now,
    };

    await updateDB((draft) => {
      draft.nameplateBatchPlans = Array.isArray(draft.nameplateBatchPlans) ? draft.nameplateBatchPlans : [];
      draft.nameplateBatchPlans.unshift(row);
    });

    res.success(row, "方案已创建");
  })
);

router.post(
  "/plans/:planId",
  asyncHandler(async (req, res) => {
    const planId = String(req.params.planId || "").trim();
    if (!planId) throw new HttpError(400, "planId不能为空");

    const db = await readDB();
    const current = (db.nameplateBatchPlans || []).find((item) => item.id === planId);
    ensurePlanAccess(current, req.auth);

    const entries = normalizePlanEntries(req.body?.entries);
    if (!entries.length) throw new HttpError(400, "方案至少包含一条记录");

    let updated = null;
    await updateDB((draft) => {
      draft.nameplateBatchPlans = Array.isArray(draft.nameplateBatchPlans) ? draft.nameplateBatchPlans : [];
      const target = draft.nameplateBatchPlans.find((item) => item.id === planId);
      if (!target) throw new HttpError(404, "方案不存在");
      target.planName = normalizeText(req.body?.planName || target.planName || "批量桌牌方案", 60);
      target.deviceType = String(req.body?.deviceType || target.deviceType || "ink-screen");
      target.layoutId = String(req.body?.layoutId || target.layoutId || "");
      target.entries = entries;
      target.updatedAt = new Date().toISOString();
      updated = { ...target };
    });

    res.success(updated, "方案已更新");
  })
);

router.post(
  "/plans/:planId/delete",
  asyncHandler(async (req, res) => {
    const planId = String(req.params.planId || "").trim();
    if (!planId) throw new HttpError(400, "planId不能为空");

    const db = await readDB();
    const current = (db.nameplateBatchPlans || []).find((item) => item.id === planId);
    ensurePlanAccess(current, req.auth);

    await updateDB((draft) => {
      draft.nameplateBatchPlans = (draft.nameplateBatchPlans || []).filter((item) => item.id !== planId);
    });

    res.success({ id: planId }, "方案已删除");
  })
);

router.post(
  "/render-push-batch",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const layoutId = String(body.layoutId || "").trim();
    const entries = normalizePlanEntries(body.entries);
    const switchView = body.switchView !== false;
    const ackTimeoutMs = getAckWaitMs(body.ackTimeoutMs);
    const savePlan = body.savePlan === true;
    const planId = String(body.planId || "").trim();

    if (!layoutId) throw new HttpError(400, "layoutId不能为空");
    if (!entries.length) throw new HttpError(400, "entries不能为空");

    const db = await readDB();
    const layout = (db.nameplateLayouts || []).find((item) => item.id === layoutId);
    ensureLayoutAccess(layout, req.auth);

    const defaultDeviceIds = normalizeIdList(body.defaultDeviceIds || body.deviceIds);
    const defaultClusterIds = normalizeIdList(body.defaultClusterIds || body.clusterIds);
    const sharedFileCache = new Map();

    const successDeviceSet = new Set();
    const failedAll = [];
    const entryResults = [];

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const target = resolveBatchTargets(db, req.auth, {
        deviceIds: entry.deviceIds.length ? entry.deviceIds : defaultDeviceIds,
        clusterIds: entry.clusterIds.length ? entry.clusterIds : defaultClusterIds,
        randomCount: entry.randomCount || 0,
      });

      if (!target.targetIds.length) {
        const emptyResult = {
          total: target.requestedCount,
          successCount: 0,
          failedCount: target.denied.length,
          successDeviceIds: [],
          failed: target.denied,
        };
        entryResults.push({
          index: i,
          name: entry.name,
          title: entry.title,
          ...emptyResult,
        });
        target.denied.forEach((item) => failedAll.push({ ...item, entryIndex: i, entryName: entry.name }));
        continue;
      }

      const result = await pushRenderedNameplateToDevices({
        db,
        auth: req.auth,
        layout,
        name: entry.name,
        title: entry.title,
        targetIds: target.targetIds,
        denied: target.denied,
        switchView,
        ackTimeoutMs,
        fileCache: sharedFileCache,
      });

      entryResults.push({
        index: i,
        name: entry.name,
        title: entry.title,
        ...result,
      });

      (result.successDeviceIds || []).forEach((id) => successDeviceSet.add(id));
      (result.failed || []).forEach((item) => failedAll.push({ ...item, entryIndex: i, entryName: entry.name }));
    }

    if (savePlan) {
      const ownerId = req.auth.role === "admin" ? String(body.ownerId || req.auth.userId || "").trim() : String(req.auth.userId || "");
      const planName = normalizeText(body.planName || "批量桌牌方案", 60);
      if (ownerId) {
        if (planId) {
          await updateDB((draft) => {
            draft.nameplateBatchPlans = Array.isArray(draft.nameplateBatchPlans) ? draft.nameplateBatchPlans : [];
            const target = draft.nameplateBatchPlans.find((item) => item.id === planId);
            if (!target) throw new HttpError(404, "方案不存在");
            if (req.auth.role !== "admin" && String(target.ownerId || "") !== String(ownerId)) {
              throw new HttpError(403, "无权限修改该方案");
            }
            target.planName = planName;
            target.deviceType = String(body.deviceType || layout.deviceType || "ink-screen");
            target.layoutId = layoutId;
            target.entries = entries;
            target.updatedAt = new Date().toISOString();
          });
        } else {
          const now = new Date().toISOString();
          await updateDB((draft) => {
            draft.nameplateBatchPlans = Array.isArray(draft.nameplateBatchPlans) ? draft.nameplateBatchPlans : [];
            draft.nameplateBatchPlans.unshift({
              id: createId("npp"),
              ownerId,
              planName,
              deviceType: String(body.deviceType || layout.deviceType || "ink-screen"),
              layoutId,
              entries,
              createdAt: now,
              updatedAt: now,
            });
          });
        }
      }
    }

    const historyRows = entryResults.filter((item) => item.successCount > 0);
    if (historyRows.length) {
      const now = new Date().toISOString();
      await updateDB((draft) => {
        draft.nameplateHistory = Array.isArray(draft.nameplateHistory) ? draft.nameplateHistory : [];
        historyRows.forEach((item) => {
          draft.nameplateHistory.unshift({
            id: createId("nph"),
            ownerId: req.auth.role === "admin" ? String(layout.ownerId || req.auth.userId || "") : String(req.auth.userId || ""),
            deviceType: String(layout.deviceType || "ink-screen"),
            layoutSnapshot: {
              id: layout.id,
              layoutName: layout.layoutName,
              fontFamily: layout.fontFamily,
              nameFontSize: layout.nameFontSize,
              nameOffsetX: layout.nameOffsetX,
              nameOffsetY: layout.nameOffsetY,
              titleFontSize: layout.titleFontSize,
              titleOffsetX: layout.titleOffsetX,
              titleOffsetY: layout.titleOffsetY,
              align: layout.align,
              margin: layout.margin,
            },
            name: item.name,
            title: item.title,
            targetDeviceIds: item.successDeviceIds || [],
            createdAt: now,
          });
        });
        if (draft.nameplateHistory.length > 500) {
          draft.nameplateHistory = draft.nameplateHistory.slice(0, 500);
        }
      });
    }

    const total = entryResults.reduce((acc, item) => acc + Number(item.total || 0), 0);
    const successCount = entryResults.reduce((acc, item) => acc + Number(item.successCount || 0), 0);
    const failedCount = entryResults.reduce((acc, item) => acc + Number(item.failedCount || 0), 0);

    res.success(
      {
        total,
        successCount,
        failedCount,
        successDeviceIds: [...successDeviceSet],
        failed: failedAll,
        entries: entryResults,
        ackTimeoutMs,
      },
      successCount > 0 ? "批量桌牌已下发" : "批量桌牌无成功下发"
    );
  })
);

module.exports = router;

