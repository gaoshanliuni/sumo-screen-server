const crypto = require("crypto");
const vm = require("vm");
const { createCanvas } = require("@napi-rs/canvas");
const axios = require("axios");
const iconv = require("iconv-lite");
const config = require("../config");
const createId = require("../utils/id");
const HttpError = require("../utils/httpError");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess } = require("../utils/access");
const { logOperation } = require("../utils/logging");
const { recognizeCaptchaFromDataUrl } = require("./captcha_ocr.service");

const ALLOWED_INTERVALS = new Set([10, 30, 60]);
const ACTIVE_START_HOUR = 6;
const ACTIVE_END_HOUR = 24;
const MAX_BACKOFF_MINUTES = Number(config.xiqueMaxBackoffMinutes || 120);
const FAILURE_BACKOFF_THRESHOLD = Number(config.xiqueFailureBackoffThreshold || 3);
const FAILURE_PAUSE_THRESHOLD = Number(config.xiqueFailurePauseThreshold || 5);
const SYNC_LOG_LIMIT = 2000;
const running = new Set();
const LOCKS = new Map();
const REMOTE_CAPTCHA_CONTEXT = new Map();
let REMOTE_DES_ENCRYPTOR = null;

const XIQUE_ERROR = Object.freeze({
  NETWORK_TIMEOUT: "NETWORK_TIMEOUT",
  LOGIN_FAILED: "LOGIN_FAILED",
  CREDENTIAL_INVALID: "CREDENTIAL_INVALID",
  CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  CAPTCHA_INVALID: "CAPTCHA_INVALID",
  STRUCTURE_CHANGED: "STRUCTURE_CHANGED",
  PARSE_FAILED: "PARSE_FAILED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  AUTO_SYNC_PAUSED: "AUTO_SYNC_PAUSED",
  CONFIG_NOT_FOUND: "CONFIG_NOT_FOUND",
});

const XIQUE_LOGIN_STATUS = Object.freeze({
  SUCCESS: "SUCCESS",
  OCR_RETRYING: "OCR_RETRYING",
  NEED_MANUAL_CAPTCHA: "NEED_MANUAL_CAPTCHA",
  LOGIN_FAILED: "LOGIN_FAILED",
  SCHEDULE_FETCH_FAILED: "SCHEDULE_FETCH_FAILED",
});
const XIQUE_DEFAULT_TERM_WEEKS = Math.max(12, Number(config.xiqueDefaultTermWeeks || 30));
const WEEKDAY_MAP = Object.freeze({
  "\u4e00": 1,
  "\u4e8c": 2,
  "\u4e09": 3,
  "\u56db": 4,
  "\u4e94": 5,
  "\u516d": 6,
  "\u65e5": 7,
  "\u5929": 7,
});
const WEEKDAY_LABEL_MAP = Object.freeze({
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
});

const AUTH_ERROR_CODES = new Set([
  XIQUE_ERROR.LOGIN_FAILED,
  XIQUE_ERROR.CREDENTIAL_INVALID,
  XIQUE_ERROR.CAPTCHA_REQUIRED,
  XIQUE_ERROR.CAPTCHA_INVALID,
  XIQUE_ERROR.SESSION_EXPIRED,
]);

function nowIso() { return new Date().toISOString(); }
function trimString(v) { return String(v ?? "").trim(); }
function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return Boolean(fallback);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const raw = trimString(value).toLowerCase();
  if (!raw) return Boolean(fallback);
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return Boolean(fallback);
}
function normalizeIntervalMinutes(v) { const n = Math.floor(Number(v || 60)); return ALLOWED_INTERVALS.has(n) ? n : 60; }
function sha(text) { return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex"); }
function key() { return crypto.createHash("sha256").update(String(config.xiqueVaultSecret || config.jwtSecret || "xique-vault")).digest(); }
function encryptSecret(text) {
  const raw = trimString(text);
  if (!raw) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}
function decryptSecret(payload) {
  const raw = trimString(payload);
  if (!raw) return "";
  const [ver, ivB64, tagB64, bodyB64] = raw.split(":");
  if (ver !== "v1") return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(bodyB64, "base64")), decipher.final()]).toString("utf8");
}
function mask(v, keep = 4) { const raw = trimString(v); if (!raw) return ""; return raw.length <= keep ? "*".repeat(raw.length) : `${raw.slice(0, keep)}***`; }
function sanitizeDetail(input) {
  const secretKeys = new Set(["password", "token", "cookie", "captchaAnswer", "captchaImage", "credentialCipher", "authToken", "authCookie"]);
  if (Array.isArray(input)) return input.map(sanitizeDetail);
  if (!input || typeof input !== "object") return typeof input === "string" && input.length > 200 ? `${input.slice(0, 200)}...` : input;
  const out = {};
  Object.entries(input).forEach(([k, v]) => {
    if (secretKeys.has(k)) out[k] = "[redacted]";
    else if (k === "captchaSession" || k === "sessionId") out[k] = mask(v);
    else out[k] = sanitizeDetail(v);
  });
  return out;
}
function makeXiqueError(code, message, status = 400, detail = {}) {
  const error = new HttpError(status, message, { code, ...detail });
  error.code = code;
  return error;
}
function classifyError(error) {
  const message = String(error?.message || "");
  const code = error?.code || error?.data?.code || "";
  if (code) return code;
  if (/captcha/i.test(message)) return XIQUE_ERROR.CAPTCHA_REQUIRED;
  if (/token|session|cookie/i.test(message)) return XIQUE_ERROR.SESSION_EXPIRED;
  if (/timeout/i.test(message)) return XIQUE_ERROR.NETWORK_TIMEOUT;
  if (/credential|password|account|账号|密码|凭证/i.test(message)) return XIQUE_ERROR.CREDENTIAL_INVALID;
  if (/parse|structure|html|json/i.test(message)) return XIQUE_ERROR.STRUCTURE_CHANGED;
  if (/login/i.test(message)) return XIQUE_ERROR.LOGIN_FAILED;
  return "SYNC_FAILED";
}
function withConfigLock(lockKey, task) {
  const previous = LOCKS.get(lockKey) || Promise.resolve();
  let release;
  const current = previous.then(() => new Promise((resolve) => {
    release = resolve;
  }));
  LOCKS.set(lockKey, current);
  return previous.then(task).finally(() => {
    if (release) release();
    if (LOCKS.get(lockKey) === current) LOCKS.delete(lockKey);
  });
}
function computeNextRunAt(configRow, now = Date.now()) {
  const base = normalizeIntervalMinutes(configRow.intervalMinutes);
  const failures = Number(configRow.failureCount || 0);
  if (failures >= FAILURE_PAUSE_THRESHOLD) return "";
  if (failures >= FAILURE_BACKOFF_THRESHOLD) {
    const multiplier = Math.min(8, 2 ** Math.max(1, failures - FAILURE_BACKOFF_THRESHOLD + 1));
    const backoffMinutes = Math.min(MAX_BACKOFF_MINUTES, base * multiplier);
    return new Date(now + backoffMinutes * 60000).toISOString();
  }
  return new Date(now + base * 60000).toISOString();
}
function getHour(date = new Date()) {
  const tz = config.timezone || "Asia/Shanghai";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit" }).formatToParts(date);
  return Number(parts.find((p) => p.type === "hour")?.value || 0);
}
function isWithinActiveWindow(date = new Date()) { const hour = getHour(date); return hour >= ACTIVE_START_HOUR && hour < ACTIVE_END_HOUR; }
function getCurrentSemesterKey(date = new Date()) {
  const tz = config.timezone || "Asia/Shanghai";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === "year")?.value || date.getFullYear());
  const month = Number(parts.find((p) => p.type === "month")?.value || date.getMonth() + 1);
  return `${year}-${month <= 6 ? "S1" : "S2"}`;
}
function renderCaptchaImage(code) {
  const canvas = createCanvas(180, 64);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#F7F8FC";
  ctx.fillRect(0, 0, 180, 64);
  ctx.fillStyle = "#21304A";
  ctx.font = "bold 34px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(code, 90, 32);
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

function parseJsonLike(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch (_) {
    return null;
  }
}

async function loadSamplePayload(cfg = {}) {
  const fallbackTermKey = trimString(cfg.currentTermKey || cfg.termKey || getCurrentSemesterKey());
  const json = parseJsonLike(cfg.sampleJson);
  if (json) {
    const weekContext = resolveTeachingWeekContext({
      currentWeekCandidates: [json.currentWeek, json.weekIndex, json.teachingWeek, json.academicWeek, json.schoolWeek],
      termStartDateCandidates: [json.termStartDate, json.semesterStart, json.startDate, cfg.termStartDate],
      fallbackTermStartDate: normalizeTermStartDate(config.xiqueDefaultTermStartDate || ""),
    });
    if (Array.isArray(json)) return {
      termKey: fallbackTermKey,
      courses: json,
      currentWeek: weekContext.currentWeek,
      termStartDate: weekContext.termStartDate,
    };
    if (Array.isArray(json.courses)) return {
      termKey: trimString(json.termKey || fallbackTermKey),
      courses: json.courses,
      currentWeek: weekContext.currentWeek,
      termStartDate: weekContext.termStartDate,
    };
    if (Array.isArray(json.data)) return {
      termKey: trimString(json.termKey || fallbackTermKey),
      courses: json.data,
      currentWeek: weekContext.currentWeek,
      termStartDate: weekContext.termStartDate,
    };
  }
  if (cfg.sampleHtml) {
    const match = String(cfg.sampleHtml).match(/<script[^>]*id=["']xique-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (match) return loadSamplePayload({ sampleJson: match[1], currentTermKey: fallbackTermKey });
  }
  if (cfg.sampleUrl) {
    try {
      const resp = await axios.get(cfg.sampleUrl, { timeout: 8000, responseType: "text" });
      return loadSamplePayload({ sampleJson: resp.data, currentTermKey: fallbackTermKey });
    } catch (_) {
      // fallback below
    }
  }
  const weekday = Math.max(1, Math.min(7, new Date().getDay() || 7));
  return {
    termKey: fallbackTermKey,
    currentWeek: null,
    termStartDate: normalizeTermStartDate(cfg.termStartDate || config.xiqueDefaultTermStartDate || ""),
    courses: [
      { courseId: "sample-1", courseName: "数学", teacherName: "示例老师", location: "A101", weekday, startPeriod: 1, endPeriod: 2, weeks: [1, 2, 3, 4, 5] },
      { courseId: "sample-2", courseName: "英语", teacherName: "示例老师", location: "B201", weekday: weekday === 7 ? 1 : weekday + 1, startPeriod: 3, endPeriod: 4, weeks: [1, 2, 3, 4, 5] },
    ],
  };
}

function buildSchoolBaseUrl(raw = "") {
  const base = trimString(raw) || "http://jw.sdivc.edu.cn";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function md5Hex(text) {
  return crypto.createHash("md5").update(String(text || ""), "utf8").digest("hex");
}

function decodeRemoteBody(buffer, charset = "") {
  const ct = String(charset || "").toLowerCase();
  if (ct.includes("gbk") || ct.includes("gb2312") || ct.includes("gb18030")) return iconv.decode(buffer, "gb18030");
  if (ct.includes("utf-8") || ct.includes("utf8")) return buffer.toString("utf8");
  try {
    return iconv.decode(buffer, "gb18030");
  } catch (_) {
    return buffer.toString("utf8");
  }
}

function parseCookieHeader(cookieHeader = "") {
  const out = new Map();
  String(cookieHeader || "").split(";").forEach((item) => {
    const pair = trimString(item);
    if (!pair || !pair.includes("=")) return;
    const idx = pair.indexOf("=");
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) return;
    out.set(name, value);
  });
  return out;
}

function mergeCookieHeader(cookieHeader = "", setCookie = []) {
  const map = parseCookieHeader(cookieHeader);
  (Array.isArray(setCookie) ? setCookie : [setCookie]).forEach((item) => {
    const line = trimString(item);
    if (!line) return;
    const pair = line.split(";")[0];
    const idx = pair.indexOf("=");
    if (idx <= 0) return;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) return;
    map.set(name, value);
  });
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function decodeHtmlCell(raw = "") {
  return String(raw || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&ensp;/gi, " ")
    .replace(/&emsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num || 0)))
    .replace(/\s+/g, " ")
    .trim();
}

function schoolTermToInternal(termCode = "") {
  const raw = trimString(termCode);
  const match = raw.match(/^(\d{4})-([01])$/);
  if (!match) return raw;
  const year = Number(match[1]);
  return match[2] === "0" ? `${year}-S2` : `${year + 1}-S1`;
}

function internalTermToSchool(termKey = "") {
  const raw = trimString(termKey);
  if (/^\d{4}-[01]$/.test(raw)) return raw;
  const match = raw.match(/^(\d{4})-S([12])$/i);
  if (!match) return "";
  const year = Number(match[1]);
  return match[2] === "1" ? `${year - 1}-1` : `${year}-0`;
}

function parseHiddenInput(html = "", id = "") {
  if (!id) return "";
  const re = new RegExp(`id=["']${id}["'][^>]*value=["']([^"']*)["']`, "i");
  const byName = new RegExp(`name=["']${id}["'][^>]*value=["']([^"']*)["']`, "i");
  return trimString((html.match(re) || html.match(byName) || [])[1] || "");
}

function parseRemoteLoginContext(html = "") {
  const sessionMatch = html.match(/var\s+_sessionid\s*=\s*"([A-Fa-f0-9]+)"/)
    || html.match(/var\s+_ssessionid\s*=\s*"([A-Fa-f0-9]+)"/);
  if (!sessionMatch) throw makeXiqueError(XIQUE_ERROR.STRUCTURE_CHANGED, "xique login page changed: missing session id", 502);
  return {
    sessionId: trimString(sessionMatch[1]),
    txt_mm_expression: parseHiddenInput(html, "txt_mm_expression"),
    txt_mm_length: parseHiddenInput(html, "txt_mm_length"),
    txt_mm_userzh: parseHiddenInput(html, "txt_mm_userzh"),
    hid_flag: parseHiddenInput(html, "hid_flag") || "1",
    hid_dxyzm: parseHiddenInput(html, "hid_dxyzm"),
  };
}

function normalizeWeeksArray(input, maxWeek = XIQUE_DEFAULT_TERM_WEEKS) {
  if (!Array.isArray(input)) return [];
  const safeMax = Math.max(4, Number(maxWeek || XIQUE_DEFAULT_TERM_WEEKS));
  const set = new Set();
  input.forEach((item) => {
    const week = Math.floor(Number(item || 0));
    if (Number.isFinite(week) && week >= 1 && week <= safeMax) {
      set.add(week);
    }
  });
  return Array.from(set.values()).sort((a, b) => a - b);
}

function expandWeekRange(startRaw, endRaw, maxWeek = XIQUE_DEFAULT_TERM_WEEKS) {
  const safeMax = Math.max(4, Number(maxWeek || XIQUE_DEFAULT_TERM_WEEKS));
  const start = Math.max(1, Math.floor(Number(startRaw || 0)));
  const end = Math.max(start, Math.floor(Number(endRaw || start)));
  const out = [];
  for (let week = start; week <= Math.min(end, safeMax); week += 1) {
    out.push(week);
  }
  return out;
}

function parseWeeksExpression(rawExpr = "", maxWeek = XIQUE_DEFAULT_TERM_WEEKS) {
  const safeMax = Math.max(4, Number(maxWeek || XIQUE_DEFAULT_TERM_WEEKS));
  const expr = trimString(rawExpr)
    .replace(/\s+/g, "")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")");
  if (!expr) return { weeks: [], weekRule: "all", weekExpr: "" };

  if (expr.includes("单周")) {
    const weeks = [];
    for (let week = 1; week <= safeMax; week += 1) {
      if (week % 2 === 1) weeks.push(week);
    }
    return { weeks, weekRule: "odd", weekExpr: expr };
  }
  if (expr.includes("双周")) {
    const weeks = [];
    for (let week = 1; week <= safeMax; week += 1) {
      if (week % 2 === 0) weeks.push(week);
    }
    return { weeks, weekRule: "even", weekExpr: expr };
  }

  const normalizedExpr = expr.replace(/周/g, "");
  const segments = normalizedExpr.split(/[,\uFF0C\u3001]/).map((item) => trimString(item)).filter(Boolean);
  const weeks = [];
  segments.forEach((segment) => {
    const rangeMatch = segment.match(/^(\d{1,2})\s*[-~～至]\s*(\d{1,2})$/);
    if (rangeMatch) {
      weeks.push(...expandWeekRange(rangeMatch[1], rangeMatch[2], safeMax));
      return;
    }
    const single = Math.floor(Number(segment || 0));
    if (Number.isFinite(single) && single >= 1 && single <= safeMax) {
      weeks.push(single);
    }
  });
  return {
    weeks: normalizeWeeksArray(weeks, safeMax),
    weekRule: weeks.length ? "custom" : "all",
    weekExpr: expr,
  };
}

