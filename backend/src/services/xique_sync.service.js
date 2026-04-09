const crypto = require("crypto");
const { createCanvas } = require("@napi-rs/canvas");
const axios = require("axios");
const config = require("../config");
const createId = require("../utils/id");
const HttpError = require("../utils/httpError");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess } = require("../utils/access");
const { logOperation } = require("../utils/logging");

const ALLOWED_INTERVALS = new Set([10, 30, 60]);
const ACTIVE_START_HOUR = 6;
const ACTIVE_END_HOUR = 24;
const MAX_BACKOFF_MINUTES = Number(config.xiqueMaxBackoffMinutes || 120);
const FAILURE_BACKOFF_THRESHOLD = Number(config.xiqueFailureBackoffThreshold || 3);
const FAILURE_PAUSE_THRESHOLD = Number(config.xiqueFailurePauseThreshold || 5);
const SYNC_LOG_LIMIT = 2000;
const running = new Set();
const LOCKS = new Map();

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

const AUTH_ERROR_CODES = new Set([
  XIQUE_ERROR.LOGIN_FAILED,
  XIQUE_ERROR.CREDENTIAL_INVALID,
  XIQUE_ERROR.CAPTCHA_REQUIRED,
  XIQUE_ERROR.CAPTCHA_INVALID,
  XIQUE_ERROR.SESSION_EXPIRED,
]);

