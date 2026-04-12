const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { readDB, readDBCached, updateDB } = require("../db/store");
const { signToken, verifyToken } = require("../utils/jwt");
const { authRequired, allowRoles } = require("../middleware/auth");
const { ensureDeviceAccess } = require("../utils/access");
const { logOperation } = require("../utils/logging");
const {
  subscribeDevice,
  getDeviceHistory,
  publishDeviceEvent,
  markDeviceOnline,
  markDeviceOffline,
  touchDevicePresence,
} = require("../utils/realtime.hub");
const { getGridBucket, ObjectId } = require("../utils/mongo");
const { markRemoteAck, normalizeAckStatus } = require("../utils/remoteAck");
const {
  resolveHomepageConfig,
  getLatestHomepageImage,
  buildDeviceHomepagePayload,
} = require("../services/homepage_page.service");
const {
  resolveBadgeConfig,
  getLatestBadgeImage,
  buildDeviceBadgePayload,
} = require("../services/badgepage.service");
const {
  resolveWeatherConfig,
  getLatestWeatherImage,
  buildDeviceWeatherPayload,
} = require("../services/weatherpage.service");

const router = express.Router();

const REMOTE_REPLAY_MAX_AGE_MS = 45000;

function shouldSkipHistoryReplay(event) {
  const t = String(event?.type || "");
  if (t.startsWith("homepage.") || t.startsWith("badgepage.") || t.startsWith("weatherpage.")) {
    return true;
  }
  if (t.startsWith("remote.")) {
    const ts = Date.parse(String(event?.timestamp || ""));
    if (!Number.isFinite(ts)) return true;
    return Date.now() - ts > REMOTE_REPLAY_MAX_AGE_MS;
  }
  return false;
}

const PIN_TTL_SECONDS = 10 * 60;
const PIN_MAX_ATTEMPTS = 5;
const BOOTSTRAP_TOKEN_EXPIRES_IN = "10m";
const TF_CATEGORY_SET = new Set(["fonts", "read", "photo", "update", "background", "config"]);
const TF_CATEGORY_ALIASES = {
  font: "fonts",
  ebook: "read",
  firmware: "update",
  wallpaper: "background",
  custom: "photo",
};

function normalizeMac(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, ":");
}

function isMacValid(mac) {
  const compact = mac.replace(/:/g, "");
  return /^[0-9A-F]{12}$/.test(compact);
}

function randomMac() {
  const bytes = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256));
  return bytes.map((item) => item.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

function buildTemplateConfig(db, device) {
  return db.apiTemplates
    .filter((tpl) => tpl.enabled)
    .map((tpl) => ({
      slug: tpl.slug,
      name: tpl.name,
      method: tpl.method,
      url: tpl.url,
      deviceKey: device.apiKeys?.[tpl.slug] || "",
    }));
}

function createHardwareAuth(db, device) {
  const token = signToken({
    role: "device",
    deviceId: device.id,
    mac: device.mac,
  });
  return {
    token,
    templates: buildTemplateConfig(db, device),
  };
}

function toHardwareDevicePayload(device = {}) {
  return {
    id: String(device.id || ""),
    mac: String(device.mac || ""),
    ownerId: String(device.ownerId || ""),
    type: String(device.type || "ink-screen"),
    remark: String(device.remark || ""),
    displayName: String(device.displayName || ""),
    defaultView: String(device.defaultView || "home"),
    status: String(device.status || "enabled"),
    firmwareVersion: String(device.firmwareVersion || ""),
    simulated: Boolean(device.simulated),
    bindState: String(device.bindState || "pending"),
    boundAt: String(device.boundAt || ""),
    boundBy: String(device.boundBy || ""),
    createdAt: String(device.createdAt || ""),
    updatedAt: String(device.updatedAt || ""),
    lastLoginAt: String(device.lastLoginAt || ""),
  };
}

function extractToken(req) {
  if (req.query?.token) return String(req.query.token);
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.replace("Bearer ", "").trim();
  }
  return "";
}