function normalizeTermStartDate(raw = "") {
  const value = trimString(raw);
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const slashDate = value.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashDate) return `${slashDate[1]}-${slashDate[2]}-${slashDate[3]}`;
  const full = value.match(/^(\d{4})-(\d{2})-(\d{2})[T\s].*$/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;
  const slashFull = value.match(/^(\d{4})\/(\d{2})\/(\d{2})[T\s].*$/);
  if (slashFull) return `${slashFull[1]}-${slashFull[2]}-${slashFull[3]}`;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return "";
}

function normalizeWeekNumber(value) {
  const num = Math.floor(Number(value || 0));
  if (!Number.isFinite(num)) return null;
  if (num < 1 || num > Math.max(30, XIQUE_DEFAULT_TERM_WEEKS + 10)) return null;
  return num;
}

function extractCurrentWeekFromText(text = "") {
  const raw = String(text || "");
  if (!raw) return null;
  const patterns = [
    /(?:currentWeek|weekIndex|teachingWeek|academicWeek|schoolWeek)\s*[:=]\s*["']?(\d{1,2})["']?/i,
    /(?:当前周|本周|当前教学周|教学周|学周|周次|academicWeek|schoolWeek)\s*[:：=]?\s*第?\s*(\d{1,2})\s*周?/i,
    /第\s*(\d{1,2})\s*教学周/i,
    /本周\s*第?\s*(\d{1,2})\s*周?/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const normalized = normalizeWeekNumber(match[1]);
    if (normalized) return normalized;
  }
  return null;
}

function collectCurrentWeekCandidatesFromObject(input, out = [], depth = 0) {
  if (!input || depth > 5) return out;
  if (Array.isArray(input)) {
    input.forEach((item) => collectCurrentWeekCandidatesFromObject(item, out, depth + 1));
    return out;
  }
  if (typeof input !== "object") return out;
  const directKeys = ["currentWeek", "weekIndex", "teachingWeek", "academicWeek", "schoolWeek"];
  directKeys.forEach((keyName) => {
    if (input[keyName] === undefined || input[keyName] === null || input[keyName] === "") return;
    out.push(input[keyName]);
  });
  Object.entries(input).forEach(([keyName, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string") {
      if (/(week|周|teaching|academic|school)/i.test(keyName) || /(?:currentWeek|weekIndex|teachingWeek|academicWeek|schoolWeek)/i.test(value)) {
        out.push(value);
      }
      const fromText = extractCurrentWeekFromText(value);
      if (fromText) out.push(fromText);
      return;
    }
    if (typeof value === "number") {
      if (/(week|周|teaching|academic|school)/i.test(keyName)) out.push(value);
      return;
    }
    if (typeof value === "object") {
      collectCurrentWeekCandidatesFromObject(value, out, depth + 1);
    }
  });
  return out;
}

function collectTermStartDateCandidatesFromObject(input, out = [], depth = 0) {
  if (!input || depth > 5) return out;
  if (Array.isArray(input)) {
    input.forEach((item) => collectTermStartDateCandidatesFromObject(item, out, depth + 1));
    return out;
  }
  if (typeof input !== "object") return out;
  const directKeys = [
    "termStartDate",
    "semesterStart",
    "startDate",
    "term_start_date",
    "semester_start",
    "xqkssj",
    "kssj",
  ];
  directKeys.forEach((keyName) => {
    const value = input[keyName];
    if (value === undefined || value === null || value === "") return;
    out.push(value);
  });
  Object.entries(input).forEach(([keyName, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string") {
      if (/(start|开始|起始|term|semester|xqkssj|kssj)/i.test(keyName)) {
        out.push(value);
      }
      const fromText = normalizeTermStartDate(value);
      if (fromText) out.push(fromText);
      return;
    }
    if (typeof value === "object") {
      collectTermStartDateCandidatesFromObject(value, out, depth + 1);
    }
  });
  return out;
}

function resolveTeachingWeekContext({
  now = new Date(),
  timezone = config.timezone || "Asia/Shanghai",
  currentWeekCandidates = [],
  termStartDateCandidates = [],
  fallbackTermStartDate = "",
} = {}) {
  let currentWeek = null;
  let currentWeekSource = "";
  const weekCandidates = Array.isArray(currentWeekCandidates) ? currentWeekCandidates : [];
  for (const candidate of weekCandidates) {
    const direct = normalizeWeekNumber(candidate);
    if (direct) {
      currentWeek = direct;
      currentWeekSource = "candidate_numeric";
      break;
    }
    const fromText = extractCurrentWeekFromText(candidate);
    if (fromText) {
      currentWeek = fromText;
      currentWeekSource = "candidate_text";
      break;
    }
  }

  let termStartDate = "";
  let termStartDateSource = "";
  const termCandidates = [...(Array.isArray(termStartDateCandidates) ? termStartDateCandidates : [])];
  if (fallbackTermStartDate) termCandidates.push(fallbackTermStartDate);
  for (const candidate of termCandidates) {
    const normalized = normalizeTermStartDate(candidate);
    if (!normalized) continue;
    termStartDate = normalized;
    termStartDateSource = String(candidate) === String(fallbackTermStartDate) ? "fallback" : "candidate";
    break;
  }

  if (!currentWeek && termStartDate) {
    const computed = computeCurrentWeek(termStartDate, now, timezone);
    if (computed && Number.isFinite(Number(computed))) {
      currentWeek = Math.floor(Number(computed));
      currentWeekSource = "computed_from_term_start";
    }
  }

  const weekFilteringApplied = Boolean(currentWeek && Number.isFinite(Number(currentWeek)) && Number(currentWeek) > 0);
  return {
    currentWeek: weekFilteringApplied ? Number(currentWeek) : null,
    currentWeekSource: weekFilteringApplied ? currentWeekSource || "computed" : "",
    termStartDate: termStartDate || "",
    termStartDateSource: termStartDate ? termStartDateSource || "candidate" : "",
    weekFilteringApplied,
  };
}

function detectRemoteTeachingWeekContext({
  configRow = {},
  termList = [],
  wdkbHtml = "",
  scheduleHtml = "",
  calendarInfo = {},
} = {}) {
  const weekCandidates = [];
  const termStartDateCandidates = [];

  collectCurrentWeekCandidatesFromObject(termList, weekCandidates);
  collectTermStartDateCandidatesFromObject(termList, termStartDateCandidates);

  const htmlSources = [String(wdkbHtml || ""), String(scheduleHtml || "")];
  htmlSources.forEach((html) => {
    if (!html) return;
    const fromText = extractCurrentWeekFromText(html);
    if (fromText) weekCandidates.push(fromText);
    collectCurrentWeekCandidatesFromObject(parseJsonLike(html) || {}, weekCandidates);
    const dateRegex = /(\d{4}[/-]\d{2}[/-]\d{2})/g;
    let dateMatch;
    while ((dateMatch = dateRegex.exec(html)) !== null) {
      termStartDateCandidates.push(dateMatch[1]);
    }
  });

  weekCandidates.push(
    configRow.currentWeek,
    configRow.weekIndex,
    configRow.teachingWeek,
    configRow.academicWeek,
    configRow.schoolWeek
  );
  termStartDateCandidates.push(
    calendarInfo.termStartDate,
    configRow.termStartDate,
    configRow.semesterStart,
    configRow.startDate,
    configRow.currentTermStartDate
  );
  if (calendarInfo.currentWeek !== undefined && calendarInfo.currentWeek !== null && calendarInfo.currentWeek !== "") {
    weekCandidates.push(calendarInfo.currentWeek);
  }

  return resolveTeachingWeekContext({
    currentWeekCandidates: weekCandidates.filter((item) => item !== undefined && item !== null && item !== ""),
    termStartDateCandidates: termStartDateCandidates.filter((item) => item !== undefined && item !== null && item !== ""),
    fallbackTermStartDate: "",
    now: new Date(),
    timezone: config.timezone || "Asia/Shanghai",
  });
}

function computeCurrentWeek(termStartDate = "", now = new Date(), timezone = config.timezone || "Asia/Shanghai") {
  const normalized = normalizeTermStartDate(termStartDate);
  if (!normalized) return null;
  const startBase = timezone === "Asia/Shanghai"
    ? new Date(`${normalized}T00:00:00+08:00`)
    : new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(startBase.getTime())) return null;
  const diffDays = Math.floor((now.getTime() - startBase.getTime()) / 86400000);
  return Math.max(1, Math.floor(diffDays / 7) + 1);
}

function isCourseActiveInWeek(weeks = [], currentWeek = null) {
  const normalized = normalizeWeeksArray(weeks);
  if (!normalized.length) return true;
  if (!Number.isFinite(Number(currentWeek || 0)) || Number(currentWeek || 0) <= 0) return true;
  return normalized.includes(Math.floor(Number(currentWeek)));
}

function parseScheduleSlots(text = "") {
  const normalized = String(text || "")
    .replace(/[，、；]/g, ",")
    .replace(/[【]/g, "[")
    .replace(/[】]/g, "]")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return [];

  const slotPattern = /(?:(单周|双周|[\d,\-~～至]+周)\s*)?(?:周)?([一二三四五六日天])\s*(?:\[\s*(\d{1,2})(?:\s*[-~～至]\s*(\d{1,2}))?\s*\]|第?\s*(\d{1,2})(?:\s*[-~～至]\s*(\d{1,2}))?\s*节)/g;
  const matches = [];
  let match;
  while ((match = slotPattern.exec(normalized)) !== null) {
    const startPeriod = Math.max(1, Number(match[3] || match[5] || 1));
    const endPeriod = Math.max(startPeriod, Number(match[4] || match[6] || startPeriod));
    const weekday = WEEKDAY_MAP[String(match[2] || "")] || 1;
    const weekMeta = parseWeeksExpression(match[1] || "", XIQUE_DEFAULT_TERM_WEEKS);
    matches.push({
      index: match.index,
      end: slotPattern.lastIndex,
      weekday,
      startPeriod,
      endPeriod,
      weekExpr: weekMeta.weekExpr,
      weekRule: weekMeta.weekRule,
      weeks: weekMeta.weeks,
    });
  }

  if (!matches.length) return [];

  slotPattern.lastIndex = 0;
  const locationFallback = trimString(
    normalized
      .replace(slotPattern, " ")
      .replace(/[,\s;，、；]+/g, " ")
      .trim()
  );
  const slots = [];
  const dedup = new Set();

  matches.forEach((seg, idx) => {
    const nextStart = matches[idx + 1] ? matches[idx + 1].index : normalized.length;
    let localTail = trimString(normalized.slice(seg.end, nextStart).replace(/^[,\s;，、；]+/, ""));
    if (/^(?:(?:单周|双周|[\d,\-~～至]+周)\s*)?(?:周)?[一二三四五六日天]/.test(localTail)) {
      localTail = "";
    }
    const location = trimString(localTail || locationFallback || "");
    const weekKey = seg.weeks.length ? seg.weeks.join(".") : seg.weekRule;
    const dedupKey = `${seg.weekday}:${seg.startPeriod}-${seg.endPeriod}:${weekKey}:${location}`;
    if (dedup.has(dedupKey)) return;
    dedup.add(dedupKey);
    slots.push({
      weekday: seg.weekday,
      startPeriod: seg.startPeriod,
      endPeriod: seg.endPeriod,
      location,
      weeks: seg.weeks,
      weekRule: seg.weekRule,
      weekExpr: seg.weekExpr,
    });
  });

  return slots;
}

function normalizeHHmm(value = "") {
  const match = trimString(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  const hour = Math.max(0, Math.min(23, Number(match[1] || 0)));
  const minute = Math.max(0, Math.min(59, Number(match[2] || 0)));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parsePeriodTimeMapFromSchoolTimetable(html = "") {
  const periodMap = {};
  const trBlocks = String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];
  trBlocks.forEach((trBlock) => {
    const tds = Array.from(trBlock.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi))
      .map((m) => trimString(decodeHtmlCell(m[1])));
    if (tds.length < 3) return;
    for (let i = 0; i <= tds.length - 3; i += 1) {
      const periodText = trimString(tds[i]);
      const startTime = normalizeHHmm(tds[i + 1]);
      const endTime = normalizeHHmm(tds[i + 2]);
      if (!/^\d{1,2}$/.test(periodText) || !startTime || !endTime) continue;
      const period = Number(periodText);
      if (!Number.isFinite(period) || period <= 0) continue;
      periodMap[period] = { startTime, endTime };
      break;
    }
  });
  return periodMap;
}

