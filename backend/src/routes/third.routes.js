const express = require("express");
const axios = require("axios");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess } = require("../utils/access");
const { logApi } = require("../utils/logging");
const config = require("../config");
const {
  saveXiqueSyncConfig,
  submitXiqueImport,
  getXiqueStatus,
} = require("../services/xique_sync.service");

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

function parsePeriodRangeFromSourceKey(raw = "", fallbackStart = 1) {
  const text = String(raw || "");
  const fullMatch = text.match(/:(\d{1,2}):(\d{1,2})-(\d{1,2})(?::|$)/);
  if (fullMatch) {
    const startPeriod = Math.max(1, Number(fullMatch[2] || fallbackStart || 1));
    const endPeriod = Math.max(startPeriod, Number(fullMatch[3] || startPeriod));
    return { startPeriod, endPeriod };
  }

  const simpleMatch = text.match(/(\d{1,2})-(\d{1,2})/);
  if (simpleMatch) {
    const startPeriod = Math.max(1, Number(simpleMatch[1] || fallbackStart || 1));
    const endPeriod = Math.max(startPeriod, Number(simpleMatch[2] || startPeriod));
    return { startPeriod, endPeriod };
  }

  const start = Math.max(1, Number(fallbackStart || 1));
  return { startPeriod: start, endPeriod: start };
}

function parseContentMeta(raw = "") {
  const out = {};
  String(raw || "")
    .split(";")
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .forEach((part) => {
      const idx = part.indexOf(":");
      if (idx <= 0) return;
      const key = String(part.slice(0, idx) || "").trim().toLowerCase();
      const value = String(part.slice(idx + 1) || "").trim();
      if (!value) return;
      out[key] = value;
    });
  return out;
}

function getWeekdayLabel(weekday) {
  const map = {
    1: "Monday",
    2: "Tuesday",
    3: "Wednesday",
    4: "Thursday",
    5: "Friday",
    6: "Saturday",
    7: "Sunday",
  };
  return map[Number(weekday) || 1] || "Monday";
}

function normalizeXiqueScheduleRow(row = {}) {
  const weekday = Math.max(1, Math.min(7, Number(row.weekday || 1)));
  const fallbackStart = Math.max(1, Number(row.orderIndex || 1));
  const fromSourceKey = parsePeriodRangeFromSourceKey(row.sourceKey, fallbackStart);
  const fromClassKey = parsePeriodRangeFromSourceKey(row.xiqueClassKey, fromSourceKey.startPeriod);
  const startPeriod = Math.max(1, Number(fromClassKey.startPeriod || fromSourceKey.startPeriod || fallbackStart));
  const endPeriod = Math.max(startPeriod, Number(fromClassKey.endPeriod || fromSourceKey.endPeriod || startPeriod));

  const sourceMeta =
    row.sourceMeta && typeof row.sourceMeta === "object" && !Array.isArray(row.sourceMeta) ? row.sourceMeta : {};
  const parsedContent = parseContentMeta(row.content || row.note || "");
  const teacherName = String(sourceMeta.teacherName || parsedContent.teacher || "").trim();
  const location = String(sourceMeta.location || parsedContent.location || "").trim();

  return {
    id: String(row.id || ""),
    deviceId: String(row.deviceId || ""),
    termKey: String(row.termKey || ""),
    source: String(row.source || ""),
    sourceKey: String(row.sourceKey || ""),
    xiqueCourseId: String(row.xiqueCourseId || ""),
    xiqueClassKey: String(row.xiqueClassKey || ""),
    courseName: String(row.courseName || row.title || "").trim(),
    title: String(row.title || row.courseName || "").trim(),
    content: String(row.content || row.note || "").trim(),
    teacherName,
    location,
    weekday,
    weekdayLabel: getWeekdayLabel(weekday),
    position: {
      startPeriod,
      endPeriod,
      slotKey: `${weekday}-${startPeriod}-${endPeriod}`,
    },
    timeRange: {
      startTime: String(row.startTime || "").trim(),
      endTime: String(row.endTime || "").trim(),
    },
    updatedAt: String(row.updatedAt || row.createdAt || ""),
  };
}

