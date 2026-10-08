const config = require("../config");
const { readDB, patchDeviceThirdApiCache } = require("../db/store");
const { ensureDeviceAccess } = require("../utils/access");
const homepageService = require("./homepage_page.service");
const badgepageService = require("./badgepage.service");
const weatherpageService = require("./weatherpage.service");
const {
  normalizeTemplateRefreshConfig,
  getDefaultTemplateRefreshConfig,
} = require("./api_template_refresh_config.service");

const inFlightMap = new Map();
let templateExecutor = null;

function registerTemplateExecutor(fn) {
  templateExecutor = typeof fn === "function" ? fn : null;
}

function nowIso() {
  return new Date().toISOString();
}

function toTimestamp(value) {
  const ts = Date.parse(String(value || ""));
  return Number.isFinite(ts) ? ts : null;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (Number.isFinite(min) && v < min) return min;
  if (Number.isFinite(max) && v > max) return max;
  return v;
}

function stableHash(input = "") {
  let hash = 0;
  const text = String(input || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

function computeJitterSeconds(deviceId, slug, refreshConfig = {}) {
  const maxJitter = clampInt(
    refreshConfig.jitterSeconds,
    Number(config.defaultApiTemplateRefreshJitterSeconds || 15),
    0,
    3600
  );
  if (maxJitter <= 0) return 0;
  const h = stableHash(`${String(deviceId || "")}::${String(slug || "")}`);
  return h % (maxJitter + 1);
}

function computeExpireAt(updatedAtIso, refreshConfig = {}) {
  const ttlSeconds = clampInt(
    refreshConfig.ttlSeconds,
    Number(config.defaultApiTemplateCacheTtlSeconds || 300),
    30,
    24 * 60 * 60
  );
  const updatedTs = toTimestamp(updatedAtIso) || Date.now();
  return new Date(updatedTs + ttlSeconds * 1000).toISOString();
}

function computeNextRefreshAt(updatedAtIso, refreshConfig = {}, deviceId = "", slug = "") {
  const mode = String(refreshConfig.mode || "interval");
  if (mode !== "interval") return "";
  const intervalMinutes = clampInt(refreshConfig.intervalMinutes, 10, 1, 24 * 60);
  const baseTs = toTimestamp(updatedAtIso) || Date.now();
  const jitter = computeJitterSeconds(deviceId, slug, refreshConfig);
  return new Date(baseTs + intervalMinutes * 60 * 1000 + jitter * 1000).toISOString();
}

function normalizeCacheEntry(cacheEntry, template = {}, deviceId = "") {
  const refreshConfig = normalizeTemplateRefreshConfig(template.refreshConfig, {
    slug: template.slug,
  });
  const safe =
    cacheEntry && typeof cacheEntry === "object" && !Array.isArray(cacheEntry)
      ? cacheEntry
      : {};
  const updatedAt = String(safe.updatedAt || safe.updated_at || "");
  const normalizedUpdatedAt = updatedAt || nowIso();
  const expireAt = String(safe.expireAt || safe.expire_at || computeExpireAt(normalizedUpdatedAt, refreshConfig));
  const normalized = {
    template:
      safe.template && typeof safe.template === "object" && !Array.isArray(safe.template)
        ? safe.template
        : {
            slug: String(template.slug || ""),
            name: String(template.name || template.slug || ""),
          },
    formatted:
      safe.formatted !== undefined
        ? safe.formatted
        : safe.raw && typeof safe.raw === "object" && !Array.isArray(safe.raw)
          ? safe.raw.output
          : null,
    raw:
      safe.raw && typeof safe.raw === "object" && !Array.isArray(safe.raw)
        ? safe.raw
        : { output: safe.formatted !== undefined ? safe.formatted : null, vars: {}, steps: [] },
    updatedAt: normalizedUpdatedAt,
    expireAt,
    nextRefreshAt: String(
      safe.nextRefreshAt || safe.next_refresh_at || computeNextRefreshAt(normalizedUpdatedAt, refreshConfig, deviceId, template.slug)
    ),
    refreshMode: String(safe.refreshMode || safe.refresh_mode || refreshConfig.mode || "interval"),
    refreshStatus: String(safe.refreshStatus || safe.refresh_status || "idle"),
    lastError: String(safe.lastError || safe.last_error || ""),
    lastLatencyMs: Number(safe.lastLatencyMs || safe.last_latency_ms || 0) || 0,
    lastRefreshSource: String(safe.lastRefreshSource || safe.last_refresh_source || ""),
    lastRequestAt: String(safe.lastRequestAt || safe.last_request_at || ""),
    stale: false,
  };
  normalized.stale = !isCacheFresh(normalized, refreshConfig, new Date());
  return normalized;
}

function buildCacheMeta(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const updatedAt = now.toISOString();
  const refreshConfig = normalizeTemplateRefreshConfig(options.refreshConfig, {
    slug: options.slug,
  });
  const base = {
    updatedAt,
    expireAt: computeExpireAt(updatedAt, refreshConfig),
    nextRefreshAt: computeNextRefreshAt(updatedAt, refreshConfig, options.deviceId, options.slug),
    refreshMode: refreshConfig.mode,
    refreshStatus: String(options.refreshStatus || "success"),
    lastError: String(options.lastError || ""),
    lastLatencyMs: Math.max(0, Number(options.lastLatencyMs || 0)),
    lastRefreshSource: String(options.lastRefreshSource || ""),
    lastRequestAt: String(options.lastRequestAt || updatedAt),
    stale: false,
  };
  if (base.refreshStatus === "failed") {
    base.stale = true;
  }
  return base;
}

function isCacheFresh(cacheEntry, refreshConfig, now = new Date()) {
  if (!cacheEntry || typeof cacheEntry !== "object" || Array.isArray(cacheEntry)) return false;
  const cfg = normalizeTemplateRefreshConfig(refreshConfig, {
    slug: cacheEntry?.template?.slug,
  });
  const nowTs = now.getTime();
  const expireTs = toTimestamp(cacheEntry.expireAt || cacheEntry.expire_at || "");
  if (Number.isFinite(expireTs)) return expireTs > nowTs;
  const updatedTs = toTimestamp(cacheEntry.updatedAt || cacheEntry.updated_at || "");
  if (!Number.isFinite(updatedTs)) return false;
  const ttlSeconds = clampInt(
    cfg.ttlSeconds,
    Number(config.defaultApiTemplateCacheTtlSeconds || 300),
    30,
    24 * 60 * 60
  );
  return updatedTs + ttlSeconds * 1000 > nowTs;
}

function minRequestGapHit(cacheEntry, refreshConfig, now = new Date()) {
  const cfg = normalizeTemplateRefreshConfig(refreshConfig, {
    slug: cacheEntry?.template?.slug,
  });
  const gapSeconds = clampInt(cfg.minRequestGapSeconds, 0, 0, 24 * 60 * 60);
  if (gapSeconds <= 0) return false;
  const lastRequestTs = toTimestamp(cacheEntry?.lastRequestAt || cacheEntry?.last_request_at || "");
  if (!Number.isFinite(lastRequestTs)) return false;
  return now.getTime() - lastRequestTs < gapSeconds * 1000;
}

function shouldRefreshOnRequest(cacheEntry, refreshConfig, now = new Date()) {
  const cfg = normalizeTemplateRefreshConfig(refreshConfig, {
    slug: cacheEntry?.template?.slug,
  });
  if (!cfg.enabled) return false;
  if (!cacheEntry) return true;
  return !isCacheFresh(cacheEntry, cfg, now);
}

function withInFlight(key, runner) {
  const safeKey = String(key || "");
  const existing = inFlightMap.get(safeKey);
  if (existing) {
    return { reused: true, promise: existing };
  }
  const promise = Promise.resolve()
    .then(() => runner())
    .finally(() => {
      inFlightMap.delete(safeKey);
    });
  inFlightMap.set(safeKey, promise);
  return { reused: false, promise };
}

async function writeCacheFailure({
  deviceId,
  slug,
  template,
  existingEntry,
  refreshSource,
  refreshConfig,
  errorMessage,
  latencyMs = 0,
}) {
  const normalizedExisting = normalizeCacheEntry(existingEntry, template, deviceId);
  const meta = buildCacheMeta({
    deviceId,
    slug,
    refreshConfig,
    refreshStatus: "failed",
    lastError: String(errorMessage || "refresh_failed"),
    lastLatencyMs: latencyMs,
    lastRefreshSource: refreshSource,
    lastRequestAt: nowIso(),
  });
  const merged = {
    ...normalizedExisting,
    ...meta,
    stale: true,
  };
  const writeStart = Date.now();
  await patchDeviceThirdApiCache({
    deviceId,
    slug,
    updater: () => merged,
  });
  // eslint-disable-next-line no-console
  console.info(
    `[api-template-refresh] cache-write-failed-entry source=${refreshSource} device=${String(
      deviceId || ""
    )} slug=${String(slug || "")} ms=${Date.now() - writeStart}`
  );
  return merged;
}

function ensureTemplateExecutor() {
  if (typeof templateExecutor === "function") return templateExecutor;
  throw new Error("api template executor not registered");
}

async function executeTemplateAndWriteCache(options = {}) {
  const executor = ensureTemplateExecutor();
  return executor(options);
}

function getPageService(pageType) {
  const type = String(pageType || "").trim().toLowerCase();
  if (type === "badgepage") return badgepageService;
  if (type === "weatherpage") return weatherpageService;
  return homepageService;
}

function slugTokens(slug) {
  const safe = String(slug || "").trim();
  return [
    `api.formatted_by_slug.${safe}`,
    `api.third.${safe}`,
    `api.raw_by_slug.${safe}`,
    `api.meta_by_slug.${safe}`,
    `formatted_by_slug.${safe}`,
    `third.${safe}`,
    `third_formatted.${safe}`,
  ];
}

function escapeRegExp(input = "") {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSlugReferenced(content, slug) {
  const text = String(content || "");
  if (!text) return false;
  const safeSlug = String(slug || "").trim();
  if (!safeSlug) return false;
  if (slugTokens(safeSlug).some((token) => text.includes(token))) return true;
  // Plain {{slug.xxx}} is only a legacy shorthand for API templates.  Some
  // page-local data namespaces intentionally share names with API template
  // slugs (notably weatherpage uses {{weather.city}} from the local weather
  // model).  Treating those as API references makes every default weatherpage
  // schedule the paid weather API even when the page is configured for local
  // fallback data.
  const localNamespaces = new Set([
    "profile",
    "todo_summary",
    "schedule_summary",
    "weather",
    "devicevariables",
    "device_variables",
    "custom_fields",
    "meta",
    "api",
    "third",
    "third_formatted",
    "third_raw",
    "formatted_by_slug",
  ]);
  if (localNamespaces.has(safeSlug.toLowerCase())) return false;
  const placeholderReg = new RegExp(
    `\\{\\{\\s*${escapeRegExp(safeSlug)}(?:\\.|\\s*\\}\\})`,
    "i"
  );
  return placeholderReg.test(text);
}

function collectReferencedTemplateSlugsFromPage(db, device, pageType) {
  const service = getPageService(pageType);
  const ownerId = String(device?.ownerId || "");
  const deviceId = String(device?.id || "");
  try {
    const resolved = service.resolveConfig(db, ownerId, deviceId);
    const template = service.resolveTemplateHtml(
      db,
      resolved?.config || {},
      { role: "admin", userId: ownerId || "system" }
    );
    const html =
      typeof template === "string"
        ? template
        : String(template?.html || "");
    const configBlob = JSON.stringify(resolved?.config || {});
    const targetText = `${String(html || "")}\n${configBlob}`;
    const templates = Array.isArray(db?.apiTemplates) ? db.apiTemplates : [];
    return templates
      .filter((tpl) => tpl && typeof tpl === "object" && tpl.enabled !== false && String(tpl.slug || "").trim())
      .map((tpl) => String(tpl.slug || "").trim())
      .filter((slug) => isSlugReferenced(targetText, slug));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[api-template-refresh] collect refs failed page=${String(pageType || "")} device=${deviceId} err=${String(
        error?.message || error
      )}`
    );
    return [];
  }
}

function collectReferencedTemplateSlugsForDevice(db, device, options = {}) {
  const pageTypes = Array.isArray(options.pageTypes) && options.pageTypes.length
    ? options.pageTypes
    : ["homepage", "badgepage", "weatherpage"];
  const set = new Set();
  pageTypes.forEach((pageType) => {
    collectReferencedTemplateSlugsFromPage(db, device, pageType).forEach((slug) => set.add(slug));
  });
  return Array.from(set.values());
}

function collectReferencedPageTypesForSlugForDevice(db, device, slug, options = {}) {
  const safeSlug = String(slug || "").trim();
  if (!safeSlug) return [];
  const pageTypes = Array.isArray(options.pageTypes) && options.pageTypes.length
    ? options.pageTypes
    : ["homepage", "badgepage", "weatherpage"];
  return pageTypes.filter((pageType) =>
    collectReferencedTemplateSlugsFromPage(db, device, pageType).includes(safeSlug)
  );
}

async function refreshTemplateIfNeeded(options = {}) {
  const {
    auth,
    deviceId,
    slug,
    reason = "request",
    force = false,
    inputParams = {},
    refreshSource = force ? "manual_api" : "request_sync",
  } = options;
  const safeSlug = String(slug || "").trim();
  if (!safeSlug) return { status: "skip", reason: "missing_slug", slug: safeSlug };

  const db = await readDB();
  const device = ensureDeviceAccess(db, auth || { role: "admin", userId: "system" }, deviceId);
  const template = (Array.isArray(db.apiTemplates) ? db.apiTemplates : []).find(
    (tpl) => String(tpl?.slug || "") === safeSlug && tpl.enabled !== false
  );
  if (!template) return { status: "skip", reason: "template_missing_or_disabled", slug: safeSlug };

  const refreshConfig = normalizeTemplateRefreshConfig(template.refreshConfig, { slug: safeSlug });
  const cacheRaw =
    device.thirdApiCache && typeof device.thirdApiCache === "object" && !Array.isArray(device.thirdApiCache)
      ? device.thirdApiCache[safeSlug]
      : null;
  const cacheEntry = cacheRaw ? normalizeCacheEntry(cacheRaw, template, device.id) : null;
  const now = new Date();
  const mode = String(refreshConfig.mode || "interval");

  if (!force) {
    if (!refreshConfig.enabled) {
      return { status: "skip", reason: "refresh_disabled", slug: safeSlug, mode };
    }
    if (mode === "manual") {
      return { status: "skip", reason: "manual_mode", slug: safeSlug, mode };
    }
    if (mode === "interval") {
      return {
        status: "cache_only",
        reason: "interval_mode_cache_only",
        slug: safeSlug,
        mode,
        fresh: isCacheFresh(cacheEntry, refreshConfig, now),
      };
    }
    const needRefresh = shouldRefreshOnRequest(cacheEntry, refreshConfig, now);
    if (!needRefresh) {
      return { status: "cache_hit", reason: "cache_fresh", slug: safeSlug, mode, fresh: true };
    }
    if (minRequestGapHit(cacheEntry, refreshConfig, now)) {
      // eslint-disable-next-line no-console
      console.info(
        `[api-template-refresh] skip min-gap source=${refreshSource} reason=${reason} device=${String(
          device.id || ""
        )} slug=${safeSlug}`
      );
      return { status: "cache_hit", reason: "min_request_gap", slug: safeSlug, mode, fresh: false };
    }
  }

  const key = `${String(device.id || "")}::${safeSlug}`;
  const runner = async () => {
    const startedAt = Date.now();
    try {
      // eslint-disable-next-line no-console
      console.info(
        `[api-template-refresh] execute source=${refreshSource} reason=${reason} device=${String(
          device.id || ""
        )} slug=${safeSlug}`
      );
      return await executeTemplateAndWriteCache({
        auth: auth || { role: "admin", userId: String(device.ownerId || "system") },
        deviceId: String(device.id || ""),
        slug: safeSlug,
        params: inputParams,
        refreshSource,
        force,
      });
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = String(error?.message || error);
      const allowFallback = Boolean(refreshConfig.fallbackToStale);
      if (cacheEntry && allowFallback) {
        // eslint-disable-next-line no-console
        console.warn(
          `[api-template-refresh] fallback stale source=${refreshSource} reason=${reason} device=${String(
            device.id || ""
          )} slug=${safeSlug} err=${message}`
        );
        await writeCacheFailure({
          deviceId: device.id,
          slug: safeSlug,
          template,
          existingEntry: cacheEntry,
          refreshSource,
          refreshConfig,
          errorMessage: message,
          latencyMs,
        });
        return {
          status: "fallback_stale",
          slug: safeSlug,
          mode,
          reason: "refresh_failed_fallback_stale",
          error: message,
        };
      }
      throw error;
    }
  };

  if (!force && mode === "stale_while_revalidate" && cacheEntry && !isCacheFresh(cacheEntry, refreshConfig, now)) {
    const wrapped = withInFlight(key, runner);
    if (!wrapped.reused) {
      wrapped.promise.catch((error) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[api-template-refresh] swr async failed device=${String(device.id || "")} slug=${safeSlug} err=${String(
            error?.message || error
          )}`
        );
      });
    }
    return {
      status: "stale_returned_async_refresh",
      slug: safeSlug,
      mode,
      reason,
      reusedInFlight: wrapped.reused,
    };
  }

  const wrapped = withInFlight(key, runner);
  if (wrapped.reused) {
    // eslint-disable-next-line no-console
    console.info(
      `[api-template-refresh] reuse in-flight source=${refreshSource} reason=${reason} device=${String(
        device.id || ""
      )} slug=${safeSlug}`
    );
  }
  const result = await wrapped.promise;
  return {
    status: result?.status || "refreshed",
    slug: safeSlug,
    mode,
    reason,
    reusedInFlight: wrapped.reused,
    result,
  };
}

