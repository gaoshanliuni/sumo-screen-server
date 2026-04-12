const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess } = require("../utils/access");
const { publishDeviceEvent } = require("../utils/realtime.hub");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const {
  imageKeyForPage,
  uploadTfBlob,
} = require("./page_profile.service");

function resolveTemplateOverride(input, fallbackTemplateId) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const html = String(input.html || "").trim();
  if (!html) return null;
  return {
    id: String(input.id || fallbackTemplateId || "tpl_inline_preview"),
    name: String(input.name || "Inline Preview Template"),
    type: String(input.type || "custom_html"),
    html,
    builtin: false,
    inline: true,
  };
}

function resolveTemplateForRender({ db, mergedConfig, auth, templatePatch, service }) {
  const override = resolveTemplateOverride(templatePatch, mergedConfig?.template?.template_id);
  if (override) return override;
  return service.resolveTemplateHtml(db, mergedConfig, auth);
}

function resolveDevice({ db, auth, deviceId, skipAccessCheck = false }) {
  if (!skipAccessCheck) {
    return ensureDeviceAccess(db, auth, deviceId);
  }
  const device = db.devices.find((item) => String(item.id || "") === String(deviceId || ""));
  if (!device) {
    throw new HttpError(404, "设备不存在");
  }
  return device;
}

async function renderAndPersistForDevice({
  auth,
  deviceId,
  dataPatch,
  configPatch,
  templatePatch,
  pageType,
  service,
  skipAccessCheck = false,
}) {
  const db = await readDB();
  const device = resolveDevice({ db, auth, deviceId, skipAccessCheck });
  if (!device.ownerId) {
    throw new HttpError(400, "设备未绑定用户，无法生成页面图片");
  }

  service.ensureDefaultTemplate(db);

  const resolved = service.resolveConfig(db, device.ownerId, device.id);
  const mergedConfig = configPatch ? service.normalizeConfig(service.deepMerge(resolved.config, configPatch)) : resolved.config;
  const template = resolveTemplateForRender({ db, mergedConfig, auth, templatePatch, service });
  const model = service.buildDataModel(db, device, dataPatch);
  const rendered = await service.renderBuffers({
    config: mergedConfig,
    templateHtml: template.html,
    dataModel: model,
  });

  const now = new Date().toISOString();
  const version = `${Date.now()}-${rendered.etag.slice(0, 8)}`;

  const previewRecord = await uploadTfBlob({
    ownerId: device.ownerId,
    category: "photo",
    fileName: `${pageType}_preview_${device.id}_${version}.png`,
    mime: "image/png",
    buffer: rendered.pngBuffer,
    source: pageType,
  });

  const imageRecord = await uploadTfBlob({
    ownerId: device.ownerId,
    category: "background",
    fileName: `${pageType}_${device.id}_${version}.epd4`,
    mime: "application/x-epd4",
    buffer: rendered.epd4Buffer,
    source: pageType,
  });

  const imageRow = {
    id: createId("hpi"),
    deviceId: device.id,
    ownerId: device.ownerId,
    configVersion: Number(mergedConfig.version || 1),
    version,
    format: "epd4",
    width: rendered.width,
    height: rendered.height,
    etag: rendered.etag,
    imageFileId: imageRecord.id,
    previewFileId: previewRecord.id,
    templateId: String(template.id || ""),
    updatedAt: now,
    createdAt: now,
  };

  const imageKey = imageKeyForPage(pageType);
  await updateDB((draft) => {
    draft.tfFiles = Array.isArray(draft.tfFiles) ? draft.tfFiles : [];
    draft.tfFiles.unshift(previewRecord);
    draft.tfFiles.unshift(imageRecord);

    draft[imageKey] = Array.isArray(draft[imageKey]) ? draft[imageKey] : [];
    draft[imageKey].unshift(imageRow);

    const maxVersions = Number(mergedConfig.cache_policy?.max_versions || 3);
    const rows = draft[imageKey].filter((item) => String(item.deviceId || "") === String(device.id || ""));
    if (rows.length > maxVersions) {
      const keep = new Set(rows.slice(0, maxVersions).map((item) => String(item.id || "")));
      draft[imageKey] = draft[imageKey].filter((item) => {
        if (String(item.deviceId || "") !== String(device.id || "")) return true;
        return keep.has(String(item.id || ""));
      });
    }
  });

  const payload = service.buildDevicePayload({
    deviceId: device.id,
    config: mergedConfig,
    imageRow,
  });

  return {
    device,
    config: mergedConfig,
    template,
    rendered,
    imageRow,
    imageRecord,
    previewRecord,
    payload,
  };
}

function publishPagePushEvents({ eventPrefix, deviceId, payload }) {
  publishDeviceEvent({
    type: `${eventPrefix}.config.updated`,
    deviceId,
    payload: {
      version: payload.version,
      templateId: payload.template.template_id,
    },
  });
  publishDeviceEvent({
    type: `${eventPrefix}.image.updated`,
    deviceId,
    payload: {
      etag: payload.image.etag,
      imageUrl: payload.image.image_url,
      imageId: payload.image.image_id,
      width: payload.image.image_width,
      height: payload.image.image_height,
      format: payload.image.format,
    },
  });
  publishDeviceEvent({
    type: `${eventPrefix}.updated`,
    deviceId,
    payload: {
      configVersion: payload.version,
      image: payload.image,
      time_overlay: payload.time_overlay,
      refresh_control: payload.refresh_control || {},
      fallback: payload.fallback,
    },
  });
}

module.exports = {
  renderAndPersistForDevice,
  publishPagePushEvents,
};

