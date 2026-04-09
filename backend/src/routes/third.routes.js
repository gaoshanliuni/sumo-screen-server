const express = require("express");
const axios = require("axios");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess } = require("../utils/access");
const { logApi } = require("../utils/logging");
const config = require("../config");

const router = express.Router();

function buildThirdCacheEntry(tpl, advancedResult) {
  const steps = Array.isArray(advancedResult?.steps)
    ? advancedResult.steps.slice(-5).map((step) => ({
        name: String(step?.name || ""),
        status: Number(step?.status || 0),
        output: step?.output !== undefined ? step.output : step?.raw,
      }))
    : [];

  return {
    template: {
      slug: String(tpl?.slug || ""),
      name: String(tpl?.name || ""),
    },
    formatted: advancedResult?.output !== undefined ? advancedResult.output : null,
    raw: {
      output: advancedResult?.output !== undefined ? advancedResult.output : null,
      vars: advancedResult?.vars && typeof advancedResult.vars === "object" ? advancedResult.vars : {},
      steps,
    },
    updatedAt: new Date().toISOString(),
  };
}

function formatBuiltin(slug, raw) {
  if (slug === "weather" && raw) {
    const now = raw.now || raw.data?.now || raw.data || {};
    const hourly = Array.isArray(raw.hourly) ? raw.hourly : Array.isArray(raw.data?.hourly) ? raw.data.hourly : [];
    const daily = Array.isArray(raw.daily) ? raw.daily : Array.isArray(raw.data?.daily) ? raw.data.daily : [];
    return {
      temperature: now.temp || now.temperature || "",
      humidity: now.humidity || "",
      weather: now.text || now.weather || "",
      windDir: now.windDir || "",
      windScale: now.windScale || "",
      observeTime: now.obsTime || now.observeTime || "",
      location: raw.location || "",
      hourly,
      daily,
    };
  }

  if (slug === "zaoan" || slug === "wanan") {
    if (typeof raw === "string") return { text: raw };
    return { text: raw?.data || raw?.msg || raw?.text || JSON.stringify(raw) };
  }

  if (slug === "bulletin") {
    if (Array.isArray(raw?.data)) return { items: raw.data };
    return { data: raw };
  }

  if (slug === "addressparse") {
    return raw?.data || raw;
  }

  if (slug === "amap_geocode") {
    const first = Array.isArray(raw?.geocodes) ? raw.geocodes[0] : null;
    const location = first?.location || "";
    let lng = "";
    let lat = "";
    if (location && location.includes(",")) {
      [lng, lat] = location.split(",");
    }
    return {
      location,
      lng,
      lat,
      raw,
    };
  }

  return raw;
}

function buildVarMap(device, tpl, inputParams, vars) {
  const map = {};
  Object.keys(inputParams || {}).forEach((key) => {
    map[`input.${key}`] = inputParams[key];
  });
  map["device.id"] = device.id;
  map["device.mac"] = device.mac;
  map["device.ownerId"] = device.ownerId || "";
  map["device.status"] = device.status || "";
  map["device.type"] = device.type || "";
  map["deviceKey"] = device.apiKeys?.[tpl.slug] || "";
  Object.keys(vars || {}).forEach((key) => {
    map[key] = vars[key];
    map[`vars.${key}`] = vars[key];
  });
  return map;
}

function resolveTemplateString(value, varMap) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, key) => {
    const raw = varMap[key.trim()];
    return raw === undefined || raw === null ? "" : String(raw);
  });
}

function resolveTemplateObject(obj, varMap) {
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveTemplateObject(item, varMap));
  }
  if (obj && typeof obj === "object") {
    const next = {};
    Object.keys(obj).forEach((key) => {
      next[key] = resolveTemplateObject(obj[key], varMap);
    });
    return next;
  }
  return resolveTemplateString(obj, varMap);
}