function nowIso() { return new Date().toISOString(); }
function trimString(v) { return String(v ?? "").trim(); }
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
    if (Array.isArray(json)) return { termKey: fallbackTermKey, courses: json };
    if (Array.isArray(json.courses)) return { termKey: trimString(json.termKey || fallbackTermKey), courses: json.courses };
    if (Array.isArray(json.data)) return { termKey: trimString(json.termKey || fallbackTermKey), courses: json.data };
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
    courses: [
      { courseId: "sample-1", courseName: "数学", teacherName: "示例老师", location: "A101", weekday, startPeriod: 1, endPeriod: 2, weeks: [1, 2, 3, 4, 5] },
      { courseId: "sample-2", courseName: "英语", teacherName: "示例老师", location: "B201", weekday: weekday === 7 ? 1 : weekday + 1, startPeriod: 3, endPeriod: 4, weeks: [1, 2, 3, 4, 5] },
    ],
  };
}
function normalizeIncomingCourse(item = {}, index = 0, termKey = "") {
  const title = trimString(item.courseName || item.title || item.name || item.course);
  if (!title) return null;
  const weekday = Math.max(1, Math.min(7, Number(item.weekday || item.day || item.week || item.weekDay || 1)));
  const startPeriod = Math.max(1, Number(item.startPeriod || item.periodStart || item.orderIndex || 1));
  const endPeriod = Math.max(startPeriod, Number(item.endPeriod || item.periodEnd || startPeriod));
  const courseId = trimString(item.courseId || item.id || item.code || `course_${index + 1}`);
  const sourceKey = trimString(item.sourceKey || `${courseId}:${weekday}:${startPeriod}-${endPeriod}:${trimString(item.location || item.classroom || "")}`);
  const teacherName = trimString(item.teacherName || item.teacher || "");
  const location = trimString(item.location || item.classroom || item.room || "");
  const note = trimString(item.note || item.remark || "");
  const content = [teacherName ? `教师:${teacherName}` : "", location ? `地点:${location}` : "", note].filter(Boolean).join("，");
  return { courseId, sourceKey, termKey: trimString(termKey || item.termKey || item.semesterKey || getCurrentSemesterKey()), title, content, weekday, startPeriod, endPeriod, teacherName, location, weeks: Array.isArray(item.weeks) ? item.weeks : [], sourceMeta: sanitizeDetail({ teacherName, location }) };
}
function normalizeScheduleRowForImport(item, defaults = {}) {
  const row = normalizeIncomingCourse(item, defaults.index || 0, defaults.termKey || "");
  if (!row) return null;
  const now = nowIso();
  return { id: createId("sch"), deviceId: trimString(defaults.deviceId || ""), mode: "course", weekday: row.weekday, orderIndex: row.startPeriod, title: row.title, content: row.content, startTime: trimString(item.startTime || ""), endTime: trimString(item.endTime || ""), courseName: row.title, note: row.content, source: "xique", sourceKey: row.sourceKey, termKey: row.termKey, xiqueCourseId: row.courseId, xiqueClassKey: row.sourceKey, sourceMeta: row.sourceMeta, createdAt: now, updatedAt: now };
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
    row = { id: createId("xsync"), deviceId, ownerId, source: "xique", enabled: false, intervalMinutes: 60, currentTermKey: getCurrentSemesterKey(), adapterMode: "mock", baseUrl: "", sampleUrl: "", sampleHtml: "", sampleJson: {}, requireCaptcha: false, needRelogin: false, needCaptchaReverify: false, paused: false, pauseReason: "", pauseUntil: "", failureCount: 0, lastAttemptAt: "", lastSuccessAt: "", lastSyncAt: "", lastSyncStatus: "", lastSyncErrorCode: "", lastError: "", nextRunAt: "", loginUsername: "", loginDisplayName: "", createdAt: nowIso(), updatedAt: nowIso() };
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
  return { id: trimString(row.id || ""), deviceId: trimString(row.deviceId || ""), ownerId: trimString(row.ownerId || ""), source: "xique", enabled: Boolean(row.enabled), intervalMinutes: normalizeIntervalMinutes(row.intervalMinutes), currentTermKey: trimString(row.currentTermKey || row.termKey || getCurrentSemesterKey()), adapterMode: trimString(row.adapterMode || "mock"), baseUrl: trimString(row.baseUrl || ""), sampleUrl: trimString(row.sampleUrl || ""), sampleHtml: trimString(row.sampleHtml || ""), requireCaptcha: Boolean(row.requireCaptcha), needRelogin: Boolean(row.needRelogin), needCaptchaReverify: Boolean(row.needCaptchaReverify), paused: Boolean(row.paused), pauseReason: trimString(row.pauseReason || ""), pauseUntil: trimString(row.pauseUntil || ""), failureCount: Number(row.failureCount || 0), lastAttemptAt: trimString(row.lastAttemptAt || ""), lastSuccessAt: trimString(row.lastSuccessAt || ""), lastSyncAt: trimString(row.lastSyncAt || row.lastSuccessAt || ""), lastSyncStatus: trimString(row.lastSyncStatus || ""), lastSyncErrorCode: trimString(row.lastSyncErrorCode || ""), lastError: trimString(row.lastError || ""), nextRunAt: trimString(row.nextRunAt || ""), loginUsername: trimString(row.loginUsername || ""), loginDisplayName: trimString(row.loginDisplayName || ""), createdAt: trimString(row.createdAt || ""), updatedAt: trimString(row.updatedAt || "") };
}

