const config = require("../config");

const REFRESH_MODES = new Set(["manual", "interval", "on_request", "stale_while_revalidate"]);
const MANUAL_EXCEPTION_SLUGS = new Set(["xique_schedule"]);

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (Number.isFinite(min) && v < min) return min;
  if (Number.isFinite(max) && v > max) return max;
  return v;
}

function toBool(value, fallback = true) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  return Boolean(value);
}

function defaultModeForSlug(slug = "") {
  const normalizedSlug = String(slug || "").trim();
  if (MANUAL_EXCEPTION_SLUGS.has(normalizedSlug)) return "manual";
  const fromConfig = String(config.defaultApiTemplateRefreshMode || "interval").trim().toLowerCase();
  return REFRESH_MODES.has(fromConfig) ? fromConfig : "interval";
}

function getDefaultTemplateRefreshConfig(options = {}) {
  const slug = String(options.slug || "").trim();
  return {
    mode: defaultModeForSlug(slug),
    enabled: true,
    intervalMinutes: clampInt(
      config.defaultApiTemplateRefreshIntervalMinutes,
      10,
      1,
      24 * 60
    ),
    ttlSeconds: clampInt(config.defaultApiTemplateCacheTtlSeconds, 300, 30, 24 * 60 * 60),
    minRequestGapSeconds: clampInt(
      config.defaultApiTemplateMinRequestGapSeconds,
      30,
      0,
      24 * 60 * 60
    ),
    timeoutMs: clampInt(config.defaultApiTemplateRefreshTimeoutMs, 8000, 500, 120000),
    fallbackToStale: toBool(config.defaultApiTemplateFallbackToStale, true),
    jitterSeconds: clampInt(config.defaultApiTemplateRefreshJitterSeconds, 15, 0, 3600),
  };
}

function normalizeTemplateRefreshConfig(input, options = {}) {
  const defaults = getDefaultTemplateRefreshConfig(options);
  const safeInput =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const rawMode = String(safeInput.mode || defaults.mode || "interval")
    .trim()
    .toLowerCase();
  const mode = REFRESH_MODES.has(rawMode) ? rawMode : defaults.mode;

  return {
    mode,
    enabled: toBool(safeInput.enabled, defaults.enabled),
    intervalMinutes: clampInt(
      safeInput.intervalMinutes,
      defaults.intervalMinutes,
      1,
      24 * 60
    ),
    ttlSeconds: clampInt(safeInput.ttlSeconds, defaults.ttlSeconds, 30, 24 * 60 * 60),
    minRequestGapSeconds: clampInt(
      safeInput.minRequestGapSeconds,
      defaults.minRequestGapSeconds,
      0,
      24 * 60 * 60
    ),
    timeoutMs: clampInt(safeInput.timeoutMs, defaults.timeoutMs, 500, 120000),
    fallbackToStale: toBool(safeInput.fallbackToStale, defaults.fallbackToStale),
    jitterSeconds: clampInt(
      safeInput.jitterSeconds,
      defaults.jitterSeconds,
      0,
      3600
    ),
  };
}

module.exports = {
  REFRESH_MODES,
  MANUAL_EXCEPTION_SLUGS,
  getDefaultTemplateRefreshConfig,
  normalizeTemplateRefreshConfig,
};