async function refreshTemplatesForPageRequest(options = {}) {
  const {
    auth,
    deviceId,
    pageType = "homepage",
    requestSource = "hardware_page",
  } = options;
  const db = await readDB();
  const device = ensureDeviceAccess(db, auth || { role: "admin", userId: "system" }, deviceId);
  const pageTypes = Array.isArray(pageType) ? pageType : [pageType];
  const slugs = collectReferencedTemplateSlugsForDevice(db, device, { pageTypes });
  const results = [];
  for (const slug of slugs) {
    // eslint-disable-next-line no-await-in-loop
    const result = await refreshTemplateIfNeeded({
      auth: auth || { role: "admin", userId: String(device.ownerId || "system") },
      deviceId: device.id,
      slug,
      reason: `${requestSource}:${pageTypes.join(",")}`,
      force: false,
      refreshSource: "request_sync",
    }).catch((error) => ({
      status: "failed",
      slug,
      reason: String(error?.message || error),
    }));
    results.push(result);
  }
  return {
    deviceId: String(device.id || ""),
    pageTypes,
    slugs,
    results,
  };
}

module.exports = {
  registerTemplateExecutor,
  getDefaultTemplateRefreshConfig,
  normalizeTemplateRefreshConfig,
  normalizeCacheEntry,
  buildCacheMeta,
  isCacheFresh,
  shouldRefreshOnRequest,
  computeNextRefreshAt,
  computeExpireAt,
  computeJitterSeconds,
  executeTemplateAndWriteCache,
  refreshTemplateIfNeeded,
  refreshTemplatesForPageRequest,
  collectReferencedTemplateSlugsForDevice,
  collectReferencedPageTypesForSlugForDevice,
};
