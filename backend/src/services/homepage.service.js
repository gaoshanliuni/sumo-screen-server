const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createCanvas } = require("@napi-rs/canvas");

const createId = require("../utils/id");
const HttpError = require("../utils/httpError");
const { getGridBucket } = require("../utils/mongo");

const DEFAULT_CONFIG_PATH = path.join(__dirname, "../../config/default_homepage.json");
const DEFAULT_TEMPLATE_ID = "tpl_home_default";
const DEFAULT_TEMPLATE_NAME = "Default Homepage HTML";
const DEFAULT_TEMPLATE_HTML = `
<div data-x="120" data-y="120" data-size="126" data-weight="700" data-align="left">{{profile.name}}</div>
<div data-x="120" data-y="270" data-size="64" data-weight="400" data-align="left">{{profile.title}}</div>
<div data-x="120" data-y="370" data-size="48" data-align="left">{{profile.department}} · {{profile.workstation}}</div>
<div data-x="120" data-y="470" data-size="48" data-align="left">状态：{{profile.status}}</div>
<div data-x="120" data-y="660" data-size="52" data-weight="600" data-align="left">今日待办</div>
<div data-x="120" data-y="735" data-size="42" data-align="left">{{todo_summary.text}}</div>
<div data-x="120" data-y="960" data-size="52" data-weight="600" data-align="left">课程摘要</div>
<div data-x="120" data-y="1035" data-size="42" data-align="left">{{schedule_summary.text}}</div>
<div data-x="120" data-y="1415" data-size="30" data-align="left">Updated: {{meta.rendered_at}}</div>
`;

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function isObject(input) {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function deepMerge(base, patch) {
  const out = isObject(base) ? deepClone(base) : {};
  if (!isObject(patch)) return out;
  Object.keys(patch).forEach((key) => {
    const baseValue = out[key];
    const patchValue = patch[key];
    if (isObject(baseValue) && isObject(patchValue)) {
      out[key] = deepMerge(baseValue, patchValue);
    } else {
      out[key] = deepClone(patchValue);
    }
  });
  return out;
}

function loadDefaultHomepageConfig() {
  if (!fs.existsSync(DEFAULT_CONFIG_PATH)) {
    throw new HttpError(500, "默认主页配置文件缺失");
  }
  const raw = fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  parsed.template = parsed.template || {};
  if (!parsed.template.template_id) {
    parsed.template.template_id = DEFAULT_TEMPLATE_ID;
  }
  return parsed;
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function normalizeHomepageConfig(input) {
  const fallback = loadDefaultHomepageConfig();
  const merged = deepMerge(fallback, input || {});

  merged.enabled = merged.enabled !== false;
  merged.id = String(merged.id || fallback.id || "homepage_default");
  merged.name = String(merged.name || fallback.name || "Homepage");
  merged.version = Number(merged.version || 1);

  merged.screen = merged.screen || {};
  merged.screen.width = clamp(merged.screen.width, 320, 4096, 2560);
  merged.screen.height = clamp(merged.screen.height, 240, 4096, 1600);

  merged.template = merged.template || {};
  merged.template.type = String(merged.template.type || "default_html");
  merged.template.template_id = String(merged.template.template_id || DEFAULT_TEMPLATE_ID);
  merged.template.template_name = String(merged.template.template_name || DEFAULT_TEMPLATE_NAME);

  merged.image = merged.image || {};
  merged.image.format = String(merged.image.format || "epd4").toLowerCase();
  merged.image.preview_format = String(merged.image.preview_format || "png").toLowerCase();
  merged.image.render_source = String(merged.image.render_source || "server");
  merged.image.cache_ttl_sec = clamp(merged.image.cache_ttl_sec, 30, 86400, 3600);

  merged.time_overlay = merged.time_overlay || {};
  merged.time_overlay.enabled = merged.time_overlay.enabled !== false;
  merged.time_overlay.x = clamp(merged.time_overlay.x, 0, merged.screen.width, 1820);
  merged.time_overlay.y = clamp(merged.time_overlay.y, 0, merged.screen.height, 80);
  merged.time_overlay.width = clamp(merged.time_overlay.width, 80, merged.screen.width, 680);
  merged.time_overlay.height = clamp(merged.time_overlay.height, 40, merged.screen.height, 180);
  merged.time_overlay.format = String(merged.time_overlay.format || "HH:mm");
  merged.time_overlay.font_size = clamp(merged.time_overlay.font_size, 12, 220, 88);
  merged.time_overlay.align = ["left", "center", "right"].includes(String(merged.time_overlay.align || "right"))
    ? String(merged.time_overlay.align)
    : "right";
  merged.time_overlay.refresh_interval_sec = clamp(merged.time_overlay.refresh_interval_sec, 1, 3600, 60);

  merged.cache_policy = merged.cache_policy || {};
  merged.cache_policy.cache_ttl_sec = clamp(merged.cache_policy.cache_ttl_sec, 30, 86400, 3600);
  merged.cache_policy.max_versions = clamp(merged.cache_policy.max_versions, 1, 30, 3);
  merged.cache_policy.use_etag = merged.cache_policy.use_etag !== false;

  merged.fallback = merged.fallback || {};
  merged.fallback.enabled = merged.fallback.enabled !== false;
  merged.fallback.mode = String(merged.fallback.mode || "local_text_home");

  return merged;
}

function getPathValue(source, dottedPath) {
  if (!isObject(source) || !dottedPath) return "";
  const parts = String(dottedPath).split(".").filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (!isObject(current) && !Array.isArray(current)) {
      return "";
    }
    current = current[part];
    if (current === undefined || current === null) {
      return "";
    }
  }
  if (typeof current === "string") return current;
  if (typeof current === "number" || typeof current === "boolean") return String(current);
  if (Array.isArray(current)) return current.join(", ");
  return "";
}

function interpolate(text, dataModel) {
  return String(text || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    return getPathValue(dataModel, key);
  });
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAttributes(rawAttrs) {
  const attrs = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*"([^"]*)"/g;
  let match = attrRegex.exec(rawAttrs || "");
  while (match) {
    attrs[match[1]] = match[2];
    match = attrRegex.exec(rawAttrs || "");
  }
  return attrs;
}

