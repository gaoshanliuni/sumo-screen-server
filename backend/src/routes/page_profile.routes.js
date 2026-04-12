const express = require("express");

const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const config = require("../config");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess, resolveTargetDeviceIds } = require("../utils/access");
const { publishDeviceEvent } = require("../utils/realtime.hub");
const { logOperation } = require("../utils/logging");
const { renderAndPersistForDevice: renderAndPersistForDeviceShared, publishPagePushEvents } = require("../services/page_push.service");
const { normalizeAutoRenderPushConfig } = require("../services/homepage_auto_push_time.service");
const {
  configKeyForPage,
  imageKeyForPage,
  uploadTfBlob,
} = require("../services/page_profile.service");

function normalizeIdList(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof input === "string") {
    return [...new Set(input.split(",").map((item) => String(item || "").trim()).filter(Boolean))];
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
  return arr.slice(0, Math.floor(count));
}

function resolveTargets(db, auth, body) {
  const single = String(body?.deviceId || "").trim();
  const deviceIds = normalizeIdList(body?.deviceIds);
  const clusterIds = normalizeIdList(body?.clusterIds);
  const randomCount = Number(body?.randomCount || 0);
  const merged = new Set(resolveTargetDeviceIds(db, deviceIds, clusterIds));
  if (single) merged.add(single);

  if (!merged.size) {
    throw new HttpError(400, "至少提供一个目标设备");
  }

  const denied = [];
  const allowed = [];
  [...merged].forEach((id) => {
    try {
      ensureDeviceAccess(db, auth, id);
      allowed.push(id);
    } catch (error) {
      denied.push({ deviceId: id, reason: error?.message || "无权限或设备不存在" });
    }
  });

  return {
    targetIds: sampleRandomIds(allowed, randomCount),
    denied,
    requestedCount: merged.size,
  };
}

function buildVariableExample(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (!json) return "";
    return json.length > 120 ? `${json.slice(0, 117)}...` : json;
  } catch (_) {
    return "";
  }
}

function collectTemplateVariables(model) {
  const out = [];
  const seen = new Set();
  const MAX_DEPTH = 6;
  const MAX_ROWS = 2000;

  const pushPath = (path, value) => {
    if (!path || seen.has(path) || out.length >= MAX_ROWS) {
      return;
    }
    seen.add(path);
    const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    out.push({
      path,
      placeholder: `{{${path}}}`,
      type,
      example: buildVariableExample(value),
    });
  };

  const walk = (node, path, depth) => {
    if (out.length >= MAX_ROWS || depth > MAX_DEPTH) {
      return;
    }
    if (node === null || node === undefined) {
      pushPath(path, node);
      return;
    }

    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      pushPath(path, node);
      return;
    }

    if (Array.isArray(node)) {
      pushPath(path, node);
      if (!node.length) {
        return;
      }
      const first = node[0];
      const childPath = path ? `${path}.0` : "0";
      walk(first, childPath, depth + 1);
      return;
    }

    if (typeof node === "object") {
      if (path) {
        pushPath(path, node);
      }
      Object.keys(node).forEach((key) => {
        if (out.length >= MAX_ROWS) return;
        const nextPath = path ? `${path}.${key}` : key;
        walk(node[key], nextPath, depth + 1);
      });
    }
  };

  // Ensure every API template slug has at least canonical variable roots exposed,
  // even when total variable count reaches truncation threshold.
  const formattedBySlug =
    model && model.api && typeof model.api === "object" && model.api.formatted_by_slug && typeof model.api.formatted_by_slug === "object"
      ? model.api.formatted_by_slug
      : {};
  const rawBySlug =
    model && model.api && typeof model.api === "object" && model.api.raw_by_slug && typeof model.api.raw_by_slug === "object"
      ? model.api.raw_by_slug
      : {};
  const thirdBySlug = model && model.third && typeof model.third === "object" ? model.third : {};

  Object.keys(formattedBySlug).forEach((slug) => {
    if (!slug) return;
    if (Object.prototype.hasOwnProperty.call(formattedBySlug, slug)) {
      pushPath(`api.formatted_by_slug.${slug}`, formattedBySlug[slug]);
      pushPath(`${slug}`, formattedBySlug[slug]);
    }
    if (Object.prototype.hasOwnProperty.call(rawBySlug, slug)) {
      pushPath(`api.raw_by_slug.${slug}`, rawBySlug[slug]);
    }
    if (Object.prototype.hasOwnProperty.call(thirdBySlug, slug)) {
      pushPath(`third.${slug}`, thirdBySlug[slug]);
    }
  });

  walk(model || {}, "", 0);
  return out;
}