function getByPath(payload, path) {
  if (!payload || !path) return undefined;
  const parts = String(path).split(".");
  let current = payload;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function normalizeKeyIn(input) {
  const list = Array.isArray(input) ? input : [input || "query"];
  const normalized = [];
  list.forEach((item) => {
    const value = String(item || "").toLowerCase().trim();
    if (value !== "header" && value !== "query" && value !== "body") return;
    if (!normalized.includes(value)) normalized.push(value);
  });
  return normalized.length ? normalized : ["query"];
}

function resolveKeyPairs(tpl, rawKey) {
  const keyPairs = [];
  const concatEnabled = Boolean(tpl.keyConcatEnabled);
  const concatFields = Array.isArray(tpl.keyConcatFields)
    ? tpl.keyConcatFields.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  if (concatEnabled && concatFields.length > 1) {
    const sep = String(tpl.keyConcatSeparator || "|");
    const parts = String(rawKey || "").split(sep);
    concatFields.forEach((field, idx) => {
      const value = String(parts[idx] || "").trim();
      if (!field || !value) return;
      keyPairs.push({ field, value });
    });
    if (keyPairs.length) return keyPairs;
  }
  const keyField = String(tpl.keyField || "key").trim() || "key";
  if (!rawKey) return [];
  return [{ field: keyField, value: String(rawKey) }];
}

function buildWeatherUrl(sourceNowUrl, segment) {
  const nowUrl = String(sourceNowUrl || "").trim() || "https://devapi.qweather.com/v7/weather/now";
  if (nowUrl.includes("/weather/now")) {
    return nowUrl.replace("/weather/now", `/weather/${segment}`);
  }
  try {
    const parsed = new URL(nowUrl);
    return `${parsed.origin}/v7/weather/${segment}`;
  } catch (_) {
    return `https://devapi.qweather.com/v7/weather/${segment}`;
  }
}

function buildLegacyAdvancedConfig(tpl) {
  return {
    output: "",
    timeoutMs: config.requestTimeoutMs,
    steps: [
      {
        name: "step1",
        method: String(tpl.method || "GET").toUpperCase(),
        url: String(tpl.url || ""),
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

function ensureAdvancedTemplateConfig(tpl) {
  const cfg =
    tpl?.advancedConfig && typeof tpl.advancedConfig === "object" && !Array.isArray(tpl.advancedConfig)
      ? tpl.advancedConfig
      : {};
  const steps = Array.isArray(cfg.steps) ? cfg.steps : [];
  if (steps.length) return cfg;
  return buildLegacyAdvancedConfig(tpl);
}

async function runLegacyCompatRequest(tpl, device, inputParams, step, method, url, resolvedHeaders, resolvedParams, resolvedBody) {
  const requestMethod = String(method || tpl.method || "GET").toUpperCase();
  const headers = { ...(resolvedHeaders || {}) };
  const mergedInput = step?.passInputParams === false ? {} : inputParams;
  let queryParams = requestMethod === "GET" ? { ...mergedInput, ...(resolvedParams || {}) } : { ...(resolvedParams || {}) };
  let bodyParams = requestMethod === "GET" ? { ...(resolvedBody || {}) } : { ...mergedInput, ...(resolvedBody || {}) };

  if (tpl.deviceKeyRequired) {
    const key = device.apiKeys?.[tpl.slug];
    if (!key) throw new HttpError(400, `设备未配置 ${tpl.name} 密钥`);
    const keyIn = normalizeKeyIn(tpl.keyIn);
    resolveKeyPairs(tpl, key).forEach(({ field, value }) => {
      if (keyIn.includes("header")) headers[field] = value;
      if (keyIn.includes("query")) queryParams[field] = value;
      if (requestMethod !== "GET" && keyIn.includes("body")) bodyParams[field] = value;
    });
  }

  if (tpl.slug === "weather") {
    const merged = requestMethod === "GET" ? { ...queryParams } : { ...queryParams, ...bodyParams };
    const location = String(merged.location || merged.cityId || merged.cityID || "").trim();
    if (!location) throw new HttpError(400, "天气城市ID不能为空");

    const keyField = String(tpl.keyField || "key").trim() || "key";
    const weatherKey = String(merged[keyField] || headers[keyField] || device.apiKeys?.[tpl.slug] || "").trim();
    if (tpl.deviceKeyRequired && !weatherKey) throw new HttpError(400, `设备未配置 ${tpl.name} 密钥`);

    const weatherParams = { location };
    if (weatherKey) weatherParams[keyField] = weatherKey;
    if (merged.lang) weatherParams.lang = merged.lang;
    if (merged.unit) weatherParams.unit = merged.unit;

    const nowResponse = await axios.get(url, {
      params: weatherParams,
      headers,
      timeout: config.requestTimeoutMs,
    });
    let hourly = [];
    let daily = [];
    try {
      const hourlyResponse = await axios.get(buildWeatherUrl(url, "24h"), {
        params: weatherParams,
        headers,
        timeout: config.requestTimeoutMs,
      });
      hourly = Array.isArray(hourlyResponse.data?.hourly) ? hourlyResponse.data.hourly : [];
    } catch (_) {
      hourly = [];
    }
    try {
      const dailyResponse = await axios.get(buildWeatherUrl(url, "7d"), {
        params: weatherParams,
        headers,
        timeout: config.requestTimeoutMs,
      });
      daily = Array.isArray(dailyResponse.data?.daily) ? dailyResponse.data.daily : [];
    } catch (_) {
      daily = [];
    }

    const nowRaw = nowResponse.data || {};
    const raw = {
      ...nowRaw,
      location,
      now: nowRaw.now || nowRaw.data?.now || nowRaw.data || {},
      hourly,
      daily,
    };
    return {
      status: nowResponse.status,
      headers: nowResponse.headers || {},
      raw,
      output: formatBuiltin(tpl.slug, raw),
    };
  }

  const requestUrl = String(url || tpl.url || "");
  let response;
  if (requestMethod === "GET") {
    response = await axios.get(requestUrl, {
      params: queryParams,
      headers,
      timeout: config.requestTimeoutMs,
    });
  } else {
    response = await axios({
      method: requestMethod,
      url: requestUrl,
      params: queryParams,
      data: bodyParams,
      headers,
      timeout: config.requestTimeoutMs,
    });
  }
  return {
    status: response.status,
    headers: response.headers || {},
    raw: response.data,
    output: formatBuiltin(tpl.slug, response.data),
  };
}

async function runAdvancedTemplate(tpl, device, inputParams) {
  const config = ensureAdvancedTemplateConfig(tpl);
  const steps = Array.isArray(config.steps) ? config.steps : [];
  if (!steps.length) throw new HttpError(400, "高级配置未定义 steps");

  const vars = {};
  const results = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] || {};
    const varMap = buildVarMap(device, tpl, inputParams, vars);
    const url = resolveTemplateString(step.url || "", varMap);
    if (!url) throw new HttpError(400, `高级配置 step${index + 1} url 为空`);

    const method = String(step.method || "GET").toUpperCase();
    const headers = resolveTemplateObject(step.headers || {}, varMap);
    const params = resolveTemplateObject(step.params || {}, varMap);
    const body = resolveTemplateObject(step.body || {}, varMap);

    let raw = null;
    let status = 200;
    let responseHeaders = {};
    let output = undefined;

    if (step.legacyCompat) {
      const legacy = await runLegacyCompatRequest(tpl, device, inputParams, step, method, url, headers, params, body);
      raw = legacy.raw;
      status = legacy.status || 200;
      responseHeaders = legacy.headers || {};
      output = legacy.output;
    } else {
      const passInput = Boolean(step.passInputParams);
      const finalParams = passInput && method === "GET" ? { ...inputParams, ...params } : params;
      const finalBody = passInput && method !== "GET" ? { ...inputParams, ...body } : body;
      const response = await axios({
        method,
        url,
        params: finalParams,
        data: method === "GET" ? undefined : finalBody,
        headers,
        timeout: config.requestTimeoutMs || config.timeoutMs || config.timeout || 8000,
      });
      raw = response.data;
      status = response.status;
      responseHeaders = response.headers || {};
    }

    const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);
    const result = {
      name: step.name || `step_${index + 1}`,
      status,
      headers: responseHeaders,
      raw,
    };
    if (output !== undefined) result.output = output;
    results.push(result);

    const extracts = Array.isArray(step.extract) ? step.extract : [];
    extracts.forEach((item) => {
      const saveAs = String(item.saveAs || "").trim();
      if (!saveAs) return;
      const type = String(item.type || "regex").toLowerCase();
      if (type === "jsonpath") {
        const value = getByPath(raw, item.path || "");
        if (value !== undefined) vars[saveAs] = value;
        return;
      }
      if (type === "regex") {
        const source = item.source === "headers" ? JSON.stringify(responseHeaders || {}) : rawText;
        const pattern = item.pattern || item.regex || "";
        if (!pattern) return;
        const flags = item.flags || "";
        const reg = new RegExp(pattern, flags);
        const match = reg.exec(source);
        if (!match) return;
        const groupIndex = Number(item.group || 1);
        vars[saveAs] = match[groupIndex] || match[0];
      }
    });
  }

  const varMap = buildVarMap(device, tpl, inputParams, vars);
  let output = null;
  if (results.length) {
    const last = results[results.length - 1];
    output = last.output !== undefined ? last.output : last.raw;
  }
  if (config.output) {
    output = resolveTemplateString(String(config.output), varMap);
  }

  return {
    output,
    vars,
    steps: results,
  };
}
router.post(
  "/:slug",
  allowRoles("admin", "user", "device"),
  asyncHandler(async (req, res) => {
    const { slug } = req.params;
    const start = Date.now();
    const db = await readDB();
    const tpl = db.apiTemplates.find((item) => item.slug === slug && item.enabled);
    if (!tpl) throw new HttpError(404, "API模板不存在或未启用");

    const params = req.body?.params && typeof req.body.params === "object" ? req.body.params : {};
    const deviceId = req.auth.role === "device" ? req.auth.deviceId : req.body?.deviceId;
    if (!deviceId) throw new HttpError(400, "deviceId不能为空");

    const device = ensureDeviceAccess(db, req.auth, deviceId);
    if (device.status === "blocked") throw new HttpError(403, "设备已封禁");

    const deviceParams =
      device.thirdApiParams && typeof device.thirdApiParams === "object" && !Array.isArray(device.thirdApiParams)
        ? device.thirdApiParams[slug]
        : {};
    const safeDeviceParams =
      deviceParams && typeof deviceParams === "object" && !Array.isArray(deviceParams) ? deviceParams : {};
    const baseParams = {
      ...(tpl.defaultParams || {}),
      ...safeDeviceParams,
      ...params,
    };
    if (slug === "weather") {
      const cityId = String(baseParams.cityId || baseParams.cityID || baseParams.location || "").trim();
      if (cityId) {
        baseParams.location = cityId;
        baseParams.cityId = cityId;
      }
      if (baseParams.cityID !== undefined) {
        delete baseParams.cityID;
      }
    }
    if (slug === "addressparse" && !baseParams.address && req.body?.address) {
      baseParams.address = req.body.address;
    }

    try {
      const runtimeTpl = {
        ...tpl,
        advancedConfig: ensureAdvancedTemplateConfig(tpl),
      };
      const advancedResult = await runAdvancedTemplate(runtimeTpl, device, baseParams);
      const statusCode = Number(advancedResult.steps?.[advancedResult.steps.length - 1]?.status || 200);
      const latencyMs = Date.now() - start;

      await logApi({
        callerRole: req.auth.role,
        callerId: req.auth.userId || req.auth.deviceId || "",
        deviceId,
        templateSlug: slug,
        success: true,
        statusCode,
        latencyMs,
      });

      const cacheEntry = buildThirdCacheEntry(tpl, advancedResult);
      await updateDB((draft) => {
        draft.devices = Array.isArray(draft.devices) ? draft.devices : [];
        const target = draft.devices.find((item) => String(item.id || "") === String(deviceId || ""));
        if (!target) return;
        target.thirdApiCache =
          target.thirdApiCache && typeof target.thirdApiCache === "object" && !Array.isArray(target.thirdApiCache)
            ? target.thirdApiCache
            : {};
        target.thirdApiCache[slug] = cacheEntry;
        target.updatedAt = new Date().toISOString();
      });

      res.success(
        {
          template: {
            slug: tpl.slug,
            name: tpl.name,
          },
          deviceId,
          formatted: advancedResult.output,
          raw: advancedResult,
        },
        "调用成功"
      );
    } catch (error) {
      const latencyMs = Date.now() - start;
      const message = error.response?.data?.msg || error.message || "第三方调用失败";
      const statusCode = error.response?.status || 502;

      await logApi({
        callerRole: req.auth.role,
        callerId: req.auth.userId || req.auth.deviceId || "",
        deviceId,
        templateSlug: slug,
        success: false,
        statusCode,
        latencyMs,
        error: String(message),
      });

      throw new HttpError(502, `第三方API异常: ${message}`);
    }
  })
);

module.exports = router;