function parseTemplateBlocks(templateHtml, dataModel, width, height) {
  const blocks = [];
  const regex = /<div([^>]*)>([\s\S]*?)<\/div>/gi;
  let match = regex.exec(templateHtml || "");

  while (match) {
    const attrs = parseAttributes(match[1]);
    const rawText = stripTags(match[2]);
    const text = interpolate(rawText, dataModel);
    if (!text) {
      match = regex.exec(templateHtml || "");
      continue;
    }

    const x = clamp(attrs["data-x"], 0, width, 120);
    const y = clamp(attrs["data-y"], 0, height, 120);
    const fontSize = clamp(attrs["data-size"], 10, 256, 48);
    const maxWidth = clamp(attrs["data-width"], 80, width, width - x - 100);
    const align = ["left", "center", "right"].includes(String(attrs["data-align"] || ""))
      ? String(attrs["data-align"])
      : "left";
    const weight = attrs["data-weight"] || "400";
    const color = attrs["data-color"] || "#000000";

    blocks.push({ x, y, text, fontSize, maxWidth, align, weight, color });
    match = regex.exec(templateHtml || "");
  }

  return blocks;
}

function drawTextBlock(ctx, block) {
  const anchorX =
    block.align === "left" ? block.x : block.align === "right" ? block.x + block.maxWidth : block.x + Math.floor(block.maxWidth / 2);
  ctx.textAlign = block.align;
  ctx.textBaseline = "top";
  ctx.fillStyle = block.color;
  ctx.font = `${block.weight} ${block.fontSize}px "Noto Sans SC", "Microsoft YaHei", sans-serif`;
  ctx.fillText(block.text, anchorX, block.y, block.maxWidth);
}

function drawFallbackHomepage(ctx, config, dataModel) {
  const width = Number(config.screen?.width || 2560);
  const lines = [
    { text: dataModel.profile?.name || "未命名", size: 126, y: 120, weight: "700" },
    { text: dataModel.profile?.title || "", size: 64, y: 270, weight: "400" },
    { text: `${dataModel.profile?.department || ""} ${dataModel.profile?.workstation || ""}`.trim(), size: 48, y: 370, weight: "400" },
    { text: `状态：${dataModel.profile?.status || "-"}`, size: 48, y: 470, weight: "400" },
    { text: "今日待办", size: 52, y: 660, weight: "600" },
    { text: dataModel.todo_summary?.text || "暂无", size: 42, y: 735, weight: "400" },
    { text: "课程摘要", size: 52, y: 960, weight: "600" },
    { text: dataModel.schedule_summary?.text || "暂无", size: 42, y: 1035, weight: "400" },
    { text: `Updated: ${dataModel.meta?.rendered_at || ""}`, size: 30, y: 1415, weight: "400" },
  ];

  lines.forEach((item) => {
    if (!item.text) return;
    drawTextBlock(ctx, {
      x: 120,
      y: item.y,
      text: item.text,
      fontSize: item.size,
      maxWidth: width - 240,
      align: "left",
      weight: item.weight,
      color: "#000000",
    });
  });
}