function createPageRouter(options) {
  const {
    pageType,
    pageLabel,
    eventPrefix,
    service,
  } = options || {};

  if (!pageType || !service) {
    throw new Error("createPageRouter: invalid options");
  }

  const configKey = configKeyForPage(pageType);
  const imageKey = imageKeyForPage(pageType);

  const router = express.Router();
  router.use(allowRoles("admin", "user"));

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

  function resolveTemplateForRender({ db, mergedConfig, auth, templatePatch }) {
    const override = resolveTemplateOverride(templatePatch, mergedConfig?.template?.template_id);
    if (override) return override;
    return service.resolveTemplateHtml(db, mergedConfig, auth);
  }

  async function renderPreviewForDevice({ auth, deviceId, dataPatch, configPatch, templatePatch }) {
    const db = await readDB();
    const device = ensureDeviceAccess(db, auth, deviceId);
    if (!device.ownerId) {
      throw new HttpError(400, "设备未绑定用户，无法生成页面图片");
    }

    service.ensureDefaultTemplate(db);

    const resolved = service.resolveConfig(db, device.ownerId, device.id);
    const mergedConfig = configPatch ? service.normalizeConfig(service.deepMerge(resolved.config, configPatch)) : resolved.config;

    const template = resolveTemplateForRender({ db, mergedConfig, auth, templatePatch });
    const model = service.buildDataModel(db, device, dataPatch);
    const rendered = await service.renderBuffers({
      config: mergedConfig,
      templateHtml: template.html,
      dataModel: model,
    });

    const payload = service.buildDevicePayload({
      deviceId: device.id,
      config: mergedConfig,
      imageRow: null,
    });
    payload.template = {
      ...payload.template,
      type: String(template.type || payload.template?.type || "custom_html"),
      template_id: String(template.id || payload.template?.template_id || ""),
      template_name: String(template.name || payload.template?.template_name || ""),
    };
    payload.image = {
      ...payload.image,
      image_id: "",
      image_url: "",
      admin_image_url: "",
      preview_id: "",
      preview_url: "",
      admin_preview_url: "",
      image_width: rendered.width,
      image_height: rendered.height,
      etag: rendered.etag,
      preview_data_url: `data:image/png;base64,${rendered.pngBuffer.toString("base64")}`,
      preview_only: true,
    };
    payload.render_debug = rendered.debug || {};

    return {
      device,
      config: mergedConfig,
      template,
      rendered,
      payload,
    };
  }

  async function renderAndPersistForDevice({ auth, deviceId, dataPatch, configPatch, templatePatch }) {
    const db = await readDB();
    const device = ensureDeviceAccess(db, auth, deviceId);
    if (!device.ownerId) {
      throw new HttpError(400, "设备未绑定用户，无法生成页面图片");
    }

    service.ensureDefaultTemplate(db);

    const resolved = service.resolveConfig(db, device.ownerId, device.id);
    const mergedConfig = configPatch ? service.normalizeConfig(service.deepMerge(resolved.config, configPatch)) : resolved.config;

    const template = resolveTemplateForRender({ db, mergedConfig, auth, templatePatch });
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
      imageRow,
      imageRecord,
      previewRecord,
      payload,
    };
  }

  router.get(
    "/default",
    asyncHandler(async (req, res) => {
      const config = service.normalizeConfig(service.loadDefaultConfig());
      res.success(config, "ok");
    })
  );

  router.get(
    "/templates",
    asyncHandler(async (req, res) => {
      const db = await readDB();
      const rows = service.listTemplates(db, req.auth);
      res.success(rows, "ok");
    })
  );

  router.get(
    "/template-variables",
    asyncHandler(async (req, res) => {
      const db = await readDB();
      const requestedId = String(req.query?.deviceId || "").trim();

      let device = null;
      if (requestedId) {
        device = ensureDeviceAccess(db, req.auth, requestedId);
      } else {
        const rows = db.devices.filter((item) => {
          if (req.auth.role === "admin") return true;
          return String(item.ownerId || "") === String(req.auth.userId || "");
        });
        device = rows[0] || null;
      }

      if (!device) throw new HttpError(404, "当前账号无可用设备");

      const dataModel = service.buildDataModel(db, device, {});
      const variables = collectTemplateVariables(dataModel);
      res.success(
        {
          deviceId: String(device.id || ""),
          total: variables.length,
          variables,
        },
        "ok"
      );
    })
  );

  router.post(
    "/templates",
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const name = String(body.name || "").trim();
      const html = String(body.html || "").trim();
      const type = String(body.type || "custom_html").trim() || "custom_html";
      const templateId = String(body.id || "").trim();

      if (!name) throw new HttpError(400, "name不能为空");
      if (!html) throw new HttpError(400, "html不能为空");

      const now = new Date().toISOString();
      let row = null;

      await updateDB((draft) => {
        const templateKey = service.templateKey;
        draft[templateKey] = Array.isArray(draft[templateKey]) ? draft[templateKey] : [];
        service.ensureDefaultTemplate(draft);

        if (templateId) {
          const target = draft[templateKey].find((item) => String(item.id || "") === templateId);
          if (!target) throw new HttpError(404, "模板不存在");
          if (target.builtin) throw new HttpError(400, "内置模板不可直接覆盖");
          if (req.auth.role !== "admin" && String(target.ownerId || "") !== String(req.auth.userId || "")) {
            throw new HttpError(403, "无权限修改该模板");
          }
          target.name = name;
          target.type = type;
          target.html = html;
          target.updatedAt = now;
          row = { ...target };
        } else {
          row = {
            id: createId("hpt"),
            ownerId: req.auth.role === "admin" ? String(body.ownerId || req.auth.userId || "") : String(req.auth.userId || ""),
            name,
            type,
            html,
            builtin: false,
            createdAt: now,
            updatedAt: now,
          };
          draft[templateKey].unshift(row);
        }
      });

      await logOperation({
        actorId: req.auth.userId,
        actorRole: req.auth.role,
        action: templateId ? `${pageType}.template.update` : `${pageType}.template.create`,
        targetType: `${pageType}_template`,
        targetId: String(row?.id || ""),
        detail: { name: row?.name || "" },
      });

      res.success(row, templateId ? "模板已更新" : "模板已创建");
    })
  );

  router.post(
    "/templates/:templateId/delete",
    asyncHandler(async (req, res) => {
      const templateId = String(req.params.templateId || "").trim();
      if (!templateId) throw new HttpError(400, "templateId不能为空");

      const db = await readDB();
      const rows = Array.isArray(db[service.templateKey]) ? db[service.templateKey] : [];
      const current = rows.find((item) => String(item.id || "") === templateId);
      if (!current) throw new HttpError(404, "模板不存在");
      if (current.builtin) throw new HttpError(400, "内置模板不可删除");
      if (req.auth.role !== "admin" && String(current.ownerId || "") !== String(req.auth.userId || "")) {
        throw new HttpError(403, "无权限删除该模板");
      }

      await updateDB((draft) => {
        draft[service.templateKey] = (draft[service.templateKey] || []).filter((item) => String(item.id || "") !== templateId);
      });

      res.success({ id: templateId }, "模板已删除");
    })
  );

  router.get(
    "/config",
    asyncHandler(async (req, res) => {
      const db = await readDB();
      const requestedId = String(req.query?.deviceId || "").trim();

      let device = null;
      if (requestedId) {
        device = ensureDeviceAccess(db, req.auth, requestedId);
      } else {
        const rows = db.devices.filter((item) => {
          if (req.auth.role === "admin") return true;
          return String(item.ownerId || "") === String(req.auth.userId || "");
        });
        device = rows[0] || null;
      }

      if (!device) throw new HttpError(404, "当前账号无可用设备");

      const resolved = service.resolveConfig(db, device.ownerId, device.id);
      const imageRow = service.getLatestImage(db, device.id);
      const payload = service.buildDevicePayload({
        deviceId: device.id,
        config: resolved.config,
        imageRow,
      });

      res.success(payload, "ok");
    })
  );

  router.post(
    "/config",
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const configPatch = body?.config;
      if (!configPatch || typeof configPatch !== "object" || Array.isArray(configPatch)) {
        throw new HttpError(400, "config不能为空");
      }

      const db = await readDB();
      const requestedDeviceId = String(body.deviceId || "").trim();

      let ownerId = req.auth.role === "admin" ? String(body.ownerId || req.auth.userId || "") : String(req.auth.userId || "");
      let deviceId = "";
      if (requestedDeviceId) {
        const device = ensureDeviceAccess(db, req.auth, requestedDeviceId);
        ownerId = String(device.ownerId || ownerId);
        deviceId = String(device.id || "");
      }

      const now = new Date().toISOString();
      let row = null;
      await updateDB((draft) => {
        draft[configKey] = Array.isArray(draft[configKey]) ? draft[configKey] : [];
        const current = draft[configKey].find(
          (item) => String(item.ownerId || "") === ownerId && String(item.deviceId || "") === deviceId
        );

        if (current) {
          const mergedConfig = service.deepMerge(current.config || {}, configPatch);
          const normalizedConfig = service.normalizeConfig(mergedConfig);
          if (pageType === "homepage") {
            normalizedConfig.auto_render_push = normalizeAutoRenderPushConfig(
              normalizedConfig.auto_render_push || {},
              {
                now: new Date(),
                timeZone: config.timezone || "Asia/Shanghai",
                recomputeNext: true,
              }
            );
          }
          current.config = normalizedConfig;
          current.version = Number(current.version || 0) + 1;
          current.updatedAt = now;
          current.updatedBy = String(req.auth.userId || "");
          row = { ...current };
        } else {
          const normalizedConfig = service.normalizeConfig(configPatch);
          if (pageType === "homepage") {
            normalizedConfig.auto_render_push = normalizeAutoRenderPushConfig(
              normalizedConfig.auto_render_push || {},
              {
                now: new Date(),
                timeZone: config.timezone || "Asia/Shanghai",
                recomputeNext: true,
              }
            );
          }
          row = {
            id: createId("hpc"),
            ownerId,
            deviceId,
            config: normalizedConfig,
            version: 1,
            createdAt: now,
            updatedAt: now,
            updatedBy: String(req.auth.userId || ""),
          };
          draft[configKey].unshift(row);
        }
      });

      await logOperation({
        actorId: req.auth.userId,
        actorRole: req.auth.role,
        action: `${pageType}.config.upsert`,
        targetType: deviceId ? `${pageType}_device_config` : `${pageType}_owner_config`,
        targetId: String(row?.id || ""),
        detail: {
          ownerId,
          deviceId,
          version: Number(row?.version || 1),
        },
      });

      if (deviceId) {
        publishDeviceEvent({
          type: `${eventPrefix}.config.updated`,
          deviceId,
          payload: {
            version: Number(row?.version || 1),
            source: `${eventPrefix}.config`,
          },
        });
      }

      res.success(row, "配置已保存");
    })
  );

  router.post(
    "/render",
    asyncHandler(async (req, res) => {
      const deviceId = String(req.body?.deviceId || "").trim();
      if (!deviceId) throw new HttpError(400, "deviceId不能为空");

      const result = await renderPreviewForDevice({
        auth: req.auth,
        deviceId,
        dataPatch: req.body?.data,
        configPatch: req.body?.config,
        templatePatch: req.body?.template,
      });

      await logOperation({
        actorId: req.auth.userId,
        actorRole: req.auth.role,
        action: `${pageType}.render`,
        targetType: "device",
        targetId: deviceId,
        detail: {
          etag: result.rendered.etag,
          previewOnly: true,
        },
      });

      res.success(result.payload, `${pageLabel}已渲染`);
    })
  );

  router.post(
    "/push",
    asyncHandler(async (req, res) => {
      const db = await readDB();
      const target = resolveTargets(db, req.auth, req.body || {});
      if (!target.targetIds.length) {
        return res.success(
          {
            total: target.requestedCount,
            successCount: 0,
            failedCount: target.denied.length,
            failed: target.denied,
          },
          "没有可下发设备"
        );
      }

      const success = [];
      const failed = [...target.denied];

      for (const deviceId of target.targetIds) {
        try {
          const rendered = await renderAndPersistForDeviceShared({
            auth: req.auth,
            deviceId,
            dataPatch: req.body?.data,
            configPatch: req.body?.config,
            templatePatch: req.body?.template,
            pageType,
            service,
          });

          publishPagePushEvents({
            eventPrefix,
            deviceId,
            payload: rendered.payload,
          });

          success.push({
            deviceId,
            imageId: rendered.payload.image.image_id,
            imageUrl: rendered.payload.image.image_url,
            etag: rendered.payload.image.etag,
          });
        } catch (error) {
          failed.push({
            deviceId,
            reason: error?.message || `${pageLabel}推送失败`,
          });
        }
      }

      await logOperation({
        actorId: req.auth.userId,
        actorRole: req.auth.role,
        action: `${pageType}.push`,
        targetType: "device_batch",
        targetId: `count:${target.targetIds.length}`,
        detail: {
          requestedCount: target.requestedCount,
          successCount: success.length,
          failedCount: failed.length,
        },
      });

      res.success(
        {
          total: target.requestedCount,
          successCount: success.length,
          failedCount: failed.length,
          success,
          failed,
        },
        success.length ? `${pageLabel}已推送` : `${pageLabel}推送失败`
      );
    })
  );

  return router;
}

module.exports = {
  createPageRouter,
};