function normalizeTfCategory(value) {
  const raw = String(value || "read");
  return TF_CATEGORY_ALIASES[raw] || raw;
}

function normalizeNameVariants(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return [];
  const normalized = raw.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const base = parts[parts.length - 1] || normalized;
  const list = [normalized];
  if (base !== normalized) list.push(base);
  return list;
}

function toObjectId(value) {
  if (!value) return null;
  try {
    return new ObjectId(String(value));
  } catch (_) {
    return null;
  }
}

function buildDeliveredSet(files = []) {
  const delivered = new Set();
  files.forEach((item) => {
    const category = String(item.category || "").toLowerCase();
    normalizeNameVariants(item.name || "").forEach((variant) => {
      delivered.add(`${category}|${variant}`);
    });
  });
  return delivered;
}

function canDeviceAccessTfFile(file, device) {
  if (!file || !device) return false;
  if (!device.ownerId) return false;
  return String(file.ownerId || "") === String(device.ownerId || "");
}

async function streamTfFile(file, res) {
  const bucket = await getGridBucket("tf_files");
  const objectId = toObjectId(file.gridId);
  if (!objectId) throw new HttpError(404, "文件数据不存在");

  const safeName = encodeURIComponent(file.originalName || file.name || file.id);
  res.setHeader("Content-Type", file.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename=\"${safeName}\"`);
  if (file.sha256) {
    res.setHeader("X-File-Sha256", file.sha256);
  }

  const downloadStream = bucket.openDownloadStream(objectId);
  downloadStream.on("error", () => {
    if (!res.headersSent) res.status(404).end();
    else res.end();
  });
  downloadStream.pipe(res);
}

async function resolveSseAuth(req, deviceId) {
  const token = extractToken(req);
  if (!token) throw new HttpError(401, "缺少令牌");
  const auth = verifyToken(token);
  const db = await readDB();
  ensureDeviceAccess(db, auth, deviceId);
  return { auth };
}

function writeSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function generateUniquePin(draft) {
  const active = new Set(
    draft.bindingPins.filter((item) => item.status === "pending").map((item) => String(item.pin || ""))
  );
  for (let i = 0; i < 10; i += 1) {
    const pin = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
    if (!active.has(pin)) return pin;
  }
  return String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
}

function applyAutoRegisterOnDraft({
  draft,
  mac,
  type = "ink-screen",
  remark = "",
  simulated = false,
  nowIso,
  expiresAt,
}) {
  const publishQueue = [];
  let resultPayload = null;

  let device = draft.devices.find((item) => item.mac === mac);
  if (device && device.status === "blocked") {
    throw new HttpError(403, "设备已封禁");
  }

  if (!device) {
    device = {
      id: createId("dev"),
      mac,
      ownerId: "",
      type,
      remark,
      displayName: "",
      defaultView: "home",
      status: "enabled",
      apiKeys: {},
      firmwareVersion: "",
      simulated: Boolean(simulated),
      bindState: "pending",
      boundAt: "",
      boundBy: "",
      createdAt: nowIso,
      updatedAt: nowIso,
      lastLoginAt: "",
    };
    draft.devices.push(device);
    publishQueue.push({
      type: "device.created",
      deviceId: device.id,
      payload: { simulated: device.simulated, ownerId: "" },
    });
  }

  if (device.bindState === "bound" && device.ownerId) {
    device.lastLoginAt = nowIso;
    device.updatedAt = nowIso;
    resultPayload = {
      mode: "already_bound",
      device: toHardwareDevicePayload(device),
      hardwareAuth: createHardwareAuth(draft, device),
    };
    return { resultPayload, publishQueue };
  }

  draft.bindingPins.forEach((item) => {
    if (item.deviceId === device.id && item.status === "pending") {
      item.status = "replaced";
    }
  });

  const pin = generateUniquePin(draft);
  draft.bindingPins.unshift({
    id: createId("pin"),
    pin,
    deviceId: device.id,
    mac: device.mac,
    expiresAt,
    attempts: 0,
    maxAttempts: PIN_MAX_ATTEMPTS,
    status: "pending",
    usedBy: "",
    usedAt: "",
    createdAt: nowIso,
  });
  draft.bindingPins = draft.bindingPins.slice(0, 20000);

  device.ownerId = "";
  device.bindState = "pending";
  device.boundAt = "";
  device.boundBy = "";
  device.updatedAt = nowIso;

  const bootstrapToken = signToken(
    {
      role: "bootstrap",
      tokenType: "hardware_bind_bootstrap",
      deviceId: device.id,
      mac: device.mac,
    },
    BOOTSTRAP_TOKEN_EXPIRES_IN
  );

  resultPayload = {
    mode: "pending_bind",
    device: toHardwareDevicePayload(device),
    bind: {
      pin,
      expiresAt,
      ttlSeconds: PIN_TTL_SECONDS,
      attemptsLeft: PIN_MAX_ATTEMPTS,
    },
    bootstrap: {
      token: bootstrapToken,
      expiresAt,
    },
  };

  publishQueue.push({
    type: "device.pin_issued",
    deviceId: device.id,
    payload: {
      expiresAt,
      attemptsLeft: PIN_MAX_ATTEMPTS,
    },
  });

  return { resultPayload, publishQueue };
}

async function runAutoRegisterFlow({ rawMac, type = "ink-screen", remark = "", simulated = false }) {
  const mac = rawMac ? normalizeMac(rawMac) : randomMac();
  if (!isMacValid(mac)) throw new HttpError(400, "MAC地址格式不合法");

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + PIN_TTL_SECONDS * 1000).toISOString();

  let resultPayload = null;
  let publishQueue = [];
  await updateDB((draft) => {
    const applied = applyAutoRegisterOnDraft({
      draft,
      mac,
      type,
      remark,
      simulated,
      nowIso,
      expiresAt,
    });
    resultPayload = applied.resultPayload;
    publishQueue = applied.publishQueue;
  });

  publishQueue.forEach((event) => publishDeviceEvent(event));
  return { mac, resultPayload };
}