function buildXiqueScheduleDataset(db, { deviceId, termKey = "" } = {}) {
  const safeDb = db && typeof db === "object" ? db : {};
  const allRows = Array.isArray(safeDb.schedules) ? safeDb.schedules : [];
  const normalizedDeviceId = String(deviceId || "").trim();
  const normalizedTermKey = String(termKey || "").trim();

  let candidateRows = allRows.filter(
    (item) => String(item?.deviceId || "") === normalizedDeviceId && String(item?.source || "") === "xique"
  );

  if (normalizedTermKey) {
    candidateRows = candidateRows.filter((item) => String(item?.termKey || "") === normalizedTermKey);
  } else {
    const latestTerm = candidateRows
      .map((item) => String(item?.termKey || "").trim())
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a))[0];
    if (latestTerm) {
      candidateRows = candidateRows.filter((item) => String(item?.termKey || "") === latestTerm);
    }
  }

  const courses = candidateRows
    .map((item) => normalizeXiqueScheduleRow(item))
    .sort((a, b) => {
      if (a.weekday !== b.weekday) return a.weekday - b.weekday;
      if (a.position.startPeriod !== b.position.startPeriod) return a.position.startPeriod - b.position.startPeriod;
      if (a.position.endPeriod !== b.position.endPeriod) return a.position.endPeriod - b.position.endPeriod;
      return String(a.courseName || "").localeCompare(String(b.courseName || ""));
    });

  const byDay = [];
  for (let day = 1; day <= 7; day += 1) {
    const dayCourses = courses.filter((item) => item.weekday === day);
    byDay.push({
      weekday: day,
      weekdayLabel: getWeekdayLabel(day),
      count: dayCourses.length,
      courses: dayCourses,
    });
  }

  const slotMap = new Map();
  courses.forEach((item) => {
    const key = String(item?.position?.slotKey || "");
    if (!key) return;
    if (!slotMap.has(key)) {
      slotMap.set(key, {
        slotKey: key,
        weekday: Number(item.weekday || 1),
        weekdayLabel: getWeekdayLabel(item.weekday),
        startPeriod: Number(item.position.startPeriod || 1),
        endPeriod: Number(item.position.endPeriod || 1),
        courses: [],
      });
    }
    slotMap.get(key).courses.push(item);
  });

  const bySlot = Array.from(slotMap.values()).sort((a, b) => {
    if (a.weekday !== b.weekday) return a.weekday - b.weekday;
    if (a.startPeriod !== b.startPeriod) return a.startPeriod - b.startPeriod;
    if (a.endPeriod !== b.endPeriod) return a.endPeriod - b.endPeriod;
    return String(a.slotKey || "").localeCompare(String(b.slotKey || ""));
  });

  return {
    schema: "xique_schedule_v1",
    deviceId: normalizedDeviceId,
    termKey: normalizedTermKey || (courses[0] ? String(courses[0].termKey || "") : ""),
    totalCourses: courses.length,
    byDay,
    bySlot,
    courses,
    generatedAt: new Date().toISOString(),
  };
}

function getTodayWeekdayInfo() {
  const tz = String(config.timezone || "Asia/Shanghai");
  let weekdayLabel = "Monday";
  try {
    weekdayLabel = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date());
  } catch (_) {
    weekdayLabel = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date());
  }
  const map = {
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
    Sunday: 7,
  };
  const normalizedLabel = map[weekdayLabel] ? weekdayLabel : "Monday";
  return {
    todayWeekday: map[normalizedLabel] || 1,
    todayWeekdayLabel: normalizedLabel,
  };
}

function buildTimeText(startTime = "", endTime = "") {
  const start = String(startTime || "").trim();
  const end = String(endTime || "").trim();
  return `${start}-${end}`;
}

