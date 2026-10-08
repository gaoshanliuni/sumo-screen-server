const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess } = require("../utils/access");
const { logOperation } = require("../utils/logging");
const { normalizeTemplateRefreshConfig } = require("../services/api_template_refresh_config.service");
const { paginateRows } = require("../repositories/pagination");

const router = express.Router();
const KEYIN_ALLOWED = new Set(["header", "query", "body"]);

function normalizeKeyIn(input) {
  const list = Array.isArray(input) ? input : [input];
  const normalized = [];
  list.forEach((item) => {
    const value = String(item || "").trim().toLowerCase();
    if (!value || !KEYIN_ALLOWED.has(value)) return;
    if (!normalized.includes(value)) normalized.push(value);
  });
  return normalized.length ? normalized : ["query"];
}

function normalizeKeyConcatFields(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(",");
  const normalized = [];
  list.forEach((item) => {
    const value = String(item || "").trim();
    if (!value) return;
    if (!normalized.includes(value)) normalized.push(value);
  });
  return normalized;
}

function normalizeKeyConcatSeparator(input) {
  const value = String(input || "|").trim();
  return value || "|";
}

function normalizeUserInputFields(input) {
  if (!Array.isArray(input)) return [];
  const rows = [];
  input.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const name = String(item.name || "").trim();
    if (!name) return;
    const placeholder = String(item.placeholder || item.hint || "").trim();
    rows.push({ name, placeholder });
  });
  return rows;
}

function normalizeAdvancedConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const cfg = { ...input };
  cfg.steps = Array.isArray(input.steps) ? input.steps : [];
  return cfg;
}

function buildLegacyAdvancedConfig(method, url) {
  return {
    output: "",
    timeoutMs: 8000,
    steps: [
      {
        name: "step1",
        method: String(method || "GET").toUpperCase(),
        url: String(url || ""),
        legacyCompat: true,
        passInputParams: true,
        headers: {},
        params: {},
        body: {},
        extract: [],
      },
    ],
  };
}

function ensureAdvancedConfig(input, method, url) {
  const normalized = normalizeAdvancedConfig(input);
  if (Array.isArray(normalized.steps) && normalized.steps.length) return normalized;
  return buildLegacyAdvancedConfig(method, url);
}

router.get(
  "/",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const list = req.auth.role === "admin" ? db.apiTemplates : db.apiTemplates.filter((item) => item.enabled);
    if (req.query?.page !== undefined || req.query?.pageSize !== undefined || String(req.query?.paged || "") === "true") {
      return res.success(paginateRows(list, { page: req.query?.page || 1, pageSize: req.query?.pageSize || 20 }), "ok");
    }
    return res.success(list, "ok");
  })
);

router.post(
  "/",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const {
      name,
      slug,
      method = "GET",
      url,
      keyField = "key",
      keyIn = "query",
      keyConcatEnabled = false,
      keyConcatFields = [],
      keyConcatSeparator = "|",
      userInputFields = [],
      deviceKeyRequired = true,
      defaultParams = {},
      enabled = true,
      advancedConfig = {},
      refreshConfig = undefined,
    } = req.body || {};

    if (!name || !slug) throw new HttpError(400, "name/slug为必填项");
    const nextSlug = String(slug).trim();
    const db = await readDB();
    const duplicate = db.apiTemplates.find((item) => item.slug === nextSlug);
    if (duplicate) throw new HttpError(409, "slug已存在");

    const now = new Date().toISOString();
    const normalizedMethod = String(method || "GET").toUpperCase();
    const normalizedUrl = String(url || "");
    const row = {
      id: createId("tpl"),
      name: String(name),
      slug: nextSlug,
      method: normalizedMethod,
      url: normalizedUrl,
      keyField: String(keyField || ""),
      keyIn: normalizeKeyIn(keyIn),
      keyConcatEnabled: Boolean(keyConcatEnabled),
      keyConcatFields: normalizeKeyConcatFields(keyConcatFields),
      keyConcatSeparator: normalizeKeyConcatSeparator(keyConcatSeparator),
      userInputFields: normalizeUserInputFields(userInputFields),
      deviceKeyRequired: Boolean(deviceKeyRequired),
      defaultParams: typeof defaultParams === "object" && !Array.isArray(defaultParams) ? defaultParams : {},
      enabled: Boolean(enabled),
      advancedConfig: ensureAdvancedConfig(advancedConfig, normalizedMethod, normalizedUrl),
      refreshConfig: normalizeTemplateRefreshConfig(refreshConfig, { slug: nextSlug }),
      builtin: false,
      createdAt: now,
      updatedAt: now,
    };

    await updateDB((draft) => {
      draft.apiTemplates.push(row);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "template.create",
      targetType: "api_template",
      targetId: row.id,
      detail: { slug: row.slug },
    });

    res.success(row, "模板创建成功");
  })
);