function reserveTimeOverlay(ctx, config) {
  const overlay = config.time_overlay || {};
  if (overlay.enabled === false) return;

  const x = Number(overlay.x || 0);
  const y = Number(overlay.y || 0);
  const w = Number(overlay.width || 0);
  const h = Number(overlay.height || 0);
  if (w <= 0 || h <= 0) return;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
}

function rgbaToEpd4(rgba, width, height) {
  const rowsPadding = width % 2 ? 1 : 0;
  const bytes = Math.ceil(((width + rowsPadding) * height) / 2);
  const output = Buffer.alloc(bytes, 0xFF);
  let valueIndex = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
            const srcR = rgba[idx] ?? 255;
      const srcG = rgba[idx + 1] ?? 255;
      const srcB = rgba[idx + 2] ?? 255;
      const alpha = rgba[idx + 3] ?? 255;
      /* Composite source over white background before gray quantization.
       * Important: channel value 0 is valid black and must NOT fallback to 255.
       */
      const r = Math.round((srcR * alpha + 255 * (255 - alpha)) / 255);
      const g = Math.round((srcG * alpha + 255 * (255 - alpha)) / 255);
      const b = Math.round((srcB * alpha + 255 * (255 - alpha)) / 255);
      const luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      const nibble = clamp(Math.round(luminance / 17), 0, 15, 15);
      const byteIndex = Math.floor(valueIndex / 2);
      if (valueIndex % 2 === 0) {
        output[byteIndex] = (output[byteIndex] & 0xf0) | (nibble & 0x0f);
      } else {
        output[byteIndex] = (output[byteIndex] & 0x0f) | ((nibble & 0x0f) << 4);
      }
      valueIndex += 1;
    }
    if (width % 2) {
      valueIndex += 1;
    }
  }

  return output;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function uploadTfBlob({ ownerId, category, fileName, mime, buffer, source }) {
  const recordId = createId("tf");
  const filename = `${recordId}_${fileName}`;
  const bucket = await getGridBucket("tf_files");
  const sha256 = sha256Hex(buffer);

  const uploadStream = bucket.openUploadStream(filename, {
    contentType: mime || "application/octet-stream",
    metadata: {
      ownerId,
      category,
      source: source || "homepage",
      originalName: fileName,
      sha256,
    },
  });

  const gridId = await new Promise((resolve, reject) => {
    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(uploadStream.id));
    uploadStream.end(buffer);
  });

  const now = new Date().toISOString();
  return {
    id: recordId,
    ownerId,
    category,
    name: filename,
    originalName: fileName,
    size: buffer.length,
    mime: mime || "application/octet-stream",
    gridId: String(gridId),
    url: `/api/tf/${recordId}/download`,
    sha256,
    createdAt: now,
    updatedAt: now,
  };
}

function ensureDefaultTemplate(db) {
  db.homepageTemplates = Array.isArray(db.homepageTemplates) ? db.homepageTemplates : [];
  const builtin = db.homepageTemplates.find((row) => row.id === DEFAULT_TEMPLATE_ID);
  if (builtin) return builtin;

  const now = new Date().toISOString();
  const row = {
    id: DEFAULT_TEMPLATE_ID,
    ownerId: "",
    name: DEFAULT_TEMPLATE_NAME,
    type: "default_html",
    html: DEFAULT_TEMPLATE_HTML,
    builtin: true,
    createdAt: now,
    updatedAt: now,
  };
  db.homepageTemplates.unshift(row);
  return row;
}