function buildSafeVault(row = {}) {
  return { id: trimString(row.id || ""), configId: trimString(row.configId || ""), deviceId: trimString(row.deviceId || ""), state: trimString(row.state || "idle"), sessionId: trimString(row.sessionId || ""), sessionExpiresAt: trimString(row.sessionExpiresAt || ""), captchaSession: trimString(row.captchaSession || ""), captchaImage: trimString(row.captchaImage || ""), captchaExpiresAt: trimString(row.captchaExpiresAt || ""), needCaptchaReverify: Boolean(row.needCaptchaReverify), lastVerifiedAt: trimString(row.lastVerifiedAt || ""), lastLoginAt: trimString(row.lastLoginAt || ""), lastSyncAt: trimString(row.lastSyncAt || ""), lastSyncStatus: trimString(row.lastSyncStatus || ""), lastSyncErrorCode: trimString(row.lastSyncErrorCode || ""), lastError: trimString(row.lastError || ""), hasCredential: Boolean(row.credentialCipher), hasSession: Boolean(row.sessionId) };
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
  const requireCaptcha = Boolean(configRow.requireCaptcha || options.forceCaptcha);
  const issueSession = () => {
    const sessionId = createId("xsess");
    const sessionExpiresAt = new Date(Date.now() + Number(config.xiqueSessionTtlMs || 6 * 60 * 60 * 1000)).toISOString();
    const authToken = `xique_token_${createId("tok")}`;
    const authCookie = `xique_cookie_${createId("ck")}`;
    vaultRow.state = "authenticated";
    vaultRow.sessionId = sessionId;
    vaultRow.sessionExpiresAt = sessionExpiresAt;
    vaultRow.authTokenCipher = encryptSecret(authToken);
    vaultRow.authCookieCipher = encryptSecret(authCookie);
    vaultRow.captchaSession = "";
    vaultRow.captchaImage = "";
    vaultRow.captchaAnswerHash = "";
    vaultRow.captchaExpiresAt = "";
    vaultRow.needCaptchaReverify = false;
    vaultRow.lastVerifiedAt = nowIso();
    vaultRow.lastLoginAt = nowIso();
    return { sessionId, sessionExpiresAt, authToken, authCookie };
  };
  const validSession = () => vaultRow.sessionId && vaultRow.sessionExpiresAt && Date.parse(vaultRow.sessionExpiresAt) > Date.now()
    ? { sessionId: vaultRow.sessionId, sessionExpiresAt: vaultRow.sessionExpiresAt, authToken: vaultRow.authTokenCipher ? decryptSecret(vaultRow.authTokenCipher) : "", authCookie: vaultRow.authCookieCipher ? decryptSecret(vaultRow.authCookieCipher) : "" }
    : null;
  const currentChallenge = () => vaultRow.captchaSession && vaultRow.captchaImage && vaultRow.captchaExpiresAt && Date.parse(vaultRow.captchaExpiresAt) > Date.now()
    ? { captchaRequired: true, captchaSession: vaultRow.captchaSession, captchaImage: vaultRow.captchaImage, captchaExpiresAt: vaultRow.captchaExpiresAt }
    : null;
  return {
    async prepareLogin() {
      const session = validSession();
      if (session && !options.forceCaptcha && !vaultRow.needCaptchaReverify) return { loginRequired: false, captchaRequired: false, session };
      if (requireCaptcha || vaultRow.needCaptchaReverify || options.forceCaptcha) return currentChallenge() || createCaptchaChallenge(configRow, vaultRow);
      return { loginRequired: false, captchaRequired: false, session: issueSession() };
    },
    async completeLogin({ captchaAnswer = "", captchaSession = "" } = {}) {
      if (validSession() && !options.forceCaptcha && !vaultRow.needCaptchaReverify) return { loginRequired: false, captchaRequired: false, session: validSession() };
      if (!requireCaptcha && !vaultRow.needCaptchaReverify && !options.forceCaptcha) {
        return { loginRequired: false, captchaRequired: false, session: issueSession() };
      }
      const challenge = currentChallenge() || createCaptchaChallenge(configRow, vaultRow);
      if (captchaSession && vaultRow.captchaSession && captchaSession !== vaultRow.captchaSession) throw new HttpError(400, "captcha session mismatch");
      if (!captchaAnswer) return challenge;
      if (sha(captchaAnswer) !== vaultRow.captchaAnswerHash) throw new HttpError(400, "captcha invalid");
      return { loginRequired: false, captchaRequired: false, session: issueSession() };
    },
    async fetchCourses() {
      if (!validSession()) throw new HttpError(401, "xique session expired");
      const payload = await loadSamplePayload(configRow); // TODO: replace with real adapter when school API is available.
      return { termKey: trimString(payload.termKey || configRow.currentTermKey || getCurrentSemesterKey()), courses: Array.isArray(payload.courses) ? payload.courses : [], sourceMeta: { adapterMode: trimString(configRow.adapterMode || "mock") } };
    },
  };
}

