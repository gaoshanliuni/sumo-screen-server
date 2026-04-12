const config = require("../config");

const ALLOWED_INTERVALS = new Set([10, 30, 60, 120, 360]);
const DEFAULT_DAILY_START_TIME = "07:30";
const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_INTERVAL_ENABLED = true;
const DEFAULT_INTERVAL_WINDOW_END_TIME = "23:59";
const MAX_FIXED_TIMES = 24;

function parseTimeParts(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function normalizeDailyStartTime(value) {
  const parsed = parseTimeParts(value);
  if (!parsed) return DEFAULT_DAILY_START_TIME;
  return `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
}

function normalizeDailyEndTime(value) {
  const parsed = parseTimeParts(value);
  if (!parsed) return DEFAULT_INTERVAL_WINDOW_END_TIME;
  return `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
}

function normalizeIntervalMinutes(value) {
  const n = Math.floor(Number(value || DEFAULT_INTERVAL_MINUTES));
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MINUTES;
  return ALLOWED_INTERVALS.has(n) ? n : DEFAULT_INTERVAL_MINUTES;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return Boolean(fallback);
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return Boolean(fallback);
}

function timeStringToMinutes(value) {
  const parsed = parseTimeParts(value);
  if (!parsed) return null;
  return parsed.hour * 60 + parsed.minute;
}

function minutesToTimeString(totalMinutes) {
  const safe = Math.max(0, Math.min(1439, Number(totalMinutes || 0)));
  const hour = Math.floor(safe / 60);
  const minute = safe % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeFixedTimes(input) {
  const rawList = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input
          .split(/[,\n;\s]+/)
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      : [];
  const minuteSet = new Set();
  rawList.forEach((item) => {
    const minutes = timeStringToMinutes(item);
    if (minutes === null) return;
    minuteSet.add(minutes);
  });
  return [...minuteSet]
    .sort((a, b) => a - b)
    .slice(0, MAX_FIXED_TIMES)
    .map((minutes) => minutesToTimeString(minutes));
}

function buildDailyMinuteCandidates(autoConfig = {}) {
  const candidates = new Set();

  const fixedTimes = normalizeFixedTimes(autoConfig.fixed_times || autoConfig.fixedTimes || []);
  fixedTimes.forEach((timeText) => {
    const minutes = timeStringToMinutes(timeText);
    if (minutes === null) return;
    candidates.add(minutes);
  });

  const intervalEnabled = normalizeBoolean(
    autoConfig.interval_enabled ?? autoConfig.intervalEnabled,
    DEFAULT_INTERVAL_ENABLED
  );
  if (intervalEnabled) {
    const startTime = normalizeDailyStartTime(
      autoConfig.window_start_time || autoConfig.windowStartTime || autoConfig.daily_start_time || autoConfig.dailyStartTime
    );
    const endTime = normalizeDailyEndTime(
      autoConfig.window_end_time || autoConfig.windowEndTime || autoConfig.daily_end_time || autoConfig.dailyEndTime
    );
    const intervalMinutes = normalizeIntervalMinutes(autoConfig.interval_minutes || autoConfig.intervalMinutes || DEFAULT_INTERVAL_MINUTES);
    const startMin = timeStringToMinutes(startTime);
    const endMin = timeStringToMinutes(endTime);
    if (startMin !== null && endMin !== null) {
      const safeEnd = endMin >= startMin ? endMin : startMin;
      for (let minute = startMin; minute <= safeEnd; minute += intervalMinutes) {
        candidates.add(minute);
      }
    }
  }

  return [...candidates].sort((a, b) => a - b);
}

function toDateOrNull(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts);
}

function safeString(value) {
  return String(value || "").trim();
}

function getTzParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out = {};
  formatter.formatToParts(date).forEach((part) => {
    if (part.type !== "literal") out[part.type] = part.value;
  });
  return {
    year: Number(out.year || 1970),
    month: Number(out.month || 1),
    day: Number(out.day || 1),
    hour: Number(out.hour || 0),
    minute: Number(out.minute || 0),
    second: Number(out.second || 0),
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getTzParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedDateToUtc({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

function addDaysToYmd(year, month, day, days) {
  const dt = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

function computeNextAutoRenderRunAt(input = {}, now = new Date(), timeZone = config.timezone || "Asia/Shanghai") {
  const enabled = normalizeBoolean(input.enabled, false);
  if (!enabled) return "";
  const nowDate = now instanceof Date ? now : new Date(now || Date.now());
  const nowTs = nowDate.getTime();
  const minuteCandidates = buildDailyMinuteCandidates(input);
  if (!minuteCandidates.length) return "";

  const nowParts = getTzParts(nowDate, timeZone);
  for (let offset = 0; offset <= 2; offset += 1) {
    const dayYmd = addDaysToYmd(nowParts.year, nowParts.month, nowParts.day, offset);
    for (const minuteOfDay of minuteCandidates) {
      const hour = Math.floor(minuteOfDay / 60);
      const minute = minuteOfDay % 60;
      const candidate = zonedDateToUtc(
        { year: dayYmd.year, month: dayYmd.month, day: dayYmd.day, hour, minute, second: 0 },
        timeZone
      );
      if (candidate.getTime() > nowTs) {
        return candidate.toISOString();
      }
    }
  }
  return "";
}

function normalizeAutoRenderPushConfig(input = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const timeZone = String(options.timeZone || config.timezone || "Asia/Shanghai");
  const recomputeNext = normalizeBoolean(options.recomputeNext, false);

  const safe = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const enabled = normalizeBoolean(safe.enabled, false);
  const intervalEnabled = normalizeBoolean(
    safe.interval_enabled ?? safe.intervalEnabled,
    DEFAULT_INTERVAL_ENABLED
  );
  const dailyStartTime = normalizeDailyStartTime(
    safe.window_start_time || safe.windowStartTime || safe.daily_start_time || safe.dailyStartTime || DEFAULT_DAILY_START_TIME
  );
  const dailyEndTime = normalizeDailyEndTime(
    safe.window_end_time || safe.windowEndTime || safe.daily_end_time || safe.dailyEndTime || DEFAULT_INTERVAL_WINDOW_END_TIME
  );
  const intervalMinutes = normalizeIntervalMinutes(safe.interval_minutes || safe.intervalMinutes || DEFAULT_INTERVAL_MINUTES);
  const fixedTimes = normalizeFixedTimes(safe.fixed_times || safe.fixedTimes || []);

  const normalized = {
    enabled,
    interval_enabled: intervalEnabled,
    window_start_time: dailyStartTime,
    window_end_time: dailyEndTime,
    fixed_times: fixedTimes,
    // legacy aliases kept for compatibility
    daily_start_time: dailyStartTime,
    interval_minutes: intervalMinutes,
    next_run_at: safeString(safe.next_run_at || safe.nextRunAt),
    last_run_at: safeString(safe.last_run_at || safe.lastRunAt),
    last_result: safeString(safe.last_result || safe.lastResult || "idle"),
    last_error: safeString(safe.last_error || safe.lastError),
    last_reason: safeString(safe.last_reason || safe.lastReason),
  };

  const resultSet = new Set(["idle", "success", "failed", "running", "skipped"]);
  if (!resultSet.has(normalized.last_result)) {
    normalized.last_result = "idle";
  }

  if (!enabled) {
    normalized.next_run_at = "";
    return normalized;
  }

  const nextDate = toDateOrNull(normalized.next_run_at);
  if (recomputeNext || !nextDate) {
    normalized.next_run_at = computeNextAutoRenderRunAt(normalized, now, timeZone);
    return normalized;
  }
  return normalized;
}

module.exports = {
  ALLOWED_INTERVALS,
  DEFAULT_DAILY_START_TIME,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_INTERVAL_ENABLED,
  DEFAULT_INTERVAL_WINDOW_END_TIME,
  normalizeDailyStartTime,
  normalizeDailyEndTime,
  normalizeIntervalMinutes,
  normalizeFixedTimes,
  buildDailyMinuteCandidates,
  normalizeAutoRenderPushConfig,
  computeNextAutoRenderRunAt,
};