function listTemplates(db, auth) {
  db.homepageTemplates = Array.isArray(db.homepageTemplates) ? db.homepageTemplates : [];
  ensureDefaultTemplate(db);

  const rows = db.homepageTemplates.filter((item) => {
    if (item.builtin) return true;
    if (auth?.role === "admin") return true;
    return String(item.ownerId || "") === String(auth?.userId || "");
  });

  return rows
    .map((item) => ({
      id: String(item.id || ""),
      ownerId: String(item.ownerId || ""),
      name: String(item.name || ""),
      type: String(item.type || "custom_html"),
      html: String(item.html || ""),
      builtin: Boolean(item.builtin),
      updatedAt: String(item.updatedAt || item.createdAt || ""),
      createdAt: String(item.createdAt || ""),
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function resolveTemplateHtml(db, config, auth) {
  db.homepageTemplates = Array.isArray(db.homepageTemplates) ? db.homepageTemplates : [];
  ensureDefaultTemplate(db);

  const templateId = String(config?.template?.template_id || DEFAULT_TEMPLATE_ID);
  let row = db.homepageTemplates.find((item) => String(item.id || "") === templateId);

  if (!row && templateId !== DEFAULT_TEMPLATE_ID) {
    row = db.homepageTemplates.find((item) => String(item.id || "") === DEFAULT_TEMPLATE_ID);
  }
  if (!row) {
    row = {
      id: DEFAULT_TEMPLATE_ID,
      ownerId: "",
      name: DEFAULT_TEMPLATE_NAME,
      type: "default_html",
      html: DEFAULT_TEMPLATE_HTML,
      builtin: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const isAllowed =
    row.builtin || auth?.role === "admin" || String(row.ownerId || "") === String(auth?.userId || "");
  if (!isAllowed) {
    throw new HttpError(403, "无权限访问该主页模板");
  }

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    html: String(row.html || DEFAULT_TEMPLATE_HTML),
    builtin: Boolean(row.builtin),
  };
}

function buildDataModel(db, device, extraData) {
  const todoRows = (db.todos || []).filter((item) => String(item.deviceId || "") === String(device.id || ""));
  const scheduleRows = (db.schedules || []).filter((item) => String(item.deviceId || "") === String(device.id || ""));

  const todoOpen = todoRows.filter((item) => !item.done);
  const todoSummary = todoOpen.length
    ? `待完成 ${todoOpen.length} 项，示例：${String(todoOpen[0].content || "-").slice(0, 40)}`
    : "今日暂无待办";

  const scheduleSummary = scheduleRows.length
    ? `今日/本周共 ${scheduleRows.length} 项，下一项：${String(scheduleRows[0].title || "-").slice(0, 40)}`
    : "暂无课程安排";

  const now = new Date().toISOString();

  const profile = {
    name: String(device.displayName || device.mac || device.id || "未命名设备"),
    title: String(device.remark || "智能墨水屏设备"),
    department: "设备平台",
    workstation: String(device.id || ""),
    status: device.online ? "在线" : "离线",
  };

  const model = {
    profile,
    todo_summary: {
      count: todoOpen.length,
      text: todoSummary,
    },
    schedule_summary: {
      count: scheduleRows.length,
      text: scheduleSummary,
    },
    custom_fields: isObject(extraData?.custom_fields) ? extraData.custom_fields : {},
    meta: {
      rendered_at: now,
      device_id: String(device.id || ""),
    },
  };

  if (isObject(extraData)) {
    return deepMerge(model, extraData);
  }
  return model;
}

async function renderHomepageBuffers({ config, templateHtml, dataModel }) {
  const width = Number(config.screen?.width || 2560);
  const height = Number(config.screen?.height || 1600);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const blocks = parseTemplateBlocks(templateHtml, dataModel, width, height);
  if (blocks.length) {
    blocks.forEach((block) => drawTextBlock(ctx, block));
  } else {
    drawFallbackHomepage(ctx, config, dataModel);
  }

  reserveTimeOverlay(ctx, config);

  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, width - 2, height - 2);

  const pngBuffer = await canvas.encode("png");
  const imageData = ctx.getImageData(0, 0, width, height);
  const epd4Buffer = rgbaToEpd4(imageData.data, width, height);
  const etag = sha256Hex(epd4Buffer);

  return {
    width,
    height,
    pngBuffer,
    epd4Buffer,
    etag,
  };
}

function resolveHomepageConfig(db, ownerId, deviceId) {
  db.homepageConfigs = Array.isArray(db.homepageConfigs) ? db.homepageConfigs : [];

  const normalizedOwnerId = String(ownerId || "");
  const normalizedDeviceId = String(deviceId || "");

  const globalRow = db.homepageConfigs
    .filter((item) => String(item.ownerId || "") === normalizedOwnerId && !item.deviceId)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];

  const deviceRow = db.homepageConfigs
    .filter(
      (item) =>
        String(item.ownerId || "") === normalizedOwnerId &&
        String(item.deviceId || "") === normalizedDeviceId
    )
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];

  const defaultConfig = loadDefaultHomepageConfig();
  let merged = normalizeHomepageConfig(defaultConfig);
  if (globalRow?.config) {
    merged = normalizeHomepageConfig(deepMerge(merged, globalRow.config));
  }
  if (deviceRow?.config) {
    merged = normalizeHomepageConfig(deepMerge(merged, deviceRow.config));
  }

  const versionBase = Math.max(
    Number(globalRow?.version || 0),
    Number(deviceRow?.version || 0),
    Number(merged.version || 1)
  );
  merged.version = versionBase || 1;

  return {
    config: merged,
    globalRow: globalRow || null,
    deviceRow: deviceRow || null,
  };
}

function getLatestHomepageImage(db, deviceId) {
  db.homepageImages = Array.isArray(db.homepageImages) ? db.homepageImages : [];
  const rows = db.homepageImages
    .filter((item) => String(item.deviceId || "") === String(deviceId || ""))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return rows[0] || null;
}

function buildDeviceHomepagePayload({ deviceId, config, imageRow }) {
  const timeOverlay = deepClone(config.time_overlay || {});
  const payload = {
    id: config.id,
    name: config.name,
    version: Number(config.version || 1),
    screen: deepClone(config.screen || {}),
    template: {
      type: String(config.template?.type || "default_html"),
      template_id: String(config.template?.template_id || DEFAULT_TEMPLATE_ID),
      template_name: String(config.template?.template_name || DEFAULT_TEMPLATE_NAME),
    },
    image: {
      format: String(config.image?.format || "epd4"),
      preview_format: String(config.image?.preview_format || "png"),
      render_source: String(config.image?.render_source || "server"),
      cache_ttl_sec: Number(config.image?.cache_ttl_sec || 3600),
      image_id: imageRow ? String(imageRow.imageFileId || "") : "",
      image_url: imageRow ? `/api/hardware/tf/download/${String(imageRow.imageFileId || "")}` : "",
      admin_image_url: imageRow ? `/api/tf/${String(imageRow.imageFileId || "")}/download` : "",
      preview_id: imageRow ? String(imageRow.previewFileId || "") : "",
      preview_url: imageRow ? `/api/hardware/tf/download/${String(imageRow.previewFileId || "")}` : "",
      admin_preview_url: imageRow ? `/api/tf/${String(imageRow.previewFileId || "")}/download` : "",
      image_width: imageRow ? Number(imageRow.width || config.screen?.width || 0) : Number(config.screen?.width || 0),
      image_height: imageRow ? Number(imageRow.height || config.screen?.height || 0) : Number(config.screen?.height || 0),
      etag: imageRow ? String(imageRow.etag || "") : "",
      updated_at: imageRow ? String(imageRow.updatedAt || "") : "",
      image_key: imageRow ? String(imageRow.imageFileId || "") : "",
    },
    time_overlay: timeOverlay,
    data_sources: deepClone(config.data_sources || {}),
    data_bindings: deepClone(config.data_bindings || {}),
    refresh_policy: deepClone(config.refresh_policy || {}),
    cache_policy: deepClone(config.cache_policy || {}),
    fallback: deepClone(config.fallback || {}),
    device_id: String(deviceId || ""),
  };

  return payload;
}

module.exports = {
  DEFAULT_TEMPLATE_ID,
  DEFAULT_TEMPLATE_NAME,
  DEFAULT_TEMPLATE_HTML,
  deepClone,
  deepMerge,
  loadDefaultHomepageConfig,
  normalizeHomepageConfig,
  listTemplates,
  resolveTemplateHtml,
  buildDataModel,
  renderHomepageBuffers,
  uploadTfBlob,
  ensureDefaultTemplate,
  resolveHomepageConfig,
  getLatestHomepageImage,
  buildDeviceHomepagePayload,
};