router.post(
  "/:templateId",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { templateId } = req.params;
    const payload = req.body || {};
    let updated = null;

    await updateDB((draft) => {
      const tpl = draft.apiTemplates.find((item) => item.id === templateId);
      if (!tpl) throw new HttpError(404, "模板不存在");

      const allowed = [
        "name",
        "slug",
        "method",
        "url",
        "keyField",
        "keyIn",
        "keyConcatEnabled",
        "keyConcatFields",
        "keyConcatSeparator",
        "userInputFields",
        "deviceKeyRequired",
        "defaultParams",
        "enabled",
        "advancedConfig",
        "refreshConfig",
      ];
      Object.keys(payload).forEach((key) => {
        if (!allowed.includes(key)) return;
        if (key === "method") tpl.method = String(payload.method).toUpperCase();
        else if (key === "keyIn") tpl.keyIn = normalizeKeyIn(payload.keyIn);
        else if (key === "keyConcatEnabled") tpl.keyConcatEnabled = Boolean(payload.keyConcatEnabled);
        else if (key === "keyConcatFields") tpl.keyConcatFields = normalizeKeyConcatFields(payload.keyConcatFields);
        else if (key === "keyConcatSeparator") tpl.keyConcatSeparator = normalizeKeyConcatSeparator(payload.keyConcatSeparator);
        else if (key === "userInputFields") tpl.userInputFields = normalizeUserInputFields(payload.userInputFields);
        else if (key === "advancedConfig") {
          tpl.advancedConfig = normalizeAdvancedConfig(payload.advancedConfig);
        }
        else if (key === "refreshConfig") {
          tpl.refreshConfig = normalizeTemplateRefreshConfig(payload.refreshConfig, { slug: tpl.slug });
        }
        else tpl[key] = payload[key];
      });
      tpl.refreshConfig = normalizeTemplateRefreshConfig(tpl.refreshConfig, { slug: tpl.slug });
      tpl.advancedConfig = ensureAdvancedConfig(tpl.advancedConfig, tpl.method, tpl.url);
      const firstStep = Array.isArray(tpl.advancedConfig?.steps) ? tpl.advancedConfig.steps[0] : null;
      if (firstStep && firstStep.legacyCompat) {
        firstStep.method = String(tpl.method || firstStep.method || "GET").toUpperCase();
        firstStep.url = String(tpl.url || firstStep.url || "");
      }
      tpl.updatedAt = new Date().toISOString();
      updated = tpl;
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "template.update",
      targetType: "api_template",
      targetId: templateId,
    });

    res.success(updated, "模板已更新");
  })
);

router.post(
  "/:templateId/delete",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { templateId } = req.params;
    let removed = null;

    await updateDB((draft) => {
      const index = draft.apiTemplates.findIndex((item) => item.id === templateId);
      if (index < 0) throw new HttpError(404, "模板不存在");
      removed = draft.apiTemplates[index];
      draft.apiTemplates.splice(index, 1);
      draft.devices.forEach((device) => {
        if (device.apiKeys) {
          delete device.apiKeys[removed.slug];
        }
      });
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "template.delete",
      targetType: "api_template",
      targetId: templateId,
      detail: { slug: removed?.slug || "" },
    });

    res.success({ id: templateId }, "模板已删除");
  })
);

router.get(
  "/device/:deviceId/keys",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, req.params.deviceId);
    res.success(device.apiKeys || {}, "ok");
  })
);

router.post(
  "/device/:deviceId/keys",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const device = ensureDeviceAccess(db, req.auth, req.params.deviceId);
    const { keys = {} } = req.body || {};
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
      throw new HttpError(400, "keys格式错误");
    }
    const slugs = new Set(db.apiTemplates.map((item) => item.slug));
    const invalid = Object.keys(keys).find((slug) => !slugs.has(slug));
    if (invalid) throw new HttpError(400, `模板不存在: ${invalid}`);

    let next = {};
    await updateDB((draft) => {
      const target = draft.devices.find((item) => item.id === device.id);
      target.apiKeys = {};
      Object.keys(keys).forEach((slug) => {
        const value = keys[slug];
        if (value !== null && value !== undefined && value !== "") {
          target.apiKeys[slug] = String(value);
        }
      });
      target.updatedAt = new Date().toISOString();
      next = target.apiKeys;
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "template.device_keys_replace",
      targetType: "device",
      targetId: device.id,
      detail: { keys: Object.keys(next) },
    });

    res.success(next, "设备密钥已覆盖更新");
  })
);

module.exports = router;