function sanitizeXiqueScheduleDataset(input = {}) {
  const safe = input && typeof input === "object" ? input : {};
  const schema = String(safe.schema || "xique_schedule_v1");
  const deviceId = String(safe.deviceId || "");
  const termKey = String(safe.termKey || "");
  const totalCourses = Number(safe.totalCourses || 0);
  const generatedAt = String(safe.generatedAt || new Date().toISOString());

  const normalizeCourse = (item = {}) => {
    const row = item && typeof item === "object" ? item : {};
    const positionRaw = row.position && typeof row.position === "object" ? row.position : {};
    const timeRaw = row.timeRange && typeof row.timeRange === "object" ? row.timeRange : {};
    const weekday = Math.max(1, Math.min(7, Number(row.weekday || 1)));
    const startPeriod = Math.max(1, Number(positionRaw.startPeriod || 1));
    const endPeriod = Math.max(startPeriod, Number(positionRaw.endPeriod || startPeriod));
    const startTime = String(timeRaw.startTime || "").trim();
    const endTime = String(timeRaw.endTime || "").trim();
    return {
      id: String(row.id || ""),
      deviceId: String(row.deviceId || ""),
      termKey: String(row.termKey || ""),
      source: String(row.source || "xique"),
      sourceKey: String(row.sourceKey || ""),
      xiqueCourseId: String(row.xiqueCourseId || ""),
      xiqueClassKey: String(row.xiqueClassKey || ""),
      courseName: String(row.courseName || row.title || ""),
      title: String(row.title || row.courseName || ""),
      content: String(row.content || ""),
      teacherName: String(row.teacherName || ""),
      location: String(row.location || ""),
      weekday,
      weekdayLabel: String(row.weekdayLabel || getWeekdayLabel(weekday)),
      position: {
        startPeriod,
        endPeriod,
        slotKey: String(positionRaw.slotKey || `${weekday}-${startPeriod}-${endPeriod}`),
      },
      timeRange: {
        startTime,
        endTime,
      },
      updatedAt: String(row.updatedAt || ""),
    };
  };

  const courses = Array.isArray(safe.courses) ? safe.courses.map((item) => normalizeCourse(item)) : [];
  const byDay = Array.isArray(safe.byDay)
    ? safe.byDay.map((item, idx) => {
        const row = item && typeof item === "object" ? item : {};
        const weekday = Math.max(1, Math.min(7, Number(row.weekday || idx + 1)));
        const dayCourses = Array.isArray(row.courses) ? row.courses.map((it) => normalizeCourse(it)) : [];
        return {
          weekday,
          weekdayLabel: String(row.weekdayLabel || getWeekdayLabel(weekday)),
          count: Number(row.count || dayCourses.length),
          courses: dayCourses,
        };
      })
    : [];

  const bySlot = Array.isArray(safe.bySlot)
    ? safe.bySlot.map((item) => {
        const row = item && typeof item === "object" ? item : {};
        const weekday = Math.max(1, Math.min(7, Number(row.weekday || 1)));
        const startPeriod = Math.max(1, Number(row.startPeriod || 1));
        const endPeriod = Math.max(startPeriod, Number(row.endPeriod || startPeriod));
        const slotCourses = Array.isArray(row.courses) ? row.courses.map((it) => normalizeCourse(it)) : [];
        return {
          slotKey: String(row.slotKey || `${weekday}-${startPeriod}-${endPeriod}`),
          weekday,
          weekdayLabel: String(row.weekdayLabel || getWeekdayLabel(weekday)),
          startPeriod,
          endPeriod,
          courses: slotCourses,
        };
      })
    : [];

  return {
    schema,
    deviceId,
    termKey,
    totalCourses: Number.isFinite(totalCourses) ? totalCourses : courses.length,
    byDay,
    bySlot,
    courses,
    generatedAt,
  };
}

function buildTodayViewFromSchedule(schedule = {}) {
  const safeSchedule = sanitizeXiqueScheduleDataset(schedule);
  const { todayWeekday, todayWeekdayLabel } = getTodayWeekdayInfo();
  const todayRow =
    safeSchedule.byDay.find((item) => Number(item.weekday || 0) === todayWeekday) || {
      weekday: todayWeekday,
      weekdayLabel: todayWeekdayLabel,
      count: 0,
      courses: [],
    };

  const todayCourses = (Array.isArray(todayRow.courses) ? todayRow.courses : []).map((item) => {
    const row = item && typeof item === "object" ? item : {};
    const title = String(row.title || row.courseName || "");
    const teacherName = String(row.teacherName || "");
    const location = String(row.location || "");
    const startTime = String(row.timeRange?.startTime || "");
    const endTime = String(row.timeRange?.endTime || "");
    return {
      title,
      teacherName,
      location,
      startTime,
      endTime,
      timeText: buildTimeText(startTime, endTime),
    };
  });

  const todayCourseCount = todayCourses.length;
  const hasCourseToday = todayCourseCount > 0;
  const todayCourseText = hasCourseToday
    ? todayCourses
        .map((item, idx) => {
          const timeText = String(item.timeText || "").trim() || "--";
          const title = String(item.title || "").trim() || "-";
          const teacherName = String(item.teacherName || "").trim() || "-";
          const location = String(item.location || "").trim() || "-";
          return `${idx + 1}. ${timeText}\n${title}｜${teacherName}｜${location}`;
        })
        .join("\n\n")
    : "今天没有课程";

  return {
    todayWeekday,
    todayWeekdayLabel,
    todayCourseCount,
    todayCourses,
    todayCourseText,
    hasCourseToday,
  };
}