function importXiqueCoursesToDraft(draft, configRow, payload, options = {}) {
  ensureCollections(draft);
  const deviceId = trimString(configRow.deviceId || options.deviceId || "");
  const termKey = trimString(payload.termKey || configRow.currentTermKey || getCurrentSemesterKey());
  const existing = draft.schedules.filter((item) => item.deviceId === deviceId && item.source === "xique" && item.termKey === termKey);
  const existingMap = new Map(existing.map((row) => [row.sourceKey, row]));
  const keep = new Set();
  const result = { added: 0, updated: 0, skipped: 0, overwritten: 0, imported: 0, totalIncoming: 0, termKey };
  (payload.courses || []).forEach((item, index) => {
    const row = normalizeScheduleRowForImport(item, { index, termKey, deviceId });
    if (!row) { result.skipped += 1; return; }
    result.totalIncoming += 1;
    keep.add(row.sourceKey);
    const current = existingMap.get(row.sourceKey);
    if (!current) { draft.schedules.unshift(row); result.added += 1; return; }
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
      sourceMeta: row.sourceMeta,
    });
    if (before === nextComparable) { result.skipped += 1; return; }
    Object.assign(current, row, { id: current.id, createdAt: current.createdAt, updatedAt: nowIso() });
    result.updated += 1;
  });
  existing.forEach((row) => {
    if (!keep.has(row.sourceKey)) {
      const idx = draft.schedules.findIndex((item) => item.id === row.id);
      if (idx >= 0) { draft.schedules.splice(idx, 1); result.overwritten += 1; }
    }
  });
  result.imported = result.added + result.updated;
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
    cfg.adapterMode = trimString(body.adapterMode || "mock").toLowerCase() === "remote" ? "remote" : "mock";
    cfg.baseUrl = trimString(body.baseUrl || "");
    cfg.sampleUrl = trimString(body.sampleUrl || "");
    cfg.sampleHtml = trimString(body.sampleHtml || "");
    cfg.sampleJson = parseJsonLike(body.sampleJson) || {};
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
    cfg.updatedAt = nowIso();
    vault.deviceId = deviceId;
    vault.updatedAt = nowIso();
  });
  const current = await readDB();
  const cfg = current.scheduleSyncConfigs.find((item) => item.deviceId === deviceId);
  const vault = cfg ? current.xiqueSessionVault.find((item) => item.configId === cfg.id) : null;
  if (!cfg || !vault) throw new HttpError(404, "xique config not found");
  const client = await createXiqueClient(cfg, vault, { forceCaptcha });
  const prepared = await client.prepareLogin();
  if (prepared.captchaRequired) {
    await updateDB((draft) => {
      const nextCfg = draft.scheduleSyncConfigs.find((item) => item.id === cfg.id);
      const nextVault = draft.xiqueSessionVault.find((item) => item.configId === cfg.id);
      if (!nextCfg || !nextVault) return;
      nextCfg.needRelogin = true;
      nextCfg.needCaptchaReverify = Boolean(forceCaptcha || nextCfg.needCaptchaReverify);
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
  const client = await createXiqueClient(cfg, vault, { forceCaptcha: forceCaptcha || Boolean(body.forceCaptcha) });
  const prepared = await client.prepareLogin();
  if (prepared.captchaRequired && !body.captchaAnswer) {
    await updateDB((draft) => {
      const nextCfg = draft.scheduleSyncConfigs.find((item) => item.id === cfg.id);
      const nextVault = draft.xiqueSessionVault.find((item) => item.configId === cfg.id);
      if (!nextCfg || !nextVault) return;
      nextCfg.needRelogin = true;
      nextCfg.needCaptchaReverify = true;
      nextCfg.lastError = "captcha_required";
      nextCfg.updatedAt = nowIso();
      nextVault.captchaSession = prepared.captchaSession;
      nextVault.captchaImage = prepared.captchaImage;
      nextVault.captchaExpiresAt = prepared.captchaExpiresAt;
      nextVault.needCaptchaReverify = true;
      nextVault.state = "captcha_required";
      nextVault.updatedAt = nowIso();
      pushSyncLog(draft, { configId: cfg.id, deviceId, action: "import_wait_captcha", status: "warn", detail: {} });
    });
    return { status: "captcha_required", deviceId, configId: cfg.id, captchaSession: prepared.captchaSession, captchaImage: prepared.captchaImage, captchaExpiresAt: prepared.captchaExpiresAt, needCaptchaReverify: true };
  }
  const loginResult = prepared.session && !prepared.captchaRequired ? { session: prepared.session } : await client.completeLogin({ captchaAnswer: body.captchaAnswer || "", captchaSession: body.captchaSession || prepared.captchaSession || "" });
  if (loginResult.captchaRequired) return { status: "captcha_required", deviceId, configId: cfg.id, captchaSession: loginResult.captchaSession, captchaImage: loginResult.captchaImage, captchaExpiresAt: loginResult.captchaExpiresAt, needCaptchaReverify: true };
  const payload = await client.fetchCourses(loginResult.session);
  let result = null;
  const nextRunAt = computeNextRunAt({ intervalMinutes: cfg.intervalMinutes, failureCount: 0 }, Date.now());
  await updateDB((draft) => {
    const nextCfg = draft.scheduleSyncConfigs.find((item) => item.id === cfg.id);
    const nextVault = draft.xiqueSessionVault.find((item) => item.configId === cfg.id);
    if (!nextCfg || !nextVault) throw new HttpError(404, "xique config not found");
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
    pushSyncLog(draft, { configId: cfg.id, deviceId, action: "import_success", status: "success", detail: result });
  });
  await logOperation({ actorId: auth.userId || auth.deviceId || "system", actorRole: auth.role || "system", action: "schedule.xique_import", targetType: "device", targetId: deviceId, detail: sanitizeDetail(result) });
  return { status: "imported", deviceId, configId: cfg.id, termKey: result.termKey, result, nextRunAt };
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
    if (prepared.captchaRequired && !captchaAnswer) {
      await markNeedCaptchaReverify(configId, "captcha_required");
      return { status: "captcha_required", deviceId: cfg.deviceId, configId, captchaSession: prepared.captchaSession, captchaImage: prepared.captchaImage, captchaExpiresAt: prepared.captchaExpiresAt, needCaptchaReverify: true };
    }
    const loginResult = prepared.session && !prepared.captchaRequired ? prepared : await client.completeLogin({ captchaAnswer, captchaSession: captchaSession || prepared.captchaSession || "" });
    if (loginResult.captchaRequired) {
      await markNeedCaptchaReverify(configId, "captcha_required");
      return { status: "captcha_required", deviceId: cfg.deviceId, configId, captchaSession: loginResult.captchaSession, captchaImage: loginResult.captchaImage, captchaExpiresAt: loginResult.captchaExpiresAt, needCaptchaReverify: true };
    }
    const payload = await client.fetchCourses(loginResult.session);
    let result = null;
    await updateDB((draft) => {
      const nextCfg = draft.scheduleSyncConfigs.find((item) => item.id === configId);
      const nextVault = draft.xiqueSessionVault.find((item) => item.configId === configId);
      if (!nextCfg || !nextVault) throw new HttpError(404, "xique config not found");
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
      pushSyncLog(draft, { configId, deviceId: nextCfg.deviceId, action: "scheduler_success", status: "success", detail: { reason, ...result } });
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

function startXiqueScheduler() {
  if (global.__xiqueSchedulerStarted) return global.__xiqueSchedulerStarted;
  const state = { startedAt: nowIso(), timer: null, lastTickAt: "", lastTickResult: null };
  const tick = async () => {
    state.lastTickAt = nowIso();
    state.lastTickResult = await runXiqueSchedulerTick(new Date());
  };
  tick().catch((error) => console.warn(`[xique-scheduler] initial tick failed: ${String(error?.message || error)}`));
  state.timer = setInterval(() => {
    tick().catch((error) => console.warn(`[xique-scheduler] tick failed: ${String(error?.message || error)}`));
  }, Number(config.xiqueSchedulerIntervalMs || 60000));
  if (typeof state.timer.unref === "function") state.timer.unref();
  global.__xiqueSchedulerStarted = state;
  return state;
}

function stopXiqueScheduler() {
  const state = global.__xiqueSchedulerStarted;
  if (state?.timer) clearInterval(state.timer);
  delete global.__xiqueSchedulerStarted;
}

module.exports = {
  ACTIVE_START_HOUR,
  ACTIVE_END_HOUR,
  encryptSecret,
  decryptSecret,
  normalizeIntervalMinutes,
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
  markNeedCaptchaReverify,
  sanitizeDetail,
};