function normalizeFlexibleDate(value = "") {
  const raw = trimString(value);
  if (!raw) return "";
  const byDash = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (byDash) {
    const y = byDash[1];
    const m = String(Math.max(1, Math.min(12, Number(byDash[2] || 1)))).padStart(2, "0");
    const d = String(Math.max(1, Math.min(31, Number(byDash[3] || 1)))).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const byCn = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (byCn) {
    const y = byCn[1];
    const m = String(Math.max(1, Math.min(12, Number(byCn[2] || 1)))).padStart(2, "0");
    const d = String(Math.max(1, Math.min(31, Number(byCn[3] || 1)))).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return normalizeTermStartDate(raw);
}

function schoolTermCodeToKeywords(termCode = "") {
  const raw = trimString(termCode);
  const match = raw.match(/^(\d{4})-([01])$/);
  if (!match) return [raw].filter(Boolean);
  const baseYear = Number(match[1]);
  const phase = match[2];
  const endYear = baseYear + 1;
  const semesterCn = phase === "0" ? "第一学期" : "第二学期";
  return [
    `${baseYear}-${phase}`,
    `${baseYear}-${endYear}学年${semesterCn}`,
    `${baseYear}-${endYear} 学年 ${semesterCn}`,
    `${baseYear}学年${semesterCn}`,
    `${baseYear}-${endYear}`,
  ].filter(Boolean);
}

function parseCalendarTermStartDateFromHtml(html = "", termCode = "") {
  const raw = String(html || "");
  if (!raw.trim()) {
    return { termStartDate: "", currentWeek: null, matchedRow: "", method: "empty_html" };
  }

  const explicitStartMatch = raw.match(
    /(?:学期开始日期|学期开始日|开学日期|开学日|xqkssj|kssj|¿ªÊ¼ÈÕÆÚ)\D{0,20}(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)/i
  );
  const explicitStartDate = normalizeFlexibleDate((explicitStartMatch || [])[1] || "");

  const directDateCandidates = [];
  const semKeyRegex = /(?:termStartDate|semesterStart|startDate|xqkssj|kssj)\s*[:=]\s*["']?([0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2})["']?/gi;
  let semMatch;
  while ((semMatch = semKeyRegex.exec(raw)) !== null) {
    directDateCandidates.push(semMatch[1]);
  }

  const rowCandidates = [];
  const rows = raw.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const termKeywords = schoolTermCodeToKeywords(termCode);
  rows.forEach((rowHtml) => {
    const text = decodeHtmlCell(rowHtml).replace(/\s+/g, " ").trim();
    if (!text) return;
    const hitKeyword = termKeywords.some((kw) => kw && text.includes(kw));
    const dateMatches = [
      ...text.matchAll(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/g),
      ...text.matchAll(/(\d{4}年\d{1,2}月\d{1,2}日)/g),
    ].map((m) => normalizeFlexibleDate(m[1]));
    if (!dateMatches.length) return;
    rowCandidates.push({
      text,
      dateMatches: dateMatches.filter(Boolean),
      score: hitKeyword ? 10 : 0,
    });
  });

  const textBlockCandidates = [];
  const blocks = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .split(/[\r\n]+/)
    .map((line) => decodeHtmlCell(line).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  blocks.forEach((text) => {
    const hitKeyword = termKeywords.some((kw) => kw && text.includes(kw));
    const dateMatches = [
      ...text.matchAll(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/g),
      ...text.matchAll(/(\d{4}年\d{1,2}月\d{1,2}日)/g),
    ].map((m) => normalizeFlexibleDate(m[1]));
    if (!dateMatches.length) return;
    textBlockCandidates.push({
      text,
      dateMatches: dateMatches.filter(Boolean),
      score: hitKeyword ? 8 : 0,
      source: "text_block",
    });
  });

  const ranked = [...rowCandidates, ...textBlockCandidates]
    .map((row) => {
      const lowered = row.text.toLowerCase();
      let score = row.score;
      if (/学期开始|开学|开始日期|起始日期|学期起始/.test(row.text)) score += 6;
      if (/学年学期|第一学期|第二学期|semester|term/.test(lowered)) score += 2;
      return { ...row, score };
    })
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const topDate = top?.dateMatches?.[0] || "";
  const fallbackDirect = directDateCandidates.map((d) => normalizeFlexibleDate(d)).filter(Boolean)[0] || "";
  const allDateCandidates = [
    ...Array.from(raw.matchAll(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/g)).map((m) => normalizeFlexibleDate(m[1])),
    ...Array.from(raw.matchAll(/(\d{4}年\d{1,2}月\d{1,2}日)/g)).map((m) => normalizeFlexibleDate(m[1])),
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const earliestDate = allDateCandidates[0] || "";
  const termStartDate = normalizeFlexibleDate(
    explicitStartDate || topDate || fallbackDirect || earliestDate || ""
  );
  const currentWeek = extractCurrentWeekFromText(raw);
  const method =
    explicitStartDate
      ? "calendar_explicit_start"
      : topDate
        ? "calendar_row_match"
        : fallbackDirect
          ? "calendar_direct_key"
          : earliestDate
            ? "calendar_earliest_date"
            : "not_found";
  return {
    termStartDate,
    currentWeek: Number.isFinite(Number(currentWeek || 0)) ? Math.floor(Number(currentWeek)) : null,
    matchedRow: top?.text || "",
    method,
  };
}

async function fetchRemoteCalendarInfo(ctx, termCode = "") {
  const match = trimString(termCode).match(/^(\d{4})-([01])$/);
  const xn = match?.[1] || "";
  const xq = match?.[2] || "";
  const candidatePaths = [
    `/public/SchoolCalendar.jsp?random=${Date.now()}`,
    xn && xq ? `/public/SchoolCalendar.jsp?xn=${encodeURIComponent(xn)}&xq_m=${encodeURIComponent(xq)}&random=${Date.now()}` : "",
    `/public/SchoolCalendar.show.jsp?random=${Date.now()}`,
    xn && xq ? `/public/SchoolCalendar.show.jsp?xn=${encodeURIComponent(xn)}&xq_m=${encodeURIComponent(xq)}&random=${Date.now()}` : "",
  ].filter(Boolean);

  let best = null;
  for (const path of candidatePaths) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await remoteRequest(ctx, "GET", path, {
      referer: `${ctx.baseUrl}/frame/homes.action`,
    });
    if (resp.status !== 200 || !trimString(resp.text)) continue;
    const parsed = parseCalendarTermStartDateFromHtml(resp.text, termCode);
    const hasStartDate = Boolean(parsed.termStartDate);
    const hasWeek = Boolean(parsed.currentWeek);
    if (hasStartDate || hasWeek) {
      return {
        termStartDate: parsed.termStartDate || "",
        currentWeek: hasWeek ? Number(parsed.currentWeek) : null,
        sourcePath: path,
        responseLength: resp.text.length,
        matchedRow: parsed.matchedRow || "",
        parseMethod: parsed.method || "calendar",
      };
    }
    if (!best || resp.text.length > best.responseLength) {
      best = {
        termStartDate: "",
        currentWeek: null,
        sourcePath: path,
        responseLength: resp.text.length,
        matchedRow: parsed.matchedRow || "",
        parseMethod: parsed.method || "calendar_no_hit",
      };
    }
  }

  return best || {
    termStartDate: "",
    currentWeek: null,
    sourcePath: "",
    responseLength: 0,
    matchedRow: "",
    parseMethod: "calendar_unavailable",
  };
}

function resolveCourseTimeRange(item = {}, periodMap = {}) {
  const startPeriod = Math.max(1, Number(item.startPeriod || item.periodStart || item.orderIndex || 1));
  const endPeriod = Math.max(startPeriod, Number(item.endPeriod || item.periodEnd || startPeriod));
  const startRef = periodMap[startPeriod] || null;
  const endRef = periodMap[endPeriod] || null;
  const existingStart = normalizeHHmm(item.startTime || "");
  const existingEnd = normalizeHHmm(item.endTime || "");
  const startTime = trimString(startRef?.startTime || existingStart || "");
  const endTime = trimString(endRef?.endTime || startRef?.endTime || existingEnd || "");
  return { startTime, endTime };
}

function parseCourseRowsFromListHtml(html = "", termCode = "") {
  const rows = [];
  const trBlocks = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  trBlocks.forEach((trBlock) => {
    const tds = Array.from(trBlock.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map((m) => decodeHtmlCell(m[1]));
    if (tds.length < 12) return;
    const courseCell = trimString(tds[2]);
    const match = courseCell.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (!match) return;
    const courseId = trimString(match[1]);
    const courseName = trimString(match[2]);
    if (!courseName) return;
    const classCode = trimString(tds[0]);
    const className = trimString(tds[1]);
    const teacherName = trimString(tds[6]).replace(/^\[[^\]]+\]/, "").trim();
    const scheduleText = trimString(tds[10]);
    const note = trimString(tds[11]);
    const slots = parseScheduleSlots(scheduleText);
    if (!slots.length) {
      rows.push({
        courseId,
        courseName,
        teacherName,
        location: trimString(scheduleText),
        weekday: 1,
        startPeriod: 1,
        endPeriod: 2,
        weeks: [],
        weekRule: "all",
        weekExpr: "",
        slotFallback: true,
        sourceKey: `${courseId}:${classCode || "default"}:1:1-2`,
        note: trimString([className, note].filter(Boolean).join("; ")),
        termKey: schoolTermToInternal(termCode),
        sourceMeta: sanitizeDetail({
          teacherName,
          location: trimString(scheduleText),
          rawScheduleText: scheduleText,
          weekExpr: "",
          weekRule: "all",
          weeks: [],
        }),
      });
      return;
    }
    slots.forEach((slot) => {
      const weekKey = slot.weeks?.length ? slot.weeks.join(".") : slot.weekRule || "all";
      const sourceKey = `${courseId}:${classCode || "class"}:${slot.weekday}:${slot.startPeriod}-${slot.endPeriod}:${weekKey}`;
      rows.push({
        courseId,
        courseName,
        teacherName,
        location: slot.location || scheduleText,
        weekday: slot.weekday,
        startPeriod: slot.startPeriod,
        endPeriod: slot.endPeriod,
        weeks: normalizeWeeksArray(slot.weeks),
        weekRule: trimString(slot.weekRule || "all"),
        weekExpr: trimString(slot.weekExpr || ""),
        slotFallback: false,
        sourceKey,
        note: trimString([className, note].filter(Boolean).join("; ")),
        termKey: schoolTermToInternal(termCode),
        sourceMeta: sanitizeDetail({
          teacherName,
          location: slot.location || scheduleText,
          rawScheduleText: scheduleText,
          weekExpr: trimString(slot.weekExpr || ""),
          weekRule: trimString(slot.weekRule || "all"),
          weeks: normalizeWeeksArray(slot.weeks),
        }),
      });
    });
  });
  return rows;
}

async function loadRemoteDesEncryptor(baseUrl) {
  if (REMOTE_DES_ENCRYPTOR) return REMOTE_DES_ENCRYPTOR;
  const resp = await axios.get(`${baseUrl}/custom/js/jkingo.des.js`, { timeout: 10000, responseType: "arraybuffer" });
  if (resp.status !== 200) throw makeXiqueError(XIQUE_ERROR.STRUCTURE_CHANGED, "xique des script unavailable", 502);
  const scriptText = decodeRemoteBody(Buffer.from(resp.data), resp.headers["content-type"]);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(scriptText, sandbox, { timeout: 1000 });
  if (typeof sandbox.strEnc !== "function") {
    throw makeXiqueError(XIQUE_ERROR.STRUCTURE_CHANGED, "xique des script invalid", 502);
  }
  REMOTE_DES_ENCRYPTOR = (payload, keyText) => String(sandbox.strEnc(String(payload), String(keyText), null, null));
  return REMOTE_DES_ENCRYPTOR;
}

async function remoteRequest(ctx, method, path, options = {}) {
  const target = /^https?:\/\//i.test(path) ? path : `${ctx.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    ...(options.headers || {}),
  };
  if (ctx.cookieHeader) headers.Cookie = ctx.cookieHeader;
  if (options.referer) headers.Referer = options.referer;
  const response = await axios({
    method,
    url: target,
    data: options.data,
    responseType: options.responseType || "arraybuffer",
    timeout: Number(options.timeout || 20000),
    maxRedirects: 5,
    validateStatus: () => true,
    headers,
  });
  ctx.cookieHeader = mergeCookieHeader(ctx.cookieHeader, response.headers["set-cookie"] || []);
  const raw = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || "");
  const text = decodeRemoteBody(raw, response.headers["content-type"] || "");
  return { status: Number(response.status || 0), headers: response.headers || {}, raw, text };
}

async function createRemoteCaptchaChallenge(configRow, vaultRow) {
  const baseUrl = buildSchoolBaseUrl(configRow.baseUrl);
  const ctx = { baseUrl, cookieHeader: "" };
  const loginPage = await remoteRequest(ctx, "GET", "/cas/login.action");
  if (loginPage.status !== 200) throw makeXiqueError(XIQUE_ERROR.NETWORK_TIMEOUT, `xique login page status ${loginPage.status}`, 502);
  const loginContext = parseRemoteLoginContext(loginPage.text);
  const keyResp = await remoteRequest(ctx, "GET", "/frame/homepage?method=getTempDeskey", { referer: `${baseUrl}/cas/login.action` });
  const timeResp = await remoteRequest(ctx, "GET", "/frame/homepage?method=getTempNowtime", { referer: `${baseUrl}/cas/login.action` });
  const tempDesKey = trimString(keyResp.text);
  const timestamp = trimString(timeResp.text);
  if (!tempDesKey || !timestamp) throw makeXiqueError(XIQUE_ERROR.STRUCTURE_CHANGED, "xique login helper value missing", 502);
  const captchaResp = await remoteRequest(ctx, "GET", `/cas/genValidateCode?v=${Date.now()}`, { referer: `${baseUrl}/cas/login.action` });
  if (captchaResp.status !== 200 || !captchaResp.raw.length) throw makeXiqueError(XIQUE_ERROR.CAPTCHA_REQUIRED, "xique captcha fetch failed", 502);
  const captchaSession = createId("xcap");
  const captchaImage = `data:image/png;base64,${captchaResp.raw.toString("base64")}`;
  const captchaExpiresAt = new Date(Date.now() + Number(config.xiqueCaptchaTtlMs || 10 * 60 * 1000)).toISOString();
  REMOTE_CAPTCHA_CONTEXT.set(captchaSession, {
    captchaSession,
    baseUrl,
    cookieHeader: ctx.cookieHeader,
    sessionId: loginContext.sessionId,
    hidden: loginContext,
    tempDesKey,
    timestamp,
    expiresAt: captchaExpiresAt,
  });
  vaultRow.state = "captcha_required";
  vaultRow.captchaSession = captchaSession;
  vaultRow.captchaImage = captchaImage;
  vaultRow.captchaAnswerHash = "";
  vaultRow.captchaExpiresAt = captchaExpiresAt;
  vaultRow.updatedAt = nowIso();
  return { captchaRequired: true, captchaSession, captchaImage, captchaExpiresAt };
}

function selectRemoteTermCode(configRow, list = []) {
  const options = Array.isArray(list) ? list : [];
  if (!options.length) return "";
  const targetSet = new Set([
    trimString(configRow.currentTermKey || ""),
    internalTermToSchool(trimString(configRow.currentTermKey || "")),
    trimString(configRow.termKey || ""),
  ].filter(Boolean));
  const exact = options.find((item) => targetSet.has(trimString(item.code || item.value || item.id || "")));
  if (exact) return trimString(exact.code || exact.value || exact.id || "");
  return trimString(options[0].code || options[0].value || options[0].id || "");
}

function parseStudentNoFromWdkb(html = "") {
  return trimString((html.match(/id=["']xh["'][^>]*value=["']([^"']+)["']/i) || [])[1]
    || (html.match(/name=["']xh["'][^>]*value=["']([^"']+)["']/i) || [])[1]
    || "");
}

async function fetchRemotePeriodTimeMap(ctx, termCode = "") {
  const match = trimString(termCode).match(/^(\d{4})-([01])$/);
  if (!match) return { periodMap: {}, sourcePath: "", responseLength: 0 };
  const xn = match[1];
  const xq = match[2];
  const sourcePath = `/public/SchoolTimetable.show.jsp?random=${Date.now()}&xn=${encodeURIComponent(xn)}&xq_m=${encodeURIComponent(xq)}&is_ssxq=0`;
  const resp = await remoteRequest(ctx, "GET", sourcePath, {
    referer: `${ctx.baseUrl}/public/SchoolTimetable.jsp`,
  });
  if (resp.status !== 200 || !resp.text.trim()) {
    throw makeXiqueError(XIQUE_ERROR.PARSE_FAILED, `xique timetable page unavailable: status ${resp.status}`, 502);
  }
  const periodMap = parsePeriodTimeMapFromSchoolTimetable(resp.text);
  if (!Object.keys(periodMap).length) {
    throw makeXiqueError(XIQUE_ERROR.PARSE_FAILED, "xique timetable parse failed: empty period map", 502);
  }
  return { periodMap, sourcePath, responseLength: resp.text.length };
}

async function fetchRemoteCoursesPayload(configRow, session) {
  const baseUrl = buildSchoolBaseUrl(configRow.baseUrl);
  const ctx = { baseUrl, cookieHeader: trimString(session?.authCookie || "") };
  if (!ctx.cookieHeader) throw makeXiqueError(XIQUE_ERROR.SESSION_EXPIRED, "xique session cookie missing", 401);

  const wdkbPage = await remoteRequest(ctx, "GET", "/student/xkjg.wdkb.jsp?menucode=S20301", { referer: `${baseUrl}/frame/homes.action` });
  if (wdkbPage.status !== 200) throw makeXiqueError(XIQUE_ERROR.SESSION_EXPIRED, `xique wdkb page status ${wdkbPage.status}`, 401);
  const studentNo = parseStudentNoFromWdkb(wdkbPage.text);
  if (!studentNo) throw makeXiqueError(XIQUE_ERROR.STRUCTURE_CHANGED, "xique wdkb page missing student no", 502);

  const termResp = await remoteRequest(ctx, "POST", "/frame/droplist/getDropLists.action", {
    data: new URLSearchParams({
      comboBoxName: "StMsXnxqDxDesc",
      paramValue: "",
      isYXB: "",
      isCDDW: "",
      isXQ: "",
      isDJKSLB: "",
      isZY: "",
    }).toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    referer: `${baseUrl}/student/xkjg.wdkb.jsp?menucode=S20301`,
  });
  if (termResp.status !== 200) throw makeXiqueError(XIQUE_ERROR.NETWORK_TIMEOUT, `xique term list status ${termResp.status}`, 502);
  let termList = [];
  try {
    termList = JSON.parse(termResp.text);
  } catch (_) {
    throw makeXiqueError(XIQUE_ERROR.PARSE_FAILED, "xique term list parse failed", 502);
  }
  const termCode = selectRemoteTermCode(configRow, termList);
  if (!termCode || !termCode.includes("-")) throw makeXiqueError(XIQUE_ERROR.PARSE_FAILED, "xique term code unavailable", 502);
  const [xn, xq] = termCode.split("-");
  let calendarInfo = {
    termStartDate: "",
    currentWeek: null,
    sourcePath: "",
    responseLength: 0,
    matchedRow: "",
    parseMethod: "",
  };
  try {
    calendarInfo = await fetchRemoteCalendarInfo(ctx, termCode);
  } catch (error) {
    calendarInfo = {
      termStartDate: "",
      currentWeek: null,
      sourcePath: "",
      responseLength: 0,
      matchedRow: "",
      parseMethod: `calendar_fetch_error:${trimString(error?.message || "unknown")}`,
    };
    console.warn(`[xique] calendar parse unavailable term=${termCode} reason=${trimString(error?.message || "unknown")}`);
  }
  const encodedParams = Buffer.from(`xn=${xn}&xq=${xq}&xh=${studentNo}`, "utf8").toString("base64");
  const encodedQuery = encodeURIComponent(encodedParams);
  const primaryPath = `/wsxk/xkjg.ckdgxsxdkchj_data10319.jsp?params=${encodedQuery}`;
  const fallbackPath = `/student/wsxk.xskcb10319.jsp?params=${encodedQuery}`;
  const primary = await remoteRequest(ctx, "GET", primaryPath, { referer: `${baseUrl}/student/xkjg.wdkb.jsp?menucode=S20301` });
  const fallback = primary.text.length > 200 ? null : await remoteRequest(ctx, "GET", fallbackPath, { referer: `${baseUrl}/student/xkjg.wdkb.jsp?menucode=S20301` });
  const chosen = fallback && fallback.text.length > primary.text.length ? fallback : primary;
  if (chosen.status !== 200 || !chosen.text.trim()) {
    throw makeXiqueError(XIQUE_ERROR.PARSE_FAILED, "xique schedule page empty", 502, {
      primaryStatus: primary.status,
      primaryLen: primary.text.length,
      fallbackStatus: fallback?.status || 0,
      fallbackLen: fallback?.text.length || 0,
    });
  }
  const parsedCourses = parseCourseRowsFromListHtml(chosen.text, termCode);
  const teachingWeekContext = detectRemoteTeachingWeekContext({
    configRow,
    termList,
    wdkbHtml: wdkbPage.text,
    scheduleHtml: chosen.text,
    calendarInfo,
  });
  let periodTimeMap = {};
  let periodSourcePath = "";
  let periodResponseLength = 0;
  let periodMapError = "";
  try {
    const periodResult = await fetchRemotePeriodTimeMap(ctx, termCode);
    periodTimeMap = periodResult.periodMap || {};
    periodSourcePath = trimString(periodResult.sourcePath || "");
    periodResponseLength = Number(periodResult.responseLength || 0);
  } catch (error) {
    periodMapError = trimString(error?.message || "period_time_map_unavailable");
    console.warn(`[xique] timetable mapping unavailable term=${termCode} reason=${periodMapError}`);
  }
  const courses = parsedCourses.map((course) => {
    const range = resolveCourseTimeRange(course, periodTimeMap);
    const sourceMeta = course.sourceMeta && typeof course.sourceMeta === "object" ? course.sourceMeta : {};
    return {
      ...course,
      startTime: range.startTime,
      endTime: range.endTime,
      termStartDate: normalizeTermStartDate(course.termStartDate || teachingWeekContext.termStartDate || ""),
      sourceMeta: sanitizeDetail({
        ...sourceMeta,
        termStartDate: normalizeTermStartDate(sourceMeta.termStartDate || teachingWeekContext.termStartDate || ""),
        currentWeek: teachingWeekContext.currentWeek || "",
        currentWeekSource: teachingWeekContext.currentWeekSource || "",
      }),
    };
  });
  const mappedCourseCount = courses.filter((item) => trimString(item.startTime || "") && trimString(item.endTime || "")).length;
  const slotFallbackCount = parsedCourses.filter((item) => Boolean(item?.slotFallback)).length;
  return {
    termKey: schoolTermToInternal(termCode),
    termStartDate: normalizeTermStartDate(teachingWeekContext.termStartDate || configRow.termStartDate || ""),
    currentWeek: Number.isFinite(Number(teachingWeekContext.currentWeek || 0))
      ? Math.floor(Number(teachingWeekContext.currentWeek))
      : null,
    weekFilteringApplied: Boolean(teachingWeekContext.weekFilteringApplied),
    currentWeekSource: String(teachingWeekContext.currentWeekSource || ""),
    termStartDateSource: String(teachingWeekContext.termStartDateSource || ""),
    courses,
    sourceMeta: sanitizeDetail({
      adapterMode: "remote",
      termCode,
      studentNo: mask(studentNo, 6),
      sourcePath: chosen === primary ? primaryPath : fallbackPath,
      responseLength: chosen.text.length,
      periodMapSourcePath: periodSourcePath,
      periodMapResponseLength: periodResponseLength,
      periodMapSize: Object.keys(periodTimeMap).length,
      mappedCourseCount,
      slotFallbackCount,
      periodMapError,
      calendarTermStartDate: normalizeTermStartDate(calendarInfo.termStartDate || ""),
      calendarCurrentWeek: Number.isFinite(Number(calendarInfo.currentWeek || 0))
        ? Math.floor(Number(calendarInfo.currentWeek))
        : null,
      calendarSourcePath: trimString(calendarInfo.sourcePath || ""),
      calendarResponseLength: Number(calendarInfo.responseLength || 0),
      calendarParseMethod: trimString(calendarInfo.parseMethod || ""),
      calendarMatchedRow: trimString(calendarInfo.matchedRow || ""),
      currentWeek: Number.isFinite(Number(teachingWeekContext.currentWeek || 0))
        ? Math.floor(Number(teachingWeekContext.currentWeek))
        : null,
      currentWeekSource: String(teachingWeekContext.currentWeekSource || ""),
      termStartDate: normalizeTermStartDate(teachingWeekContext.termStartDate || ""),
      termStartDateSource: String(teachingWeekContext.termStartDateSource || ""),
      weekFilteringApplied: Boolean(teachingWeekContext.weekFilteringApplied),
    }),
    cookieHeader: ctx.cookieHeader,
  };
}
function normalizeIncomingCourse(item = {}, index = 0, termKey = "") {
  const title = trimString(item.courseName || item.title || item.name || item.course);
  if (!title) return null;
  const weekday = Math.max(1, Math.min(7, Number(item.weekday || item.day || item.week || item.weekDay || 1)));
  const startPeriod = Math.max(1, Number(item.startPeriod || item.periodStart || item.orderIndex || 1));
  const endPeriod = Math.max(startPeriod, Number(item.endPeriod || item.periodEnd || startPeriod));
  const incomingMeta = item.sourceMeta && typeof item.sourceMeta === "object" && !Array.isArray(item.sourceMeta) ? item.sourceMeta : {};
  const weeks = normalizeWeeksArray(
    Array.isArray(item.weeks) ? item.weeks : (Array.isArray(incomingMeta.weeks) ? incomingMeta.weeks : [])
  );
  const weekRule = trimString(item.weekRule || incomingMeta.weekRule || (weeks.length ? "custom" : "all")) || "all";
  const weekExpr = trimString(item.weekExpr || incomingMeta.weekExpr || "");
  const courseId = trimString(item.courseId || item.id || item.code || `course_${index + 1}`);
  const weekKey = weeks.length ? weeks.join(".") : weekRule;
  const sourceKey = trimString(
    item.sourceKey || `${courseId}:${weekday}:${startPeriod}-${endPeriod}:${weekKey}:${trimString(item.location || item.classroom || "")}`
  );
  const teacherName = trimString(item.teacherName || item.teacher || "");
  const location = trimString(item.location || item.classroom || item.room || "");
  const note = trimString(item.note || item.remark || "");
  const termStartDate = normalizeTermStartDate(item.termStartDate || incomingMeta.termStartDate || "");
  const content = [teacherName ? `teacher:${teacherName}` : "", location ? `location:${location}` : "", note].filter(Boolean).join("; ");
  const sourceMeta = sanitizeDetail({
    ...incomingMeta,
    teacherName,
    location,
    weeks,
    weekRule,
    weekExpr,
    termStartDate,
  });
  return {
    courseId,
    sourceKey,
    termKey: trimString(termKey || item.termKey || item.semesterKey || getCurrentSemesterKey()),
    title,
    content,
    weekday,
    startPeriod,
    endPeriod,
    teacherName,
    location,
    weeks,
    weekRule,
    weekExpr,
    termStartDate,
    sourceMeta,
  };
}
function normalizeScheduleRowForImport(item, defaults = {}) {
  const row = normalizeIncomingCourse(item, defaults.index || 0, defaults.termKey || "");
  if (!row) return null;
  const now = nowIso();
  const effectiveTermStartDate = normalizeTermStartDate(defaults.termStartDate || row.termStartDate || "");
  const detectedCurrentWeek = normalizeWeekNumber(
    item.currentWeek ||
    row.currentWeek ||
    row.sourceMeta?.currentWeek ||
    row.sourceMeta?.weekIndex ||
    ""
  );
  return {
    id: createId("sch"),
    deviceId: trimString(defaults.deviceId || ""),
    mode: "course",
    weekday: row.weekday,
    orderIndex: row.startPeriod,
    title: row.title,
    content: row.content,
    startTime: trimString(item.startTime || ""),
    endTime: trimString(item.endTime || ""),
    courseName: row.title,
    note: row.content,
    source: "xique",
    sourceKey: row.sourceKey,
    termKey: row.termKey,
    xiqueCourseId: row.courseId,
    xiqueClassKey: row.sourceKey,
    weeks: row.weeks,
    weekRule: row.weekRule,
    termStartDate: effectiveTermStartDate,
    sourceMeta: sanitizeDetail({
      ...(row.sourceMeta || {}),
      weeks: row.weeks,
      weekRule: row.weekRule,
      weekExpr: row.weekExpr,
      termStartDate: effectiveTermStartDate,
      currentWeek: detectedCurrentWeek || "",
      currentWeekDetectedAt: detectedCurrentWeek ? now : "",
    }),
    createdAt: now,
    updatedAt: now,
  };
}

function getScheduleSourceKeyAliases(row = {}) {
  const keys = new Set();
  const sourceKey = trimString(row.sourceKey || row.xiqueClassKey || "");
  if (sourceKey) keys.add(sourceKey);
  const courseId = trimString(row.xiqueCourseId || row.courseId || "");
  const weekday = Number(row.weekday || 0);
  const startPeriod = Number(row.startPeriod || row.orderIndex || 0);
  const endPeriod = Number(row.endPeriod || row.periodEnd || startPeriod || 0);
  const location = trimString(row.location || row.sourceMeta?.location || "");
  if (courseId && weekday && startPeriod) {
    keys.add(`${courseId}:${weekday}:${startPeriod}-${Math.max(startPeriod, endPeriod || startPeriod)}:${location}`);
  }
  const match = sourceKey.match(/^([^:]+):(\d+):(\d+-\d+):(all|odd|even|[\d.]*):(.*)$/);
  if (match) {
    keys.add(`${match[1]}:${match[2]}:${match[3]}:${match[5] || ""}`);
  }
  return Array.from(keys).filter(Boolean);
}

function ensureCollections(draft) {
  draft.scheduleSyncConfigs = Array.isArray(draft.scheduleSyncConfigs) ? draft.scheduleSyncConfigs : [];
  draft.xiqueSessionVault = Array.isArray(draft.xiqueSessionVault) ? draft.xiqueSessionVault : [];
  draft.syncLogs = Array.isArray(draft.syncLogs) ? draft.syncLogs : [];
}
function getOrCreateConfigRow(draft, deviceId, ownerId = "") {
  ensureCollections(draft);
  let row = draft.scheduleSyncConfigs.find((item) => item.deviceId === deviceId);
  if (!row) {
    row = {
      id: createId("xsync"),
      deviceId,
      ownerId,
      source: "xique",
      enabled: false,
      intervalMinutes: 60,
      currentTermKey: getCurrentSemesterKey(),
      termStartDate: normalizeTermStartDate(config.xiqueDefaultTermStartDate || ""),
      currentWeek: null,
      currentWeekAt: "",
      currentWeekSource: "",
      adapterMode: "remote",
      baseUrl: "http://jw.sdivc.edu.cn",
      sampleUrl: "",
      sampleHtml: "",
      sampleJson: {},
      requireCaptcha: false,
      needRelogin: false,
      needCaptchaReverify: false,
      paused: false,
      pauseReason: "",
      pauseUntil: "",
      failureCount: 0,
      lastAttemptAt: "",
      lastSuccessAt: "",
      lastSyncAt: "",
      lastSyncStatus: "",
      lastSyncErrorCode: "",
      lastError: "",
      nextRunAt: "",
      loginUsername: "",
      loginDisplayName: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    draft.scheduleSyncConfigs.unshift(row);
  }
  return row;
}
function getVaultRow(draft, configId) {
  ensureCollections(draft);
  let row = draft.xiqueSessionVault.find((item) => item.configId === configId);
  if (!row) {
    row = { id: createId("xvault"), configId, deviceId: "", state: "idle", sessionId: "", sessionExpiresAt: "", authCookieCipher: "", authTokenCipher: "", credentialCipher: "", captchaSession: "", captchaImage: "", captchaAnswerHash: "", captchaExpiresAt: "", needCaptchaReverify: false, lastVerifiedAt: "", lastLoginAt: "", lastSyncAt: "", lastSyncStatus: "", lastSyncErrorCode: "", lastError: "", createdAt: nowIso(), updatedAt: nowIso() };
    draft.xiqueSessionVault.unshift(row);
  }
  return row;
}

function pushSyncLog(draft, entry) {
  ensureCollections(draft);
  draft.syncLogs.unshift({ id: createId("xslog"), configId: trimString(entry.configId || ""), deviceId: trimString(entry.deviceId || ""), action: trimString(entry.action || "sync"), status: trimString(entry.status || "info"), detail: sanitizeDetail(entry.detail || {}), createdAt: nowIso() });
  draft.syncLogs = draft.syncLogs.slice(0, SYNC_LOG_LIMIT);
}

function buildSafeConfig(row = {}) {
  return {
    id: trimString(row.id || ""),
    deviceId: trimString(row.deviceId || ""),
    ownerId: trimString(row.ownerId || ""),
    source: "xique",
    enabled: Boolean(row.enabled),
    intervalMinutes: normalizeIntervalMinutes(row.intervalMinutes),
    currentTermKey: trimString(row.currentTermKey || row.termKey || getCurrentSemesterKey()),
    termStartDate: normalizeTermStartDate(row.termStartDate || config.xiqueDefaultTermStartDate || ""),
    currentWeek: Number.isFinite(Number(row.currentWeek || 0)) && Number(row.currentWeek || 0) > 0
      ? Math.floor(Number(row.currentWeek))
      : null,
    currentWeekAt: trimString(row.currentWeekAt || ""),
    currentWeekSource: trimString(row.currentWeekSource || ""),
    adapterMode: trimString(row.adapterMode || "mock"),
    baseUrl: trimString(row.baseUrl || ""),
    sampleUrl: trimString(row.sampleUrl || ""),
    sampleHtml: trimString(row.sampleHtml || ""),
    requireCaptcha: Boolean(row.requireCaptcha),
    needRelogin: Boolean(row.needRelogin),
    needCaptchaReverify: Boolean(row.needCaptchaReverify),
    paused: Boolean(row.paused),
    pauseReason: trimString(row.pauseReason || ""),
    pauseUntil: trimString(row.pauseUntil || ""),
    failureCount: Number(row.failureCount || 0),
    lastAttemptAt: trimString(row.lastAttemptAt || ""),
    lastSuccessAt: trimString(row.lastSuccessAt || ""),
    lastSyncAt: trimString(row.lastSyncAt || row.lastSuccessAt || ""),
    lastSyncStatus: trimString(row.lastSyncStatus || ""),
    lastSyncErrorCode: trimString(row.lastSyncErrorCode || ""),
    lastError: trimString(row.lastError || ""),
    nextRunAt: trimString(row.nextRunAt || ""),
    loginUsername: trimString(row.loginUsername || ""),
    loginDisplayName: trimString(row.loginDisplayName || ""),
    createdAt: trimString(row.createdAt || ""),
    updatedAt: trimString(row.updatedAt || ""),
  };
}

function buildSafeVault(row = {}) {
  const credentialCipher = trimString(row.credentialCipher || "");
  let hasCredentialUsable = false;
  if (credentialCipher) {
    try {
      hasCredentialUsable = Boolean(trimString(decryptSecret(credentialCipher)));
    } catch (_) {
      hasCredentialUsable = false;
    }
  }
  return {
    id: trimString(row.id || ""),
    configId: trimString(row.configId || ""),
    deviceId: trimString(row.deviceId || ""),
    state: trimString(row.state || "idle"),
    sessionId: trimString(row.sessionId || ""),
    sessionExpiresAt: trimString(row.sessionExpiresAt || ""),
    captchaSession: trimString(row.captchaSession || ""),
    captchaImage: trimString(row.captchaImage || ""),
    captchaExpiresAt: trimString(row.captchaExpiresAt || ""),
    needCaptchaReverify: Boolean(row.needCaptchaReverify),
    lastVerifiedAt: trimString(row.lastVerifiedAt || ""),
    lastLoginAt: trimString(row.lastLoginAt || ""),
    lastSyncAt: trimString(row.lastSyncAt || ""),
    lastSyncStatus: trimString(row.lastSyncStatus || ""),
    lastSyncErrorCode: trimString(row.lastSyncErrorCode || ""),
    lastError: trimString(row.lastError || ""),
    hasCredential: Boolean(credentialCipher),
    hasCredentialUsable,
    hasSession: Boolean(row.sessionId),
  };
}

function createCaptchaChallenge(configRow, vaultRow) {
  const code = String(Math.floor(1000 + Math.random() * 9000));
  const captchaSession = createId("xcap");
  const captchaImage = renderCaptchaImage(code);
  const captchaExpiresAt = new Date(Date.now() + Number(config.xiqueCaptchaTtlMs || 10 * 60 * 1000)).toISOString();
  vaultRow.state = "captcha_required";
  vaultRow.captchaSession = captchaSession;
  vaultRow.captchaImage = captchaImage;
  vaultRow.captchaAnswerHash = sha(code);
  vaultRow.captchaExpiresAt = captchaExpiresAt;
  vaultRow.needCaptchaReverify = Boolean(configRow.needCaptchaReverify);
  vaultRow.updatedAt = nowIso();
  return { captchaRequired: true, captchaSession, captchaImage, captchaExpiresAt };
}

async function createXiqueClient(configRow = {}, vaultRow = {}, options = {}) {
  const adapterMode = trimString(configRow.adapterMode || "mock").toLowerCase() === "remote" ? "remote" : "mock";
  const requireCaptcha = adapterMode === "remote" ? true : Boolean(configRow.requireCaptcha || options.forceCaptcha);

  const issueSession = ({ authCookie = "", authToken = "" } = {}) => {
    const cookieText = trimString(authCookie || "");
    const tokenText = trimString(authToken || "");
    const sessionIdFromCookie = (cookieText.match(/(?:^|;\s*)JSESSIONID=([^;\s]+)/i) || [])[1] || "";
    const sessionId = trimString(sessionIdFromCookie || vaultRow.sessionId || createId("xsess"));
    const sessionExpiresAt = new Date(Date.now() + Number(config.xiqueSessionTtlMs || 6 * 60 * 60 * 1000)).toISOString();
    const fallbackToken = tokenText || `xique_token_${createId("tok")}`;
    const fallbackCookie = cookieText || `xique_cookie_${createId("ck")}`;
    vaultRow.state = "authenticated";
    vaultRow.sessionId = sessionId;
    vaultRow.sessionExpiresAt = sessionExpiresAt;
    vaultRow.authTokenCipher = encryptSecret(fallbackToken);
    vaultRow.authCookieCipher = encryptSecret(fallbackCookie);
    vaultRow.captchaSession = "";
    vaultRow.captchaImage = "";
    vaultRow.captchaAnswerHash = "";
    vaultRow.captchaExpiresAt = "";
    vaultRow.needCaptchaReverify = false;
    vaultRow.lastVerifiedAt = nowIso();
    vaultRow.lastLoginAt = nowIso();
    return { sessionId, sessionExpiresAt, authToken: fallbackToken, authCookie: fallbackCookie };
  };

  const validSession = () => vaultRow.sessionId && vaultRow.sessionExpiresAt && Date.parse(vaultRow.sessionExpiresAt) > Date.now()
    ? {
      sessionId: vaultRow.sessionId,
      sessionExpiresAt: vaultRow.sessionExpiresAt,
      authToken: vaultRow.authTokenCipher ? decryptSecret(vaultRow.authTokenCipher) : "",
      authCookie: vaultRow.authCookieCipher ? decryptSecret(vaultRow.authCookieCipher) : "",
    }
    : null;

  const currentChallenge = () => vaultRow.captchaSession && vaultRow.captchaImage && vaultRow.captchaExpiresAt && Date.parse(vaultRow.captchaExpiresAt) > Date.now()
    ? { captchaRequired: true, captchaSession: vaultRow.captchaSession, captchaImage: vaultRow.captchaImage, captchaExpiresAt: vaultRow.captchaExpiresAt }
    : null;

  return {
    async prepareLogin() {
      const session = validSession();
      if (session && !options.forceCaptcha && !vaultRow.needCaptchaReverify) {
        return { loginRequired: false, captchaRequired: false, session };
      }
      if (adapterMode !== "remote") {
        if (requireCaptcha || vaultRow.needCaptchaReverify || options.forceCaptcha) return currentChallenge() || createCaptchaChallenge(configRow, vaultRow);
        return { loginRequired: false, captchaRequired: false, session: issueSession() };
      }
      return createRemoteCaptchaChallenge(configRow, vaultRow);
    },

    async completeLogin({ captchaAnswer = "", captchaSession = "", refreshOnInvalid = false } = {}) {
      const existing = validSession();
      if (existing && !options.forceCaptcha && !vaultRow.needCaptchaReverify) {
        return { loginRequired: false, captchaRequired: false, session: existing };
      }

      if (adapterMode !== "remote") {
        if (!requireCaptcha && !vaultRow.needCaptchaReverify && !options.forceCaptcha) {
          return { loginRequired: false, captchaRequired: false, session: issueSession() };
        }
        const challenge = currentChallenge() || createCaptchaChallenge(configRow, vaultRow);
        if (captchaSession && vaultRow.captchaSession && captchaSession !== vaultRow.captchaSession) throw new HttpError(400, "captcha session mismatch");
        if (!captchaAnswer) return challenge;
        if (sha(captchaAnswer) !== vaultRow.captchaAnswerHash) {
          if (!refreshOnInvalid) {
            throw makeXiqueError(XIQUE_ERROR.CAPTCHA_INVALID, "captcha invalid", 400);
          }
          return createCaptchaChallenge(configRow, vaultRow);
        }
        return { loginRequired: false, captchaRequired: false, session: issueSession() };
      }

      const context = REMOTE_CAPTCHA_CONTEXT.get(captchaSession || vaultRow.captchaSession || "");
      if (!context || Date.parse(context.expiresAt || "") <= Date.now()) {
        return createRemoteCaptchaChallenge(configRow, vaultRow);
      }
      const answer = trimString(captchaAnswer);
      if (!answer) {
        return {
          captchaRequired: true,
          captchaSession: context.captchaSession || captchaSession || vaultRow.captchaSession,
          captchaImage: vaultRow.captchaImage || "",
          captchaExpiresAt: context.expiresAt || vaultRow.captchaExpiresAt || "",
        };
      }

      const username = trimString(configRow.loginUsername || "");
      let password = "";
      if (vaultRow.credentialCipher) {
        try {
          password = trimString(decryptSecret(vaultRow.credentialCipher));
        } catch (_) {
          password = "";
        }
      }
      if (!username || !password) {
        return {
          captchaRequired: true,
          credentialRequired: true,
          credentialReason: "xique credentials missing",
          captchaSession: context.captchaSession || captchaSession || vaultRow.captchaSession || "",
          captchaImage: vaultRow.captchaImage || "",
          captchaExpiresAt: context.expiresAt || vaultRow.captchaExpiresAt || "",
        };
      }

      const encryptFn = await loadRemoteDesEncryptor(context.baseUrl);
      const isPolicy = password && password !== username && password.length >= 6 ? "1" : "0";
      const passwordEncrypted = md5Hex(md5Hex(password) + md5Hex(answer.toLowerCase()));
      const usernamePayload = Buffer.from(`${username};;${context.sessionId}`, "utf8").toString("base64");
      const rawParams = `_u${answer}=${usernamePayload}`
        + `&_p${answer}=${passwordEncrypted}`
        + `&randnumber=${answer}`
        + `&isPasswordPolicy=${isPolicy}`
        + `&txt_mm_expression=${context.hidden.txt_mm_expression || ""}`
        + `&txt_mm_length=${context.hidden.txt_mm_length || ""}`
        + `&txt_mm_userzh=${context.hidden.txt_mm_userzh || ""}`
        + `&hid_flag=${context.hidden.hid_flag || "1"}`
        + "&hidlag=1"
        + `&hid_dxyzm=${context.hidden.hid_dxyzm || ""}`;

      const token = md5Hex(md5Hex(rawParams) + md5Hex(String(context.timestamp || "")));
      const encryptedParams = Buffer.from(encryptFn(rawParams, context.tempDesKey), "utf8").toString("base64");
      const body = new URLSearchParams({
        params: encryptedParams,
        token,
        timestamp: String(context.timestamp || ""),
        deskey: "",
        ssessionid: String(context.sessionId || ""),
      }).toString();

      const reqCtx = { baseUrl: context.baseUrl, cookieHeader: context.cookieHeader };
      const loginResp = await remoteRequest(reqCtx, "POST", "/cas/logon.action", {
        data: body,
        referer: `${context.baseUrl}/cas/login.action`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      if (loginResp.status !== 200 || !loginResp.text.trim()) throw makeXiqueError(XIQUE_ERROR.LOGIN_FAILED, "xique login request failed", 502);
      let result = null;
      try {
        result = JSON.parse(loginResp.text);
      } catch (_) {
        throw makeXiqueError(XIQUE_ERROR.PARSE_FAILED, "xique login response parse failed", 502);
      }
      const status = trimString(result.status || "");
      const message = trimString(result.message || "");
      if (status !== "200") {
        if (/(captcha|验证码)/i.test(message)) {
          return createRemoteCaptchaChallenge(configRow, vaultRow);
        }
        if (/账号|密码|credential|login/i.test(message)) {
          throw makeXiqueError(XIQUE_ERROR.CREDENTIAL_INVALID, message || "xique credential invalid", 401);
        }
        throw makeXiqueError(XIQUE_ERROR.LOGIN_FAILED, message || "xique login failed", 401);
      }
      const resultPath = trimString(result.result || "/frame/homes.action");
      await remoteRequest(reqCtx, "GET", /^https?:\/\//i.test(resultPath) ? resultPath : `${context.baseUrl}${resultPath.startsWith("/") ? resultPath : `/${resultPath}`}`, {
        referer: `${context.baseUrl}/cas/login.action`,
      });
      REMOTE_CAPTCHA_CONTEXT.delete(captchaSession || vaultRow.captchaSession || "");
      return { loginRequired: false, captchaRequired: false, session: issueSession({ authCookie: reqCtx.cookieHeader, authToken: "" }) };
    },

    async fetchCourses(session) {
      const activeSession = session && session.authCookie ? session : validSession();
      if (!activeSession) throw makeXiqueError(XIQUE_ERROR.SESSION_EXPIRED, "xique session expired", 401);
      if (adapterMode !== "remote") {
        const payload = await loadSamplePayload(configRow);
        return {
          termKey: trimString(payload.termKey || configRow.currentTermKey || getCurrentSemesterKey()),
          termStartDate: normalizeTermStartDate(payload.termStartDate || configRow.termStartDate || ""),
          currentWeek: Number.isFinite(Number(payload.currentWeek || 0)) && Number(payload.currentWeek || 0) > 0
            ? Math.floor(Number(payload.currentWeek))
            : null,
          weekFilteringApplied: Number.isFinite(Number(payload.currentWeek || 0)) && Number(payload.currentWeek || 0) > 0,
          courses: Array.isArray(payload.courses) ? payload.courses : [],
          sourceMeta: {
            adapterMode: trimString(configRow.adapterMode || "mock"),
            currentWeek: Number.isFinite(Number(payload.currentWeek || 0)) && Number(payload.currentWeek || 0) > 0
              ? Math.floor(Number(payload.currentWeek))
              : null,
            termStartDate: normalizeTermStartDate(payload.termStartDate || configRow.termStartDate || ""),
          },
        };
      }
      const remotePayload = await fetchRemoteCoursesPayload(configRow, activeSession);
      if (remotePayload.cookieHeader) {
        issueSession({ authCookie: remotePayload.cookieHeader, authToken: "" });
      }
      return {
        termKey: trimString(remotePayload.termKey || configRow.currentTermKey || getCurrentSemesterKey()),
        termStartDate: normalizeTermStartDate(remotePayload.termStartDate || configRow.termStartDate || ""),
        currentWeek: Number.isFinite(Number(remotePayload.currentWeek || 0)) && Number(remotePayload.currentWeek || 0) > 0
          ? Math.floor(Number(remotePayload.currentWeek))
          : null,
        currentWeekSource: trimString(remotePayload.currentWeekSource || ""),
        termStartDateSource: trimString(remotePayload.termStartDateSource || ""),
        weekFilteringApplied: Boolean(remotePayload.weekFilteringApplied),
        courses: Array.isArray(remotePayload.courses) ? remotePayload.courses : [],
        sourceMeta: sanitizeDetail(remotePayload.sourceMeta || { adapterMode: "remote" }),
      };
    },
  };
}

function buildNeedManualCaptchaPayload({ deviceId, configId, challenge, ocrFailCount = 0, reason = "captcha_required" }) {
  return {
    status: "need_manual_captcha",
    loginStatus: XIQUE_LOGIN_STATUS.NEED_MANUAL_CAPTCHA,
    needManualCaptcha: true,
    reason,
    ocrFailCount: Number(ocrFailCount || 0),
    deviceId: trimString(deviceId || ""),
    configId: trimString(configId || ""),
    taskId: trimString(configId || ""),
    captchaSession: trimString(challenge?.captchaSession || ""),
    captchaImage: trimString(challenge?.captchaImage || ""),
    captchaExpiresAt: trimString(challenge?.captchaExpiresAt || ""),
    message: "captcha manual input required",
  };
}

async function resolveLoginSessionWithCaptchaStrategy({
  client,
  prepared,
  captchaAnswer = "",
  captchaSession = "",
  allowAutoOcr = true,
  maxOcrFailures = Number(config.xiqueOcrMaxFailuresBeforeManual || 2),
  deviceId = "",
  configId = "",
}) {
  if (prepared?.session && !prepared?.captchaRequired) {
    return {
      status: "success",
      loginStatus: XIQUE_LOGIN_STATUS.SUCCESS,
      session: prepared.session,
      ocrAttempts: 0,
      ocrFailures: 0,
      manualRequired: false,
    };
  }

  if (trimString(captchaAnswer)) {
    const manualResult = await client.completeLogin({
      captchaAnswer: trimString(captchaAnswer),
      captchaSession: trimString(captchaSession || prepared?.captchaSession || ""),
    });
    if (manualResult?.credentialRequired) {
      return {
        status: "need_manual_captcha",
        loginStatus: XIQUE_LOGIN_STATUS.NEED_MANUAL_CAPTCHA,
        manualRequired: true,
        needRelogin: true,
        reason: trimString(manualResult.credentialReason || "credential_missing"),
        ocrAttempts: 0,
        ocrFailures: 0,
        challenge: {
          captchaSession: manualResult.captchaSession,
          captchaImage: manualResult.captchaImage,
          captchaExpiresAt: manualResult.captchaExpiresAt,
        },
      };
    }
    if (manualResult?.captchaRequired) {
      return {
        status: "need_manual_captcha",
        loginStatus: XIQUE_LOGIN_STATUS.NEED_MANUAL_CAPTCHA,
        manualRequired: true,
        ocrAttempts: 0,
        ocrFailures: 0,
        challenge: {
          captchaSession: manualResult.captchaSession,
          captchaImage: manualResult.captchaImage,
          captchaExpiresAt: manualResult.captchaExpiresAt,
        },
      };
    }
    return {
      status: "success",
      loginStatus: XIQUE_LOGIN_STATUS.SUCCESS,
      session: manualResult.session,
      ocrAttempts: 0,
      ocrFailures: 0,
      manualRequired: false,
    };
  }

  if (!prepared?.captchaRequired) {
    const loginResult = await client.completeLogin({ captchaAnswer: "", captchaSession: "" });
    if (loginResult?.credentialRequired) {
      return {
        status: "need_manual_captcha",
        loginStatus: XIQUE_LOGIN_STATUS.NEED_MANUAL_CAPTCHA,
        manualRequired: true,
        needRelogin: true,
        reason: trimString(loginResult.credentialReason || "credential_missing"),
        ocrAttempts: 0,
        ocrFailures: 0,
        challenge: {
          captchaSession: loginResult.captchaSession,
          captchaImage: loginResult.captchaImage,
          captchaExpiresAt: loginResult.captchaExpiresAt,
        },
      };
    }
    if (loginResult?.captchaRequired) {
      return {
        status: "need_manual_captcha",
        loginStatus: XIQUE_LOGIN_STATUS.NEED_MANUAL_CAPTCHA,
        manualRequired: true,
        ocrAttempts: 0,
        ocrFailures: 0,
        challenge: {
          captchaSession: loginResult.captchaSession,
          captchaImage: loginResult.captchaImage,
          captchaExpiresAt: loginResult.captchaExpiresAt,
        },
      };
    }
    return {
      status: "success",
      loginStatus: XIQUE_LOGIN_STATUS.SUCCESS,
      session: loginResult.session,
      ocrAttempts: 0,
      ocrFailures: 0,
      manualRequired: false,
    };
  }

  if (!allowAutoOcr || !config.xiqueOcrEnabled) {
    return {
      status: "need_manual_captcha",
      loginStatus: XIQUE_LOGIN_STATUS.NEED_MANUAL_CAPTCHA,
      manualRequired: true,
      ocrAttempts: 0,
      ocrFailures: 0,
      challenge: {
        captchaSession: prepared.captchaSession,
        captchaImage: prepared.captchaImage,
        captchaExpiresAt: prepared.captchaExpiresAt,
      },
    };
  }

  let challenge = {
    captchaSession: prepared.captchaSession,
    captchaImage: prepared.captchaImage,
    captchaExpiresAt: prepared.captchaExpiresAt,
  };
  let ocrAttempts = 0;
  let ocrFailures = 0;
  const failureLimit = Math.max(1, Number(maxOcrFailures || 2));

  while (ocrFailures < failureLimit) {
    ocrAttempts += 1;
    const ocrResult = await recognizeCaptchaFromDataUrl(challenge.captchaImage, {
      expectedLength: Number(config.xiqueCaptchaExpectedLength || 4),
    });

    if (!ocrResult.ok || !trimString(ocrResult.text)) {
      ocrFailures += 1;
      if (ocrFailures >= failureLimit) break;
      try {
        const nextChallenge = await client.completeLogin({
          captchaAnswer: "0",
          captchaSession: trimString(challenge.captchaSession || ""),
          refreshOnInvalid: true,
        });
        if (nextChallenge?.credentialRequired) {
          return {
            status: "need_manual_captcha",
            loginStatus: XIQUE_LOGIN_STATUS.NEED_MANUAL_CAPTCHA,
            manualRequired: true,
            needRelogin: true,
            reason: trimString(nextChallenge.credentialReason || "credential_missing"),
            ocrAttempts,
            ocrFailures,
            challenge: {
              captchaSession: nextChallenge.captchaSession,
              captchaImage: nextChallenge.captchaImage,
              captchaExpiresAt: nextChallenge.captchaExpiresAt,
            },
          };
        }
        if (nextChallenge?.captchaRequired) {
          challenge = {
            captchaSession: nextChallenge.captchaSession,
            captchaImage: nextChallenge.captchaImage,
            captchaExpiresAt: nextChallenge.captchaExpiresAt,
          };
        }
      } catch (error) {
        return {
          status: "failed",
          loginStatus: XIQUE_LOGIN_STATUS.LOGIN_FAILED,
          manualRequired: false,
          ocrAttempts,
          ocrFailures,
          error,
        };
      }
      continue;
    }

    const loginResult = await client.completeLogin({
      captchaAnswer: trimString(ocrResult.text),
      captchaSession: trimString(challenge.captchaSession || ""),
      refreshOnInvalid: true,
    });
    if (loginResult?.credentialRequired) {
      return {
        status: "need_manual_captcha",
        loginStatus: XIQUE_LOGIN_STATUS.NEED_MANUAL_CAPTCHA,
        manualRequired: true,
        needRelogin: true,
        reason: trimString(loginResult.credentialReason || "credential_missing"),
        ocrAttempts,
        ocrFailures: Math.max(ocrFailures, 1),
        challenge: {
          captchaSession: loginResult.captchaSession,
          captchaImage: loginResult.captchaImage,
          captchaExpiresAt: loginResult.captchaExpiresAt,
        },
      };
    }
    if (!loginResult?.captchaRequired) {
      return {
        status: "success",
        loginStatus: XIQUE_LOGIN_STATUS.SUCCESS,
        session: loginResult.session,
        manualRequired: false,
        ocrAttempts,
        ocrFailures,
      };
    }

    ocrFailures += 1;
    challenge = {
      captchaSession: loginResult.captchaSession,
      captchaImage: loginResult.captchaImage,
      captchaExpiresAt: loginResult.captchaExpiresAt,
    };
  }

  return {
    status: "need_manual_captcha",
    loginStatus: XIQUE_LOGIN_STATUS.NEED_MANUAL_CAPTCHA,
    manualRequired: true,
    ocrAttempts,
    ocrFailures,
    challenge,
    payload: buildNeedManualCaptchaPayload({
      deviceId,
      configId,
      challenge,
      ocrFailCount: ocrFailures,
      reason: "ocr_retry_exhausted",
    }),
  };
}

function importXiqueCoursesToDraft(draft, configRow, payload, options = {}) {
  ensureCollections(draft);
  const deviceId = trimString(configRow.deviceId || options.deviceId || "");
  const termKey = trimString(payload.termKey || configRow.currentTermKey || getCurrentSemesterKey());
  const termStartDate = normalizeTermStartDate(
    payload.termStartDate || configRow.termStartDate || config.xiqueDefaultTermStartDate || ""
  );
  const existing = draft.schedules.filter(
    (item) => item.deviceId === deviceId && item.source === "xique" && item.termKey === termKey
  );
  const existingMap = new Map();
  existing.forEach((row) => {
    getScheduleSourceKeyAliases(row).forEach((key) => {
      if (!existingMap.has(key)) existingMap.set(key, row);
    });
  });
  const result = { added: 0, updated: 0, skipped: 0, overwritten: 0, imported: 0, totalIncoming: 0, termKey };

  const dedupMap = new Map();
  (payload.courses || []).forEach((item, index) => {
    const row = normalizeScheduleRowForImport(item, { index, termKey, deviceId, termStartDate });
    if (!row) {
      result.skipped += 1;
      return;
    }
    result.totalIncoming += 1;
    const key = String(row.sourceKey || "");
    if (!key || dedupMap.has(key)) {
      result.skipped += 1;
      return;
    }
    dedupMap.set(key, row);

    const current = getScheduleSourceKeyAliases(row).map((alias) => existingMap.get(alias)).find(Boolean);
    if (!current) {
      result.added += 1;
      return;
    }

    const before = JSON.stringify({
      deviceId: current.deviceId,
      mode: current.mode,
      weekday: current.weekday,
      orderIndex: current.orderIndex,
      title: current.title,
      content: current.content,
      startTime: current.startTime,
      endTime: current.endTime,
      courseName: current.courseName,
      note: current.note,
      source: current.source,
      sourceKey: current.sourceKey,
      termKey: current.termKey,
      xiqueCourseId: current.xiqueCourseId,
      xiqueClassKey: current.xiqueClassKey,
      weeks: normalizeWeeksArray(current.weeks || current.sourceMeta?.weeks || []),
      weekRule: trimString(current.weekRule || current.sourceMeta?.weekRule || ""),
      termStartDate: normalizeTermStartDate(current.termStartDate || current.sourceMeta?.termStartDate || ""),
      sourceMeta: current.sourceMeta,
    });
    const nextComparable = JSON.stringify({
      deviceId: row.deviceId,
      mode: row.mode,
      weekday: row.weekday,
      orderIndex: row.orderIndex,
      title: row.title,
      content: row.content,
      startTime: row.startTime,
      endTime: row.endTime,
      courseName: row.courseName,
      note: row.note,
      source: row.source,
      sourceKey: row.sourceKey,
      termKey: row.termKey,
      xiqueCourseId: row.xiqueCourseId,
      xiqueClassKey: row.xiqueClassKey,
      weeks: normalizeWeeksArray(row.weeks || row.sourceMeta?.weeks || []),
      weekRule: trimString(row.weekRule || row.sourceMeta?.weekRule || ""),
      termStartDate: normalizeTermStartDate(row.termStartDate || row.sourceMeta?.termStartDate || ""),
      sourceMeta: row.sourceMeta,
    });
    if (before === nextComparable) {
      result.skipped += 1;
    } else {
      result.updated += 1;
    }
  });

  // 覆盖导入：仅保留用户手工日程，当前 term 的 xique 记录整体替换。
  const incomingRows = Array.from(dedupMap.values());
  const incomingKeys = new Set();
  incomingRows.forEach((row) => {
    getScheduleSourceKeyAliases(row).forEach((key) => incomingKeys.add(key));
  });
  result.overwritten = existing.filter((row) => !getScheduleSourceKeyAliases(row).some((key) => incomingKeys.has(key))).length;
  draft.schedules = draft.schedules.filter(
    (item) => !(item.deviceId === deviceId && item.source === "xique" && item.termKey === termKey)
  );
  for (let i = incomingRows.length - 1; i >= 0; i -= 1) {
    draft.schedules.unshift(incomingRows[i]);
  }
  result.imported = incomingRows.length;
  return result;
}

function getSchedulerDecision(now = new Date(), configRow = {}) {
  if (!configRow || configRow.enabled === false) return { shouldRun: false, reason: "disabled" };
  if (configRow.needCaptchaReverify) return { shouldRun: false, reason: "needCaptchaReverify" };
  if (configRow.paused) return { shouldRun: false, reason: "paused" };
  if (!isWithinActiveWindow(now)) return { shouldRun: false, reason: "quiet_hours" };
  if (configRow.pauseUntil && Date.parse(configRow.pauseUntil) > now.getTime()) return { shouldRun: false, reason: "pause_until" };
  if (configRow.nextRunAt && Date.parse(configRow.nextRunAt) > now.getTime()) return { shouldRun: false, reason: "not_due" };
  return { shouldRun: true, reason: "due" };
}
async function markNeedCaptchaReverify(configId, reason = "session_expired") {
  await updateDB((draft) => {
    const cfg = draft.scheduleSyncConfigs.find((item) => item.id === configId);
    const vault = draft.xiqueSessionVault.find((item) => item.configId === configId);
    if (!cfg) return;
    cfg.needRelogin = true;
    cfg.needCaptchaReverify = true;
    cfg.lastSyncAt = nowIso();
    cfg.lastSyncStatus = "failed";
    cfg.lastSyncErrorCode = reason;
    cfg.lastError = reason;
    cfg.updatedAt = nowIso();
    if (vault) {
      vault.needCaptchaReverify = true;
      vault.state = "expired";
      vault.lastSyncAt = nowIso();
      vault.lastSyncStatus = "failed";
      vault.lastSyncErrorCode = reason;
      vault.lastError = reason;
      vault.updatedAt = nowIso();
    }
    pushSyncLog(draft, { configId, deviceId: cfg.deviceId, action: "captcha_reverify", status: "warn", detail: { reason } });
  });
}

async function saveXiqueSyncConfig({ auth, deviceId, body = {} }) {
  const db = await readDB();
  ensureDeviceAccess(db, auth, deviceId);
  const device = db.devices.find((item) => item.id === deviceId);
  let safeConfig = null;
  let safeVault = null;
  await updateDB((draft) => {
    const cfg = getOrCreateConfigRow(draft, deviceId, device?.ownerId || auth.userId || "");
    const vault = getVaultRow(draft, cfg.id);
    cfg.enabled = body.enabled === undefined ? false : Boolean(body.enabled);
    cfg.intervalMinutes = normalizeIntervalMinutes(body.intervalMinutes);
    cfg.currentTermKey = trimString(body.currentTermKey || body.termKey || getCurrentSemesterKey());
    if (body.termStartDate !== undefined) {
      cfg.termStartDate = normalizeTermStartDate(body.termStartDate || "");
    } else if (!trimString(cfg.termStartDate || "")) {
      cfg.termStartDate = normalizeTermStartDate(config.xiqueDefaultTermStartDate || "");
    }
    if (body.currentWeek !== undefined) {
      const manualWeek = normalizeWeekNumber(body.currentWeek);
      cfg.currentWeek = manualWeek || null;
      cfg.currentWeekAt = manualWeek ? nowIso() : "";
      cfg.currentWeekSource = manualWeek ? "manual_config" : "";
    } else if (!Number.isFinite(Number(cfg.currentWeek || 0))) {
      cfg.currentWeek = null;
      cfg.currentWeekAt = trimString(cfg.currentWeekAt || "");
      cfg.currentWeekSource = trimString(cfg.currentWeekSource || "");
    }
    if (body.adapterMode !== undefined) {
      cfg.adapterMode = trimString(body.adapterMode || "mock").toLowerCase() === "remote" ? "remote" : "mock";
    } else {
      cfg.adapterMode = trimString(cfg.adapterMode || "remote").toLowerCase() === "remote" ? "remote" : "mock";
    }
    if (body.baseUrl !== undefined) cfg.baseUrl = trimString(body.baseUrl || "");
    if (body.sampleUrl !== undefined) cfg.sampleUrl = trimString(body.sampleUrl || "");
    if (body.sampleHtml !== undefined) cfg.sampleHtml = trimString(body.sampleHtml || "");
    if (body.sampleJson !== undefined) cfg.sampleJson = parseJsonLike(body.sampleJson) || {};
    cfg.requireCaptcha = Boolean(body.requireCaptcha);
    if (body.needRelogin !== undefined) cfg.needRelogin = Boolean(body.needRelogin);
    cfg.needCaptchaReverify = Boolean(body.needCaptchaReverify);
    cfg.paused = Boolean(body.paused);
    cfg.pauseReason = trimString(body.pauseReason || "");
    cfg.pauseUntil = trimString(body.pauseUntil || "");
    cfg.loginUsername = trimString(body.loginUsername || body.username || "");
    cfg.loginDisplayName = trimString(body.loginDisplayName || "");
    if (body.password !== undefined) vault.credentialCipher = body.password ? encryptSecret(String(body.password)) : "";
    if (!cfg.nextRunAt && cfg.enabled) cfg.nextRunAt = nowIso();
    cfg.updatedAt = nowIso();
    vault.deviceId = deviceId;
    vault.updatedAt = nowIso();
    safeConfig = buildSafeConfig(cfg);
    safeVault = buildSafeVault(vault);
    pushSyncLog(draft, { configId: cfg.id, deviceId, action: "config_save", status: "info", detail: { enabled: cfg.enabled, intervalMinutes: cfg.intervalMinutes } });
  });
  await logOperation({ actorId: auth.userId || auth.deviceId || "system", actorRole: auth.role || "system", action: "schedule.xique_config_save", targetType: "device", targetId: deviceId, detail: sanitizeDetail({ enabled: safeConfig.enabled, intervalMinutes: safeConfig.intervalMinutes, adapterMode: safeConfig.adapterMode, requireCaptcha: safeConfig.requireCaptcha }) });
  return { config: safeConfig, session: safeVault };
}

async function getXiqueStatus({ auth, deviceId }) {
  const db = await readDB();
  ensureDeviceAccess(db, auth, deviceId);
  const cfg = db.scheduleSyncConfigs.find((item) => item.deviceId === deviceId) || null;
  const vault = cfg ? db.xiqueSessionVault.find((item) => item.configId === cfg.id) || null : null;
  return { deviceId, config: cfg ? buildSafeConfig(cfg) : buildSafeConfig({ deviceId }), session: vault ? buildSafeVault(vault) : buildSafeVault({ deviceId }), logs: db.syncLogs.filter((item) => !cfg || item.configId === cfg.id).slice(0, 20) };
}

async function prepareXiqueLogin({ auth, deviceId, body = {}, forceCaptcha = false }) {
  const effectiveForceCaptcha = parseBoolean(body.forceCaptcha, parseBoolean(forceCaptcha, false));
  const manualCaptchaAnswer = trimString(body.captchaAnswer || body.captchaCode || "");
  const manualCaptchaSession = trimString(body.captchaSession || body.sessionId || "");
  const allowAutoOcr = parseBoolean(body.autoOcrEnabled, false);
  const db = await readDB();
  ensureDeviceAccess(db, auth, deviceId);
  const device = db.devices.find((item) => item.id === deviceId);
  if (!device) throw new HttpError(404, "device not found");
  await updateDB((draft) => {
    const cfg = getOrCreateConfigRow(draft, deviceId, device.ownerId || auth.userId || "");
    const vault = getVaultRow(draft, cfg.id);
    if (body.loginUsername !== undefined || body.username !== undefined) cfg.loginUsername = trimString(body.loginUsername || body.username || "");
    if (body.password !== undefined) vault.credentialCipher = body.password ? encryptSecret(String(body.password)) : "";
    if (body.adapterMode !== undefined) cfg.adapterMode = trimString(body.adapterMode || "mock").toLowerCase() === "remote" ? "remote" : "mock";
    if (body.sampleUrl !== undefined) cfg.sampleUrl = trimString(body.sampleUrl || "");
    if (body.sampleHtml !== undefined) cfg.sampleHtml = trimString(body.sampleHtml || "");
    if (body.sampleJson !== undefined) cfg.sampleJson = parseJsonLike(body.sampleJson) || {};
    if (body.requireCaptcha !== undefined) cfg.requireCaptcha = Boolean(body.requireCaptcha);
    if (body.currentTermKey !== undefined || body.termKey !== undefined) cfg.currentTermKey = trimString(body.currentTermKey || body.termKey || getCurrentSemesterKey());
    if (body.termStartDate !== undefined) {
      cfg.termStartDate = normalizeTermStartDate(body.termStartDate || "");
    } else if (!trimString(cfg.termStartDate || "")) {
      cfg.termStartDate = normalizeTermStartDate(config.xiqueDefaultTermStartDate || "");
    }
    cfg.updatedAt = nowIso();
    vault.deviceId = deviceId;
    vault.updatedAt = nowIso();
  });
  const current = await readDB();
  const cfg = current.scheduleSyncConfigs.find((item) => item.deviceId === deviceId);
  const vault = cfg ? current.xiqueSessionVault.find((item) => item.configId === cfg.id) : null;
  if (!cfg || !vault) throw new HttpError(404, "xique config not found");
  const client = await createXiqueClient(cfg, vault, { forceCaptcha: effectiveForceCaptcha });
  let prepared = manualCaptchaAnswer
    ? await client.completeLogin({ captchaAnswer: manualCaptchaAnswer, captchaSession: manualCaptchaSession })
    : await client.prepareLogin();

  if (!manualCaptchaAnswer && allowAutoOcr && prepared?.captchaRequired) {
    const loginResult = await resolveLoginSessionWithCaptchaStrategy({
      client,
      prepared,
      captchaAnswer: "",
      captchaSession: prepared.captchaSession || "",
      allowAutoOcr: true,
      maxOcrFailures: Number(body.maxOcrFailures || config.xiqueOcrMaxFailuresBeforeManual || 2),
      deviceId,
      configId: cfg.id,
    });
    if (loginResult.status === "success" && loginResult.session) {
      prepared = {
        loginRequired: false,
        captchaRequired: false,
        session: loginResult.session,
      };
    } else if (loginResult.status === "need_manual_captcha") {
      prepared = {
        loginRequired: true,
        captchaRequired: true,
        captchaSession: trimString(loginResult.challenge?.captchaSession || ""),
        captchaImage: trimString(loginResult.challenge?.captchaImage || ""),
        captchaExpiresAt: trimString(loginResult.challenge?.captchaExpiresAt || ""),
      };
    }
  }
  if (prepared.captchaRequired) {
    await updateDB((draft) => {
      const nextCfg = draft.scheduleSyncConfigs.find((item) => item.id === cfg.id);
      const nextVault = draft.xiqueSessionVault.find((item) => item.configId === cfg.id);
      if (!nextCfg || !nextVault) return;
      nextCfg.needRelogin = true;
      nextCfg.needCaptchaReverify = Boolean(effectiveForceCaptcha || nextCfg.needCaptchaReverify);
      nextCfg.lastError = "captcha_required";
      nextCfg.updatedAt = nowIso();
      nextVault.captchaSession = prepared.captchaSession;
      nextVault.captchaImage = prepared.captchaImage;
      nextVault.captchaExpiresAt = prepared.captchaExpiresAt;
      nextVault.needCaptchaReverify = nextCfg.needCaptchaReverify;
      nextVault.state = "captcha_required";
      nextVault.updatedAt = nowIso();
      pushSyncLog(draft, { configId: cfg.id, deviceId, action: "login_prepare", status: "warn", detail: { captchaRequired: true } });
    });
  }
  return { deviceId, configId: cfg.id, loginRequired: Boolean(prepared.loginRequired), captchaRequired: Boolean(prepared.captchaRequired), captchaSession: prepared.captchaSession || "", captchaImage: prepared.captchaImage || "", captchaExpiresAt: prepared.captchaExpiresAt || "", session: prepared.session ? buildSafeVault({ configId: cfg.id, deviceId, state: "authenticated", sessionId: prepared.session.sessionId, sessionExpiresAt: prepared.session.sessionExpiresAt, lastVerifiedAt: nowIso(), lastLoginAt: nowIso() }) : buildSafeVault(vault) };
}

async function submitXiqueImport({ auth, deviceId, body = {}, forceCaptcha = false }) {
  const db = await readDB();
  ensureDeviceAccess(db, auth, deviceId);
  const cfg = db.scheduleSyncConfigs.find((item) => item.deviceId === deviceId);
  if (!cfg) throw new HttpError(404, "xique config not found");
  const vault = db.xiqueSessionVault.find((item) => item.configId === cfg.id) || null;
  if (!vault) throw new HttpError(404, "xique vault not found");
  const effectiveCfg = { ...cfg };
  const effectiveVault = { ...vault };
  if (body.loginUsername !== undefined || body.username !== undefined) {
    effectiveCfg.loginUsername = trimString(body.loginUsername || body.username || "");
  }
  if (body.currentTermKey !== undefined || body.termKey !== undefined) {
    effectiveCfg.currentTermKey = trimString(body.currentTermKey || body.termKey || effectiveCfg.currentTermKey || getCurrentSemesterKey());
  }
  if (body.termStartDate !== undefined) {
    effectiveCfg.termStartDate = normalizeTermStartDate(body.termStartDate || "");
  } else if (!trimString(effectiveCfg.termStartDate || "")) {
    effectiveCfg.termStartDate = normalizeTermStartDate(config.xiqueDefaultTermStartDate || "");
  }
  if (body.adapterMode !== undefined) {
    effectiveCfg.adapterMode = trimString(body.adapterMode || "mock").toLowerCase() === "remote" ? "remote" : "mock";
  }
  if (body.baseUrl !== undefined) {
    effectiveCfg.baseUrl = trimString(body.baseUrl || effectiveCfg.baseUrl || "");
  }
  if (body.password !== undefined) {
    effectiveVault.credentialCipher = body.password ? encryptSecret(String(body.password)) : "";
  }

  const effectiveForceCaptcha = parseBoolean(body.forceCaptcha, parseBoolean(forceCaptcha, false));
  const allowAutoOcr = parseBoolean(body.autoOcrEnabled, true);
  const client = await createXiqueClient(effectiveCfg, effectiveVault, { forceCaptcha: effectiveForceCaptcha });
  const prepared = await client.prepareLogin();
  const loginResult = await resolveLoginSessionWithCaptchaStrategy({
    client,
    prepared,
    captchaAnswer: body.captchaAnswer || "",
    captchaSession: body.captchaSession || prepared.captchaSession || "",
    allowAutoOcr,
    maxOcrFailures: Number(body.maxOcrFailures || config.xiqueOcrMaxFailuresBeforeManual || 2),
    deviceId,
    configId: cfg.id,
  });

  if (loginResult.status === "need_manual_captcha") {
    const challenge = loginResult.challenge || {};
    const manualReason = trimString(loginResult.reason || "ocr_retry_exhausted");
    const needsRelogin = Boolean(loginResult.needRelogin || manualReason === "credential_missing");
    await updateDB((draft) => {
      const nextCfg = draft.scheduleSyncConfigs.find((item) => item.id === cfg.id);
      const nextVault = draft.xiqueSessionVault.find((item) => item.configId === cfg.id);
      if (!nextCfg || !nextVault) return;
      nextCfg.loginUsername = trimString(effectiveCfg.loginUsername || nextCfg.loginUsername || "");
      nextCfg.currentTermKey = trimString(effectiveCfg.currentTermKey || nextCfg.currentTermKey || getCurrentSemesterKey());
      nextCfg.termStartDate = normalizeTermStartDate(
        effectiveCfg.termStartDate || nextCfg.termStartDate || config.xiqueDefaultTermStartDate || ""
      );
      nextCfg.adapterMode = trimString(effectiveCfg.adapterMode || nextCfg.adapterMode || "remote").toLowerCase() === "remote" ? "remote" : "mock";
      nextCfg.baseUrl = trimString(effectiveCfg.baseUrl || nextCfg.baseUrl || "");
      nextCfg.needRelogin = true;
      nextCfg.needCaptchaReverify = true;
      nextCfg.lastAttemptAt = nowIso();
      nextCfg.lastSyncAt = nowIso();
      nextCfg.lastSyncStatus = "failed";
      nextCfg.lastSyncErrorCode = needsRelogin ? XIQUE_ERROR.CREDENTIAL_INVALID : XIQUE_ERROR.CAPTCHA_REQUIRED;
      nextCfg.lastError = manualReason || "need_manual_captcha";
      nextCfg.updatedAt = nowIso();
      if (body.password !== undefined) {
        nextVault.credentialCipher = effectiveVault.credentialCipher || "";
      }
      nextVault.captchaSession = trimString(challenge.captchaSession || "");
      nextVault.captchaImage = trimString(challenge.captchaImage || "");
      nextVault.captchaExpiresAt = trimString(challenge.captchaExpiresAt || "");
      nextVault.needCaptchaReverify = true;
      nextVault.state = "captcha_required";
      nextVault.lastSyncAt = nowIso();
      nextVault.lastSyncStatus = "failed";
      nextVault.lastSyncErrorCode = needsRelogin ? XIQUE_ERROR.CREDENTIAL_INVALID : XIQUE_ERROR.CAPTCHA_REQUIRED;
      nextVault.lastError = manualReason || "need_manual_captcha";
      nextVault.updatedAt = nowIso();
      pushSyncLog(draft, {
        configId: cfg.id,
        deviceId,
        action: "import_wait_captcha",
        status: "warn",
        detail: {
          loginStatus: loginResult.loginStatus,
          ocrAttempts: Number(loginResult.ocrAttempts || 0),
          ocrFailures: Number(loginResult.ocrFailures || 0),
          reason: manualReason,
          needRelogin: needsRelogin,
          captchaSession: trimString(challenge.captchaSession || ""),
        },
      });
    });
    const manualPayload = buildNeedManualCaptchaPayload({
      deviceId,
      configId: cfg.id,
      challenge,
      ocrFailCount: Number(loginResult.ocrFailures || 0),
      reason: manualReason,
    });
    if (needsRelogin) {
      manualPayload.needRelogin = true;
      manualPayload.message = "credentials missing, please switch to new-account login";
    }
    return manualPayload;
  }
  if (loginResult.status === "failed") {
    throw loginResult.error || makeXiqueError(XIQUE_ERROR.LOGIN_FAILED, "xique login failed", 502);
  }
  const payload = await client.fetchCourses(loginResult.session);
  let result = null;
  const nextRunAt = computeNextRunAt({ intervalMinutes: effectiveCfg.intervalMinutes || cfg.intervalMinutes, failureCount: 0 }, Date.now());
  await updateDB((draft) => {
    const nextCfg = draft.scheduleSyncConfigs.find((item) => item.id === cfg.id);
    const nextVault = draft.xiqueSessionVault.find((item) => item.configId === cfg.id);
    if (!nextCfg || !nextVault) throw new HttpError(404, "xique config not found");
    nextCfg.loginUsername = trimString(effectiveCfg.loginUsername || nextCfg.loginUsername || "");
    nextCfg.currentTermKey = trimString(effectiveCfg.currentTermKey || nextCfg.currentTermKey || getCurrentSemesterKey());
    nextCfg.termStartDate = normalizeTermStartDate(
      payload.termStartDate ||
      effectiveCfg.termStartDate ||
      nextCfg.termStartDate ||
      config.xiqueDefaultTermStartDate ||
      ""
    );
    nextCfg.currentWeek = Number.isFinite(Number(payload.currentWeek || 0)) && Number(payload.currentWeek || 0) > 0
      ? Math.floor(Number(payload.currentWeek))
      : null;
    nextCfg.currentWeekAt = nextCfg.currentWeek ? nowIso() : "";
    nextCfg.currentWeekSource = nextCfg.currentWeek ? trimString(payload.currentWeekSource || "remote_auto_detect") : "";
    nextCfg.adapterMode = trimString(effectiveCfg.adapterMode || nextCfg.adapterMode || "remote").toLowerCase() === "remote" ? "remote" : "mock";
    nextCfg.baseUrl = trimString(effectiveCfg.baseUrl || nextCfg.baseUrl || "");
    nextCfg.needRelogin = false;
    nextCfg.needCaptchaReverify = false;
    nextCfg.paused = false;
    nextCfg.pauseReason = "";
    nextCfg.failureCount = 0;
    nextCfg.lastAttemptAt = nowIso();
    nextCfg.lastSuccessAt = nowIso();
    nextCfg.lastSyncAt = nowIso();
    nextCfg.lastSyncStatus = "success";
    nextCfg.lastSyncErrorCode = "";
    nextCfg.lastError = "";
    nextCfg.nextRunAt = nextRunAt;
    nextCfg.updatedAt = nowIso();
    if (body.password !== undefined) {
      nextVault.credentialCipher = effectiveVault.credentialCipher || "";
    }
    nextVault.needCaptchaReverify = false;
    nextVault.state = "authenticated";
    nextVault.lastVerifiedAt = nowIso();
    nextVault.lastLoginAt = nowIso();
    nextVault.lastSyncAt = nowIso();
    nextVault.lastSyncStatus = "success";
    nextVault.lastSyncErrorCode = "";
    nextVault.lastError = "";
    nextVault.updatedAt = nowIso();
    result = importXiqueCoursesToDraft(draft, nextCfg, payload, { deviceId });
    pushSyncLog(draft, {
      configId: cfg.id,
      deviceId,
      action: "import_success",
      status: "success",
        detail: {
          ...result,
          loginStatus: loginResult.loginStatus,
          ocrAttempts: Number(loginResult.ocrAttempts || 0),
          ocrFailures: Number(loginResult.ocrFailures || 0),
          currentWeek: nextCfg.currentWeek,
          currentWeekSource: nextCfg.currentWeekSource,
          termStartDate: nextCfg.termStartDate,
        },
      });
  });
  await logOperation({ actorId: auth.userId || auth.deviceId || "system", actorRole: auth.role || "system", action: "schedule.xique_import", targetType: "device", targetId: deviceId, detail: sanitizeDetail(result) });
  return {
    status: "imported",
    loginStatus: loginResult.loginStatus || XIQUE_LOGIN_STATUS.SUCCESS,
    deviceId,
    configId: cfg.id,
    termKey: result.termKey,
    result,
    nextRunAt,
    ocrAttempts: Number(loginResult.ocrAttempts || 0),
    ocrFailures: Number(loginResult.ocrFailures || 0),
  };
}

async function reverifyXiqueSession({ auth, deviceId, body = {} }) { return prepareXiqueLogin({ auth, deviceId, body, forceCaptcha: true }); }
async function runXiqueSyncByConfigId(configId, { reason = "manual", captchaAnswer = "", captchaSession = "", forceCaptcha = false } = {}) {
  if (running.has(configId)) return { status: "running", reason: "locked" };
  running.add(configId);
  try {
    const db = await readDB();
    const cfg = db.scheduleSyncConfigs.find((item) => item.id === configId);
    if (!cfg) throw new HttpError(404, "xique config not found");
    const vault = db.xiqueSessionVault.find((item) => item.configId === configId) || {};
    const client = await createXiqueClient(cfg, vault, { forceCaptcha });
    const prepared = await client.prepareLogin();
    const loginResult = await resolveLoginSessionWithCaptchaStrategy({
      client,
      prepared,
      captchaAnswer,
      captchaSession: captchaSession || prepared.captchaSession || "",
      allowAutoOcr: true,
      maxOcrFailures: Number(config.xiqueOcrMaxFailuresBeforeManual || 2),
      deviceId: cfg.deviceId,
      configId,
    });
    if (loginResult.status === "need_manual_captcha") {
      const reasonCode = trimString(loginResult.reason || "ocr_retry_exhausted");
      await markNeedCaptchaReverify(configId, reasonCode);
      return {
        status: "need_manual_captcha",
        loginStatus: XIQUE_LOGIN_STATUS.NEED_MANUAL_CAPTCHA,
        deviceId: cfg.deviceId,
        configId,
        needCaptchaReverify: true,
        needRelogin: Boolean(loginResult.needRelogin || reasonCode === "credential_missing"),
        reason: reasonCode,
        ocrAttempts: Number(loginResult.ocrAttempts || 0),
        ocrFailures: Number(loginResult.ocrFailures || 0),
      };
    }
    if (loginResult.status === "failed") {
      throw loginResult.error || makeXiqueError(XIQUE_ERROR.LOGIN_FAILED, "xique login failed", 502);
    }
    const payload = await client.fetchCourses(loginResult.session);
    let result = null;
    await updateDB((draft) => {
      const nextCfg = draft.scheduleSyncConfigs.find((item) => item.id === configId);
      const nextVault = draft.xiqueSessionVault.find((item) => item.configId === configId);
      if (!nextCfg || !nextVault) throw new HttpError(404, "xique config not found");
      nextCfg.termStartDate = normalizeTermStartDate(
        payload.termStartDate ||
        nextCfg.termStartDate ||
        config.xiqueDefaultTermStartDate ||
        ""
      );
      nextCfg.currentWeek = Number.isFinite(Number(payload.currentWeek || 0)) && Number(payload.currentWeek || 0) > 0
        ? Math.floor(Number(payload.currentWeek))
        : null;
      nextCfg.currentWeekAt = nextCfg.currentWeek ? nowIso() : "";
      nextCfg.currentWeekSource = nextCfg.currentWeek ? trimString(payload.currentWeekSource || "remote_auto_detect") : "";
      nextCfg.needRelogin = false;
      nextCfg.needCaptchaReverify = false;
      nextCfg.paused = false;
      nextCfg.pauseReason = "";
      nextCfg.failureCount = 0;
      nextCfg.lastAttemptAt = nowIso();
      nextCfg.lastSuccessAt = nowIso();
      nextCfg.lastSyncAt = nowIso();
      nextCfg.lastSyncStatus = "success";
      nextCfg.lastSyncErrorCode = "";
      nextCfg.lastError = "";
    nextCfg.nextRunAt = computeNextRunAt({ intervalMinutes: nextCfg.intervalMinutes, failureCount: 0 }, Date.now());
      nextCfg.updatedAt = nowIso();
      nextVault.needCaptchaReverify = false;
      nextVault.state = "authenticated";
      nextVault.lastVerifiedAt = nowIso();
      nextVault.lastLoginAt = nowIso();
      nextVault.lastSyncAt = nowIso();
      nextVault.lastSyncStatus = "success";
      nextVault.lastSyncErrorCode = "";
      nextVault.lastError = "";
      nextVault.updatedAt = nowIso();
      result = importXiqueCoursesToDraft(draft, nextCfg, payload, { deviceId: nextCfg.deviceId });
      pushSyncLog(draft, {
        configId,
        deviceId: nextCfg.deviceId,
        action: "scheduler_success",
        status: "success",
        detail: {
          reason,
          ...result,
          loginStatus: loginResult.loginStatus,
          ocrAttempts: Number(loginResult.ocrAttempts || 0),
          ocrFailures: Number(loginResult.ocrFailures || 0),
          currentWeek: nextCfg.currentWeek,
          currentWeekSource: nextCfg.currentWeekSource,
          termStartDate: nextCfg.termStartDate,
        },
      });
    });
    await logOperation({ actorId: "system", actorRole: "system", action: "schedule.xique_scheduler_sync", targetType: "device", targetId: cfg.deviceId, detail: sanitizeDetail({ reason, ...result }) });
    return { status: "imported", deviceId: cfg.deviceId, configId, termKey: result.termKey, result };
  } catch (error) {
    const statusCode = Number(error?.status || error?.statusCode || 500);
    if (statusCode === 401 || /captcha/i.test(String(error?.message || ""))) {
      await markNeedCaptchaReverify(configId, "session_expired");
      return { status: "needCaptchaReverify", configId, error: error?.message || "session expired" };
    }
    await updateDB((draft) => {
      const nextCfg = draft.scheduleSyncConfigs.find((item) => item.id === configId);
      const nextVault = draft.xiqueSessionVault.find((item) => item.configId === configId);
      if (!nextCfg || !nextVault) return;
      nextCfg.failureCount = Number(nextCfg.failureCount || 0) + 1;
      nextCfg.lastAttemptAt = nowIso();
      nextCfg.lastSyncAt = nowIso();
      nextCfg.lastSyncStatus = "failed";
      nextCfg.lastSyncErrorCode = classifyError(error);
      nextCfg.lastError = trimString(error?.message || "sync_failed");
      const shouldBackoff = nextCfg.failureCount >= FAILURE_BACKOFF_THRESHOLD;
      const backoff = shouldBackoff
        ? Math.min(MAX_BACKOFF_MINUTES, Math.max(10, nextCfg.intervalMinutes * Math.pow(2, Math.max(0, nextCfg.failureCount - FAILURE_BACKOFF_THRESHOLD + 1))))
        : Math.max(10, nextCfg.intervalMinutes);
      nextCfg.nextRunAt = computeNextRunAt(nextCfg, Date.now()) || "";
      if (nextCfg.failureCount >= FAILURE_PAUSE_THRESHOLD) {
        nextCfg.paused = true;
        nextCfg.pauseReason = "too_many_failures";
        nextCfg.needRelogin = true;
        nextCfg.needCaptchaReverify = true;
      }
      nextCfg.updatedAt = nowIso();
      nextVault.needCaptchaReverify = nextCfg.needCaptchaReverify;
      nextVault.lastSyncAt = nowIso();
      nextVault.lastSyncStatus = "failed";
      nextVault.lastSyncErrorCode = classifyError(error);
      nextVault.lastError = trimString(error?.message || "sync_failed");
      nextVault.updatedAt = nowIso();
      pushSyncLog(draft, { configId, deviceId: nextCfg.deviceId, action: "scheduler_failed", status: "error", detail: { reason, error: trimString(error?.message || "sync_failed"), failureCount: nextCfg.failureCount, backoff } });
    });
    await logOperation({ actorId: "system", actorRole: "system", action: "schedule.xique_scheduler_failed", targetType: "device", targetId: configId, status: "failed", detail: sanitizeDetail({ reason, error: error?.message || "sync_failed" }) });
    return { status: "failed", configId, error: error?.message || "sync_failed" };
  } finally {
    running.delete(configId);
  }
}

async function runXiqueSchedulerTick(now = new Date()) {
  if (!isWithinActiveWindow(now)) return { skipped: true, reason: "quiet_hours" };
  const db = await readDB();
  const due = db.scheduleSyncConfigs.filter((row) => getSchedulerDecision(now, row).shouldRun);
  const results = [];
  for (const row of due) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runXiqueSyncByConfigId(row.id, { reason: "scheduler" }));
  }
  return { skipped: false, count: results.length, results };
}

function getXiqueSchedulerRuntime() {
  const state = global.__xiqueSchedulerStarted || null;
  if (!state) {
    return {
      started: false,
      startedAt: "",
      intervalMs: 0,
      lastTickAt: "",
      running: false,
      skippedTicks: 0,
      lastTickResult: null,
    };
  }
  return {
    started: true,
    startedAt: String(state.startedAt || ""),
    intervalMs: Number(state.intervalMs || 0),
    lastTickAt: String(state.lastTickAt || ""),
    running: Boolean(state.running),
    skippedTicks: Number(state.skippedTicks || 0),
    lastTickResult: state.lastTickResult || null,
  };
}

function startXiqueScheduler(options = {}) {
  if (global.__xiqueSchedulerStarted) return global.__xiqueSchedulerStarted;
  const requestedIntervalMs = Number(options.intervalMs || config.xiqueSchedulerIntervalMs || 60000);
  const intervalMs = Number.isFinite(requestedIntervalMs)
    ? Math.max(1000, requestedIntervalMs)
    : 60000;
  const runTick = typeof options.runTick === "function" ? options.runTick : runXiqueSchedulerTick;
  const state = {
    startedAt: nowIso(),
    intervalMs,
    timer: null,
    lastTickAt: "",
    lastTickResult: null,
    running: false,
    skippedTicks: 0,
    tick: null,
  };
  const tick = async () => {
    if (state.running) {
      state.skippedTicks += 1;
      return { skipped: true, reason: "previous_tick_running" };
    }
    state.running = true;
    state.lastTickAt = nowIso();
    try {
      state.lastTickResult = await runTick(new Date());
    } catch (error) {
      state.lastTickResult = { status: "failed", error: String(error?.message || error) };
      // eslint-disable-next-line no-console
      console.warn(`[xique-scheduler] tick failed: ${String(error?.message || error)}`);
    } finally {
      state.running = false;
    }
    return state.lastTickResult;
  };
  state.tick = tick;
  state.timer = setInterval(() => {
    tick().catch((error) => console.warn(`[xique-scheduler] tick failed: ${String(error?.message || error)}`));
  }, intervalMs);
  if (typeof state.timer.unref === "function") state.timer.unref();
  global.__xiqueSchedulerStarted = state;
  if (options.runImmediately !== false) {
    tick().catch((error) => console.warn(`[xique-scheduler] initial tick failed: ${String(error?.message || error)}`));
  }
  return state;
}

function stopXiqueScheduler() {
  const state = global.__xiqueSchedulerStarted;
  if (state?.timer) clearInterval(state.timer);
  if (state) {
    state.timer = null;
    state.running = false;
  }
  delete global.__xiqueSchedulerStarted;
}

module.exports = {
  ACTIVE_START_HOUR,
  ACTIVE_END_HOUR,
  WEEKDAY_LABEL_MAP,
  encryptSecret,
  decryptSecret,
  normalizeIntervalMinutes,
  normalizeWeeksArray,
  parseWeeksExpression,
  normalizeTermStartDate,
  extractCurrentWeekFromText,
  resolveTeachingWeekContext,
  computeCurrentWeek,
  isCourseActiveInWeek,
  parseScheduleSlots,
  getCurrentSemesterKey,
  isWithinActiveWindow,
  getSchedulerDecision,
  buildSafeConfig,
  buildSafeVault,
  loadSamplePayload,
  createXiqueClient,
  importXiqueCoursesToDraft,
  saveXiqueSyncConfig,
  getXiqueStatus,
  prepareXiqueLogin,
  submitXiqueImport,
  reverifyXiqueSession,
  runXiqueSyncByConfigId,
  runXiqueSchedulerTick,
  startXiqueScheduler,
  stopXiqueScheduler,
  getXiqueSchedulerRuntime,
  markNeedCaptchaReverify,
  sanitizeDetail,
};