function parseBooleanParam(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

function normalizeTodoTemplateItem(row = {}) {
  const priority =
    row.priority === null || row.priority === undefined || row.priority === ""
      ? null
      : Number.isFinite(Number(row.priority))
        ? Number(row.priority)
        : null;
  return {
    priority,
    todo: String(row.id || ""),
    done: Boolean(row.done),
    content: String(row.content || ""),
    createdAt: String(row.createdAt || ""),
    updatedAt: String(row.updatedAt || ""),
  };
}

function buildTodoTemplateDataset(db, { deviceId, doneFilter, limit } = {}) {
  const normalizedDeviceId = String(deviceId || "").trim();
  const allRows = Array.isArray(db?.todos)
    ? db.todos.filter((item) => String(item?.deviceId || "") === normalizedDeviceId)
    : [];

  let rows = [...allRows];
  if (typeof doneFilter === "boolean") {
    rows = rows.filter((item) => Boolean(item?.done) === doneFilter);
  }

  rows.sort((a, b) => {
    const pa = a?.priority === null || a?.priority === undefined || a?.priority === "" ? -Infinity : Number(a.priority);
    const pb = b?.priority === null || b?.priority === undefined || b?.priority === "" ? -Infinity : Number(b.priority);
    if (pa !== pb) return pb - pa;
    const aTime = String(a?.updatedAt || a?.createdAt || "");
    const bTime = String(b?.updatedAt || b?.createdAt || "");
    return bTime.localeCompare(aTime);
  });

  const safeLimitRaw = Number(limit || 0);
  if (Number.isFinite(safeLimitRaw) && safeLimitRaw > 0) {
    rows = rows.slice(0, Math.min(500, Math.floor(safeLimitRaw)));
  }

  const todos = rows.map((item) => normalizeTodoTemplateItem(item));
  const openCount = allRows.filter((item) => !Boolean(item?.done)).length;
  const doneCount = allRows.length - openCount;

  return {
    schema: "todo_template_v1",
    deviceId: normalizedDeviceId,
    total: allRows.length,
    openCount,
    doneCount,
    filteredCount: todos.length,
    todos,
    generatedAt: new Date().toISOString(),
  };
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

function resolveRequestUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `http:${url}`;
  if (url.startsWith("/")) return `http://127.0.0.1:${Number(config.port || 8890)}${url}`;
  if (/^[a-z0-9.-]+:\d+\//i.test(url) || /^[a-z0-9.-]+\//i.test(url)) {
    return `http://${url}`;
  }
  return url;
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
    const url = resolveRequestUrl(resolveTemplateString(step.url || "", varMap));
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
      if (slug === "todo") {
        const doneFilter = parseBooleanParam(baseParams.done);
        const todoDataset = buildTodoTemplateDataset(db, {
          deviceId,
          doneFilter,
          limit: baseParams.limit,
        });

        const formatted = {
          status: "ok",
          schema: todoDataset.schema,
          deviceId,
          total: Number(todoDataset.total || 0),
          openCount: Number(todoDataset.openCount || 0),
          doneCount: Number(todoDataset.doneCount || 0),
          filteredCount: Number(todoDataset.filteredCount || 0),
          todos: Array.isArray(todoDataset.todos) ? todoDataset.todos : [],
          generatedAt: String(todoDataset.generatedAt || new Date().toISOString()),
        };
        const advancedResult = {
          output: formatted,
          vars: {},
          steps: [
            {
              name: "todo_collect",
              status: 200,
              output: formatted,
              raw: todoDataset,
            },
          ],
        };
        const latencyMs = Date.now() - start;
        await logApi({
          callerRole: req.auth.role,
          callerId: req.auth.userId || req.auth.deviceId || "",
          deviceId,
          templateSlug: slug,
          success: true,
          statusCode: 200,
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

        return res.success(
          {
            template: { slug: tpl.slug, name: tpl.name },
            deviceId,
            formatted,
            raw: advancedResult,
          },
          "调用成功"
        );
      }

      if (slug === "xique_schedule") {
        await saveXiqueSyncConfig({
          auth: req.auth,
          deviceId,
          body: {
            deviceId,
            enabled: false,
            intervalMinutes: 60,
            loginUsername: String(baseParams.loginUsername || baseParams.username || "").trim(),
            currentTermKey: String(baseParams.currentTermKey || baseParams.termKey || "").trim(),
            adapterMode: String(baseParams.adapterMode || "remote").trim(),
            baseUrl: String(baseParams.baseUrl || "").trim(),
            requireCaptcha: false,
          },
        });

        const xiqueResult = await submitXiqueImport({
          auth: req.auth,
          deviceId,
          body: {
            loginUsername: String(baseParams.loginUsername || baseParams.username || "").trim(),
            username: String(baseParams.username || "").trim(),
            password: String(baseParams.password || "").trim(),
            captchaAnswer: String(baseParams.captchaAnswer || "").trim(),
            captchaSession: String(baseParams.captchaSession || "").trim(),
            currentTermKey: String(baseParams.currentTermKey || baseParams.termKey || "").trim(),
            termKey: String(baseParams.termKey || "").trim(),
            adapterMode: String(baseParams.adapterMode || "").trim(),
            baseUrl: String(baseParams.baseUrl || "").trim(),
            forceCaptcha: Boolean(baseParams.forceCaptcha),
          },
        });

        const xiqueStatus = await getXiqueStatus({ auth: req.auth, deviceId });
        const latestDb = await readDB();
        const rawSchedule = buildXiqueScheduleDataset(latestDb, {
          deviceId,
          termKey: String(xiqueResult?.termKey || xiqueResult?.result?.termKey || ""),
        });
        const schedule = sanitizeXiqueScheduleDataset(rawSchedule);
        const view = buildTodayViewFromSchedule(schedule);
        const formatted = {
          status: String(xiqueResult?.status || "unknown"),
          termKey: String(xiqueResult?.termKey || xiqueResult?.result?.termKey || ""),
          imported: Number(xiqueResult?.result?.imported || 0),
          added: Number(xiqueResult?.result?.added || 0),
          updated: Number(xiqueResult?.result?.updated || 0),
          skipped: Number(xiqueResult?.result?.skipped || 0),
          overwritten: Number(xiqueResult?.result?.overwritten || 0),
          reason: String(xiqueResult?.reason || ""),
          needRelogin: Boolean(xiqueResult?.needRelogin),
          needCaptchaReverify: Boolean(xiqueStatus?.config?.needCaptchaReverify),
          needManualCaptcha: Boolean(xiqueResult?.needManualCaptcha),
          taskId: String(xiqueResult?.taskId || xiqueResult?.configId || ""),
          captchaSession: String(xiqueResult?.captchaSession || ""),
          captchaImage: String(xiqueResult?.captchaImage || ""),
          captchaExpiresAt: String(xiqueResult?.captchaExpiresAt || ""),
          loginUsername: String(xiqueStatus?.config?.loginUsername || ""),
          schedule,
          view,
        };
        const advancedResult = {
          output: formatted,
          vars: {},
          steps: [
            {
              name: "xique_import",
              status: 200,
              output: formatted,
              raw: xiqueResult,
            },
          ],
        };
        const latencyMs = Date.now() - start;
        await logApi({
          callerRole: req.auth.role,
          callerId: req.auth.userId || req.auth.deviceId || "",
          deviceId,
          templateSlug: slug,
          success: true,
          statusCode: 200,
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

        return res.success(
          {
            template: { slug: tpl.slug, name: tpl.name },
            deviceId,
            formatted,
            raw: advancedResult,
          },
          formatted.status === "imported" ? "调用成功" : "调用成功（需要验证码或重验证）"
        );
      }

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