router.post(
  "/auto-register",
  asyncHandler(async (req, res) => {
    const { mac: rawMac, type = "ink-screen", remark = "", simulated = false } = req.body || {};
    const { mac, resultPayload } = await runAutoRegisterFlow({
      rawMac,
      type,
      remark,
      simulated,
    });

    await logOperation({
      actorId: mac,
      actorRole: "hardware",
      action: "hardware.auto_register",
      targetType: "device",
      targetId: resultPayload?.device?.id || "",
      detail: { mac, mode: resultPayload?.mode || "unknown" },
    });

    res.success(resultPayload, resultPayload.mode === "already_bound" ? "设备已绑定，直接下发配置" : "设备已自动注册，等待PIN绑定");
  })
);

router.get(
  "/bind/status",
  asyncHandler(async (req, res) => {
    const bootstrapToken = String(req.query?.bootstrapToken || "").trim();
    if (!bootstrapToken) throw new HttpError(400, "bootstrapToken不能为空");

    let auth;
    try {
      auth = verifyToken(bootstrapToken);
    } catch (_) {
      throw new HttpError(401, "bootstrapToken无效或已过期");
    }

    if (auth.role !== "bootstrap" || auth.tokenType !== "hardware_bind_bootstrap") {
      throw new HttpError(401, "bootstrapToken无效");
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const nowTs = now.getTime();
    let resultPayload = null;

    await updateDB((draft) => {
      const device = draft.devices.find((item) => item.id === auth.deviceId && item.mac === auth.mac);
      if (!device) throw new HttpError(404, "设备不存在");

      draft.bindingPins.forEach((item) => {
        if (item.deviceId === device.id && item.status === "pending" && new Date(item.expiresAt).getTime() <= nowTs) {
          item.status = "expired";
        }
      });

      if (device.bindState === "bound" && device.ownerId) {
        device.lastLoginAt = nowIso;
        device.updatedAt = nowIso;
        resultPayload = {
          bound: true,
          device: toHardwareDevicePayload(device),
          hardwareAuth: createHardwareAuth(draft, device),
        };
        return;
      }

      const activePin = draft.bindingPins.find((item) => item.deviceId === device.id && item.status === "pending");
      resultPayload = {
        bound: false,
        pinExpiresAt: activePin?.expiresAt || "",
        attemptsLeft: activePin ? Math.max(0, Number(activePin.maxAttempts || 5) - Number(activePin.attempts || 0)) : 0,
      };
    });

    res.success(resultPayload, resultPayload.bound ? "设备已绑定" : "设备尚未绑定");
  })
);

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    let stepAt = startedAt;
    const loginTrace = (stage, detail = "") => {
      const now = Date.now();
      const stepElapsed = now - stepAt;
      const totalElapsed = now - startedAt;
      // eslint-disable-next-line no-console
      console.log(
        `[login] ${stage} elapsed_ms=${stepElapsed} total_ms=${totalElapsed}${detail ? ` ${detail}` : ""}`
      );
      stepAt = now;
    };

    const mac = normalizeMac(req.body?.mac);
    // eslint-disable-next-line no-console
    console.log(`[login] start mac=${mac}`);
    if (!mac) throw new HttpError(400, "MAC地址不能为空");
    if (!isMacValid(mac)) throw new HttpError(400, "MAC地址格式不合法");
    loginTrace("parse_request", `mac=${mac}`);

    const db = await readDBCached();
    loginTrace("read_db_cached");
    const device = db.devices.find((item) => item.mac === mac);
    loginTrace("find_device", `found=${device ? 1 : 0}`);
    if (!device) throw new HttpError(404, "设备未注册");
    if (device.status === "blocked") throw new HttpError(403, "设备已封禁");
    if (device.bindState !== "bound" || !device.ownerId) throw new HttpError(403, "设备尚未绑定用户");
    loginTrace("bind_status", `bindState=${device.bindState} owner=${device.ownerId ? 1 : 0}`);

    const token = signToken({
      role: "device",
      deviceId: device.id,
      mac: device.mac,
    });
    touchDevicePresence(device.id);
    loginTrace("issue_token");

    res.success(
      {
        token,
        deviceId: device.id,
        status: device.status,
        displayName: String(device.displayName || ""),
        defaultView: String(device.defaultView || "home"),
        templates: buildTemplateConfig(db, device),
      },
      "设备鉴权成功"
    );
    loginTrace("response_send", `deviceId=${device.id}`);
    // eslint-disable-next-line no-console
    console.log(`[login] total elapsed_ms=${Date.now() - startedAt} mac=${mac} deviceId=${device.id}`);
    const asyncScheduledAt = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[login] async_updates_scheduled total_ms=${asyncScheduledAt - startedAt}`);

    // Keep hardware login response fast for constrained devices:
    // update bookkeeping asynchronously to avoid blocking auth response on remote DB latency.
    const updateStart = Date.now();
    updateDB((draft) => {
      const target = draft.devices.find((item) => item.id === device.id);
      if (target) {
        target.lastLoginAt = new Date().toISOString();
        target.updatedAt = target.lastLoginAt;
      }
    })
      .then(() => {
        // eslint-disable-next-line no-console
        console.log(`[login] update_last_seen async_ms=${Date.now() - updateStart} deviceId=${device.id}`);
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.log(
          `[login] update_last_seen_failed async_ms=${Date.now() - updateStart} err=${String(error?.message || error)}`
        );
      });

    const logStart = Date.now();
    logOperation({
      actorId: device.id,
      actorRole: "device",
      action: "hardware.login",
      targetType: "device",
      targetId: device.id,
      detail: { mac: device.mac },
    })
      .then(() => {
        // eslint-disable-next-line no-console
        console.log(`[login] op_log async_ms=${Date.now() - logStart} deviceId=${device.id}`);
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.log(`[login] op_log_failed async_ms=${Date.now() - logStart} err=${String(error?.message || error)}`);
      });
  })
);

router.get(
  "/config",
  authRequired,
  allowRoles("device"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = db.devices.find((item) => item.id === req.auth.deviceId);
    if (!device) throw new HttpError(404, "设备不存在");

    const templates = db.apiTemplates
      .filter((item) => item.enabled)
      .map((tpl) => ({
        slug: tpl.slug,
        name: tpl.name,
        url: tpl.url,
        method: tpl.method,
        key: device.apiKeys?.[tpl.slug] || "",
      }));

    const homeResolved = resolveHomepageConfig(db, device.ownerId, device.id);
    const homeImageRow = getLatestHomepageImage(db, device.id);
    const homepage = buildDeviceHomepagePayload({
      deviceId: device.id,
      config: homeResolved.config,
      imageRow: homeImageRow,
    });

    const badgeResolved = resolveBadgeConfig(db, device.ownerId, device.id);
    const badgeImageRow = getLatestBadgeImage(db, device.id);
    const badgepage = buildDeviceBadgePayload({
      deviceId: device.id,
      config: badgeResolved.config,
      imageRow: badgeImageRow,
    });

    const weatherResolved = resolveWeatherConfig(db, device.ownerId, device.id);
    const weatherImageRow = getLatestWeatherImage(db, device.id);
    const weatherpage = buildDeviceWeatherPayload({
      deviceId: device.id,
      config: weatherResolved.config,
      imageRow: weatherImageRow,
    });

    res.success({ deviceId: device.id, templates, homepage, badgepage, weatherpage }, "ok");
  })
);

router.get(
  "/homepage",
  authRequired,
  allowRoles("device"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = db.devices.find((item) => item.id === req.auth.deviceId);
    if (!device) throw new HttpError(404, "设备不存在");

    const resolved = resolveHomepageConfig(db, device.ownerId, device.id);
    const imageRow = getLatestHomepageImage(db, device.id);
    const homepage = buildDeviceHomepagePayload({
      deviceId: device.id,
      config: resolved.config,
      imageRow,
    });

    res.success(homepage, "ok");
  })
);

router.get(
  "/badgepage",
  authRequired,
  allowRoles("device"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = db.devices.find((item) => item.id === req.auth.deviceId);
    if (!device) throw new HttpError(404, "设备不存在");

    const resolved = resolveBadgeConfig(db, device.ownerId, device.id);
    const imageRow = getLatestBadgeImage(db, device.id);
    const badgepage = buildDeviceBadgePayload({
      deviceId: device.id,
      config: resolved.config,
      imageRow,
    });

    res.success(badgepage, "ok");
  })
);

router.get(
  "/weatherpage",
  authRequired,
  allowRoles("device"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = db.devices.find((item) => item.id === req.auth.deviceId);
    if (!device) throw new HttpError(404, "设备不存在");

    const resolved = resolveWeatherConfig(db, device.ownerId, device.id);
    const imageRow = getLatestWeatherImage(db, device.id);
    const weatherpage = buildDeviceWeatherPayload({
      deviceId: device.id,
      config: resolved.config,
      imageRow,
    });

    res.success(weatherpage, "ok");
  })
);

router.post(
  "/tf/report",
  authRequired,
  allowRoles("device"),
  asyncHandler(async (req, res) => {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const now = new Date().toISOString();

    const normalized = files
      .map((item) => ({
        name: String(item?.name || item?.fileName || "").trim(),
        category: normalizeTfCategory(item?.category || "read"),
        size: Number(item?.size || 0),
        updatedAt: item?.updatedAt || item?.mtime || now,
      }))
      .filter((item) => item.name && TF_CATEGORY_SET.has(item.category));

    await updateDB((draft) => {
      const device = draft.devices.find((item) => item.id === req.auth.deviceId);
      if (!device) {
        throw new HttpError(404, "设备不存在");
      }
      let record = draft.tfDeviceFiles.find((item) => item.deviceId === req.auth.deviceId);
      if (!record) {
        record = {
          id: createId("tfd"),
          deviceId: req.auth.deviceId,
          files: [],
          reportedAt: now,
          updatedAt: now,
        };
        draft.tfDeviceFiles.push(record);
      }
      record.files = normalized;
      record.reportedAt = now;
      record.updatedAt = now;
    });

    publishDeviceEvent({
      type: "tf.reported",
      deviceId: req.auth.deviceId,
      payload: { count: normalized.length },
    });

    await logOperation({
      actorId: req.auth.deviceId,
      actorRole: "device",
      action: "hardware.tf_report",
      targetType: "device",
      targetId: req.auth.deviceId,
      detail: { count: normalized.length },
    });

    res.success({ deviceId: req.auth.deviceId, count: normalized.length, reportedAt: now }, "上报成功");
  })
);

router.get(
  "/tf/pending",
  authRequired,
  allowRoles("device"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = db.devices.find((item) => item.id === req.auth.deviceId);
    if (!device) throw new HttpError(404, "设备不存在");

    const localRecord = db.tfDeviceFiles.find((item) => item.deviceId === req.auth.deviceId);
    const deliveredSet = buildDeliveredSet(localRecord?.files || []);

    const files = db.tfFiles
      .filter((file) => canDeviceAccessTfFile(file, device))
      .filter((file) => {
        const category = String(file.category || "").toLowerCase();
        const variants = [
          ...normalizeNameVariants(file.originalName || ""),
          ...normalizeNameVariants(file.name || ""),
        ];
        return !variants.some((variant) => deliveredSet.has(`${category}|${variant}`));
      })
      .map((file) => ({
        fileId: file.id,
        name: file.originalName || file.name || "",
        category: file.category || "read",
        size: Number(file.size || 0),
        mime: file.mime || "",
        sha256: file.sha256 || "",
        downloadUrl: `/api/hardware/tf/download/${file.id}`,
        updatedAt: file.updatedAt || file.createdAt || "",
      }));

    res.success(
      {
        deviceId: req.auth.deviceId,
        reportedAt: localRecord?.reportedAt || "",
        files,
      },
      "ok"
    );
  })
);

router.get(
  "/tf/download/:fileId",
  authRequired,
  allowRoles("device"),
  asyncHandler(async (req, res) => {
    const { fileId } = req.params;
    const db = await readDB();
    const device = db.devices.find((item) => item.id === req.auth.deviceId);
    if (!device) throw new HttpError(404, "设备不存在");

    const file = db.tfFiles.find((item) => item.id === fileId);
    if (!file) throw new HttpError(404, "文件不存在");
    if (!canDeviceAccessTfFile(file, device)) {
      throw new HttpError(403, "无权限下载该文件");
    }

    await streamTfFile(file, res);
  })
);

router.get(
  "/upgrade/pending",
  authRequired,
  allowRoles("device"),
  asyncHandler(async (req, res) => {
    let db = await readDB();
    const device = db.devices.find((item) => item.id === req.auth.deviceId);
    if (!device) throw new HttpError(404, "设备不存在");

    const nowTs = Date.now();
    const candidates = db.upgradeJobs
      .filter((job) => job.deviceId === req.auth.deviceId && ["pending", "in_progress", "scheduled"].includes(job.status))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    let job = candidates[0] || null;
    if (!job) {
      return res.success(null, "暂无待执行升级");
    }

    if (job.status === "scheduled") {
      const scheduleTs = job.scheduledAt ? new Date(job.scheduledAt).getTime() : 0;
      if (scheduleTs > nowTs) {
        return res.success(null, "暂无待执行升级");
      }
      await updateDB((draft) => {
        const target = draft.upgradeJobs.find((item) => item.id === job.id);
        if (target) {
          target.status = "pending";
          target.progress = Number(target.progress || 0);
          target.result = "已到执行时间，等待设备执行";
        }
      });
      db = await readDB();
      job = db.upgradeJobs.find((item) => item.id === job.id) || job;
    }

    const firmware = db.firmwares.find((item) => item.id === job.firmwareId);
    if (!firmware) {
      return res.success(null, "升级目标固件不存在");
    }

    res.success(
      {
        jobId: job.id,
        firmwareId: firmware.id,
        version: firmware.version,
        downloadUrl: `/api/firmware/${firmware.id}/download`,
        sha256: firmware.sha256 || "",
        size: Number(firmware.fileSize || 0),
        force: Boolean(job.force),
        scheduledAt: job.scheduledAt || "",
        status: job.status,
        progress: Number(job.progress || 0),
      },
      "ok"
    );
  })
);

router.post(
  "/upgrade/report",
  authRequired,
  allowRoles("device"),
  asyncHandler(async (req, res) => {
    const {
      jobId = "",
      status = "",
      progress = 0,
      message = "",
      currentVersion = "",
      targetVersion = "",
    } = req.body || {};

    if (!jobId) throw new HttpError(400, "jobId不能为空");
    const allowedStatus = new Set(["pending", "in_progress", "success", "failed", "canceled"]);
    if (!allowedStatus.has(String(status))) {
      throw new HttpError(400, "status不合法");
    }

    const dbSnapshot = await readDB();
    const snapshotJob = dbSnapshot.upgradeJobs.find((item) => item.id === jobId && item.deviceId === req.auth.deviceId);
    const snapshotFirmware = snapshotJob
      ? dbSnapshot.firmwares.find((item) => item.id === snapshotJob.firmwareId)
      : null;
    const expectedVersion = String(targetVersion || snapshotFirmware?.version || "");

    let updatedJob = null;
    let deviceFirmwareVersion = "";
    await updateDB((draft) => {
      const device = draft.devices.find((item) => item.id === req.auth.deviceId);
      if (!device) throw new HttpError(404, "设备不存在");
      const job = draft.upgradeJobs.find((item) => item.id === jobId && item.deviceId === req.auth.deviceId);
      if (!job) throw new HttpError(404, "升级任务不存在");

      job.status = String(status);
      job.progress = Math.max(0, Math.min(100, Number(progress || 0)));
      job.result = String(message || job.result || "");
      if (job.status === "success" || job.status === "failed" || job.status === "canceled") {
        job.finishedAt = new Date().toISOString();
      } else {
        job.finishedAt = "";
      }
      updatedJob = { ...job };

      if (job.status === "success") {
        const nextVersion = expectedVersion;
        if (nextVersion) {
          device.firmwareVersion = nextVersion;
          device.updatedAt = new Date().toISOString();
          deviceFirmwareVersion = nextVersion;
        }
      }
    });

    const db = await readDB();
    const firmware = db.firmwares.find((item) => item.id === updatedJob.firmwareId);
    const resolvedVersion = deviceFirmwareVersion || expectedVersion || String(firmware?.version || "");

    publishDeviceEvent({
      type: "firmware.changed",
      deviceId: req.auth.deviceId,
      payload: {
        action: "upgrade_report",
        jobId: updatedJob.id,
        status: updatedJob.status,
        progress: Number(updatedJob.progress || 0),
        firmwareId: updatedJob.firmwareId,
        version: resolvedVersion,
        firmwareVersion: resolvedVersion,
        downloadUrl: firmware ? `/api/firmware/${firmware.id}/download` : "",
        sha256: firmware?.sha256 || "",
        size: Number(firmware?.fileSize || 0),
        force: Boolean(updatedJob.force),
        message: updatedJob.result || "",
        currentVersion: String(currentVersion || ""),
      },
    });

    await logOperation({
      actorId: req.auth.deviceId,
      actorRole: "device",
      action: "hardware.upgrade_report",
      targetType: "upgrade_job",
      targetId: updatedJob.id,
      detail: {
        status: updatedJob.status,
        progress: Number(updatedJob.progress || 0),
        message: updatedJob.result || "",
        currentVersion: String(currentVersion || ""),
        targetVersion: resolvedVersion,
      },
    });

    res.success(updatedJob, "上报成功");
  })
);

router.get(
  "/stream/sse",
  asyncHandler(async (req, res) => {
    const deviceId = String(req.query?.deviceId || "");
    if (!deviceId) throw new HttpError(400, "deviceId不能为空");

    const { auth } = await resolveSseAuth(req, deviceId);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    markDeviceOnline(deviceId, "sse");

    writeSse(res, "ready", {
      channel: "sse",
      deviceId,
      authRole: auth.role,
      timestamp: new Date().toISOString(),
    });

    const history = getDeviceHistory(deviceId);
    history.forEach((event) => {
      // Ephemeral events should not be replayed on reconnect, otherwise device-side
      // handlers can spend long time processing stale image/control events and delay
      // newly issued remote commands.
      if (shouldSkipHistoryReplay(event)) return;
      writeSse(res, "device-event", { channel: "sse", ...event });
    });

    const unsubscribe = subscribeDevice(deviceId, (event) => {
      writeSse(res, "device-event", { channel: "sse", ...event });
    });

    const heartbeat = setInterval(() => {
      writeSse(res, "ping", { time: new Date().toISOString() });
    }, 20000);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      markDeviceOffline(deviceId, "sse");
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
  })
);

router.post(
  "/remote/ack",
  authRequired,
  allowRoles("device"),
  asyncHandler(async (req, res) => {
    const commandId = String(req.body?.commandId || "").trim();
    const eventType = String(req.body?.eventType || req.body?.type || "").trim();
    const status = normalizeAckStatus(req.body?.status || "success");
    const message = String(req.body?.message || "").trim();
    const payload =
      req.body?.payload && typeof req.body.payload === "object" && !Array.isArray(req.body.payload)
        ? req.body.payload
        : {};

    if (!commandId) throw new HttpError(400, "commandId不能为空");

    let updated = null;
    await updateDB((draft) => {
      const device = draft.devices.find((item) => item.id === req.auth.deviceId);
      if (!device) throw new HttpError(404, "设备不存在");
      updated = markRemoteAck(draft, {
        commandId,
        deviceId: req.auth.deviceId,
        eventType,
        status,
        message,
        payload,
      });
      if (!updated) throw new HttpError(404, "命令不存在或不属于当前设备");
    });

    publishDeviceEvent({
      type: "remote.ack",
      deviceId: req.auth.deviceId,
      payload: {
        commandId,
        eventType: updated?.eventType || eventType,
        status,
        message,
      },
    });

    await logOperation({
      actorId: req.auth.deviceId,
      actorRole: "device",
      action: "hardware.remote_ack",
      targetType: "remote_command",
      targetId: commandId,
      detail: {
        eventType: updated?.eventType || eventType,
        status,
        message,
      },
    });

    res.success(
      {
        commandId,
        deviceId: req.auth.deviceId,
        eventType: updated?.eventType || eventType,
        status,
        message,
        ackedAt: updated?.ackedAt || "",
      },
      "ack已记录"
    );
  })
);

router.post(
  "/simulate/register",
  authRequired,
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const { mac: rawMac, ownerId, type = "ink-screen", remark = "", autoLogin } = req.body || {};
    const { mac, resultPayload } = await runAutoRegisterFlow({
      rawMac,
      type,
      remark,
      simulated: true,
    });

    const warnings = [];
    if (ownerId !== undefined && String(ownerId).trim()) {
      warnings.push("ownerId 参数已弃用，模拟入口不再自动绑定用户，请按 PIN 流程绑定。");
    }
    if (autoLogin !== undefined) {
      warnings.push("autoLogin 参数已弃用，模拟入口不再自动签发设备令牌，请按 login 流程获取。");
    }

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "hardware.simulate_register",
      targetType: "device",
      targetId: resultPayload?.device?.id || "",
      detail: {
        deprecated: true,
        mode: resultPayload?.mode || "unknown",
        mac,
        warnings,
      },
    });

    res.success(
      {
        ...resultPayload,
        deprecated: true,
        warnings,
      },
      resultPayload?.mode === "already_bound"
        ? "模拟入口已弃用：设备已绑定，已按真机链路返回"
        : "模拟入口已弃用：已按真机链路注册，等待 PIN 绑定"
    );
  })
);

module.exports = router;
