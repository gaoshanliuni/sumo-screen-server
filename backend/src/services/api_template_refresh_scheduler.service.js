const config = require("../config");
const { readDB } = require("../db/store");
const {
  normalizeTemplateRefreshConfig,
  normalizeCacheEntry,
  refreshTemplateIfNeeded,
  collectReferencedTemplateSlugsForDevice,
  collectReferencedPageTypesForSlugForDevice,
  computeNextRefreshAt,
} = require("./api_template_refresh.service");
const homepageService = require("./homepage_page.service");
const badgepageService = require("./badgepage.service");
const weatherpageService = require("./weatherpage.service");
const {
  renderAndPersistForDevice,
  publishPagePushEvents,
} = require("./page_push.service");

const PAGE_RENDER_MAP = {
  homepage: {
    eventPrefix: "homepage",
    service: homepageService,
  },
  badgepage: {
    eventPrefix: "badgepage",
    service: badgepageService,
  },
  weatherpage: {
    eventPrefix: "weatherpage",
    service: weatherpageService,
  },
};

function toTimestamp(value) {
  const ts = Date.parse(String(value || ""));
  return Number.isFinite(ts) ? ts : null;
}

function shouldRunIntervalRefresh({ cacheEntry, refreshConfig, now, deviceId, slug }) {
  if (!refreshConfig.enabled) return false;
  if (String(refreshConfig.mode || "") !== "interval") return false;
  if (!cacheEntry) return true;
  const nowTs = now.getTime();
  const nextTs = toTimestamp(cacheEntry.nextRefreshAt || cacheEntry.next_refresh_at || "");
  if (Number.isFinite(nextTs)) return nextTs <= nowTs;
  const fallbackNext = computeNextRefreshAt(
    cacheEntry.updatedAt || cacheEntry.updated_at || now.toISOString(),
    refreshConfig,
    deviceId,
    slug
  );
  const fallbackTs = toTimestamp(fallbackNext);
  return Number.isFinite(fallbackTs) ? fallbackTs <= nowTs : true;
}

function hasRequiredTemplateCredentials(template, device) {
  if (!template || template.deviceKeyRequired !== true) return true;
  const slug = String(template.slug || "").trim();
  if (!slug) return false;
  const apiKeys =
    device?.apiKeys && typeof device.apiKeys === "object" && !Array.isArray(device.apiKeys)
      ? device.apiKeys
      : {};
  return String(apiKeys[slug] || "").trim().length > 0;
}

async function runApiTemplateRefreshSchedulerTick(now = new Date()) {
  const db = await readDB();
  const devices = Array.isArray(db.devices) ? db.devices : [];
  const templates = Array.isArray(db.apiTemplates) ? db.apiTemplates : [];
  const templateBySlug = new Map(
    templates
      .filter((tpl) => tpl && typeof tpl === "object" && String(tpl.slug || "").trim())
      .map((tpl) => [String(tpl.slug || "").trim(), tpl])
  );

  const dueTasks = [];
  devices.forEach((device) => {
    if (!device || typeof device !== "object") return;
    if (String(device.status || "enabled") === "blocked") return;
    const slugs = collectReferencedTemplateSlugsForDevice(db, device, {
      pageTypes: ["homepage", "badgepage", "weatherpage"],
    });
    slugs.forEach((slug) => {
      const tpl = templateBySlug.get(slug);
      if (!tpl || tpl.enabled === false) return;
      if (!hasRequiredTemplateCredentials(tpl, device)) return;
      const refreshConfig = normalizeTemplateRefreshConfig(tpl.refreshConfig, { slug });
      if (refreshConfig.mode !== "interval") return;
      const rawCache =
        device.thirdApiCache && typeof device.thirdApiCache === "object" && !Array.isArray(device.thirdApiCache)
          ? device.thirdApiCache[slug]
          : null;
      const cacheEntry = rawCache ? normalizeCacheEntry(rawCache, tpl, device.id) : null;
      if (!shouldRunIntervalRefresh({ cacheEntry, refreshConfig, now, deviceId: device.id, slug })) return;
      const pageTypes = collectReferencedPageTypesForSlugForDevice(db, device, slug, {
        pageTypes: ["homepage", "badgepage", "weatherpage"],
      });
      dueTasks.push({
        deviceId: String(device.id || ""),
        ownerId: String(device.ownerId || ""),
        slug,
        pageTypes: Array.isArray(pageTypes) ? pageTypes : [],
      });
    });
  });

  if (dueTasks.length) {
    // eslint-disable-next-line no-console
    console.info(
      `[api-template-refresh] tick due=${dueTasks.length} scannedDevices=${devices.length}`
    );
  }

  const results = [];
  const maxConcurrent = 2;
  for (let i = 0; i < dueTasks.length; i += maxConcurrent) {
    const batch = dueTasks.slice(i, i + maxConcurrent);
    // eslint-disable-next-line no-await-in-loop
    const batchResults = await Promise.all(
      batch.map(async (task) => {
        try {
          const refreshResult = await refreshTemplateIfNeeded({
            auth: { role: "admin", userId: task.ownerId || "system" },
            deviceId: task.deviceId,
            slug: task.slug,
            reason: "interval_scheduler",
            force: true,
            refreshSource: "interval_scheduler",
          });
          return {
            ...task,
            status: "success",
            refreshResult,
          };
        } catch (error) {
          return {
            ...task,
            status: "failed",
            error: String(error?.message || error),
          };
        }
      })
    );
    results.push(...batchResults);
  }

  if (dueTasks.length) {
    const successCount = results.filter((item) => item?.status === "success").length;
    const failedCount = results.filter((item) => item?.status === "failed").length;
    // eslint-disable-next-line no-console
    console.info(
      `[api-template-refresh] tick refreshed success=${successCount} failed=${failedCount} due=${dueTasks.length}`
    );
  }

  const renderPlan = new Map();
  results.forEach((item) => {
    if (item?.status !== "success") return;
    if (String(item?.refreshResult?.status || "") === "fallback_stale") return;
    const deviceId = String(item.deviceId || "");
    if (!deviceId) return;
    const ownerId = String(item.ownerId || "");
    const pageTypes = Array.isArray(item.pageTypes) ? item.pageTypes : [];
    if (!renderPlan.has(deviceId)) {
      renderPlan.set(deviceId, {
        ownerId,
        pageTypes: new Set(),
      });
    }
    const bucket = renderPlan.get(deviceId);
    pageTypes.forEach((type) => {
      if (PAGE_RENDER_MAP[String(type || "")]) {
        bucket.pageTypes.add(String(type || ""));
      }
    });
  });

  const renderResults = [];
  for (const [deviceId, plan] of renderPlan.entries()) {
    const pageTypes = Array.from(plan.pageTypes.values());
    for (const pageType of pageTypes) {
      const renderInfo = PAGE_RENDER_MAP[pageType];
      if (!renderInfo) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const rendered = await renderAndPersistForDevice({
          auth: { role: "admin", userId: plan.ownerId || "system" },
          deviceId,
          pageType,
          service: renderInfo.service,
          skipAccessCheck: false,
        });
        publishPagePushEvents({
          eventPrefix: renderInfo.eventPrefix,
          deviceId,
          payload: rendered.payload,
        });
        renderResults.push({
          deviceId,
          pageType,
          status: "success",
          imageId: String(rendered?.payload?.image?.image_id || ""),
          etag: String(rendered?.payload?.image?.etag || ""),
        });
      } catch (error) {
        const message = String(error?.message || error);
        // eslint-disable-next-line no-console
        console.warn(
          `[api-template-refresh] render push failed device=${deviceId} pageType=${pageType} err=${message}`
        );
        renderResults.push({
          deviceId,
          pageType,
          status: "failed",
          error: message,
        });
      }
    }
  }

  if (renderResults.length) {
    const successCount = renderResults.filter((item) => item?.status === "success").length;
    const failedCount = renderResults.filter((item) => item?.status === "failed").length;
    // eslint-disable-next-line no-console
    console.info(
      `[api-template-refresh] tick render-push success=${successCount} failed=${failedCount} total=${renderResults.length}`
    );
  }

  return {
    tickAt: now.toISOString(),
    scannedDevices: devices.length,
    dueCount: dueTasks.length,
    results,
    renderCount: renderResults.length,
    renderResults,
  };
}

function startApiTemplateRefreshScheduler() {
  if (global.__apiTemplateRefreshScheduler) return global.__apiTemplateRefreshScheduler;
  const intervalMs = Math.max(15000, Number(config.apiTemplateRefreshSchedulerIntervalMs || 60000));
  const state = {
    startedAt: new Date().toISOString(),
    intervalMs,
    timer: null,
    running: false,
    lastTickAt: "",
    lastTickResult: null,
  };

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    state.lastTickAt = new Date().toISOString();
    try {
      state.lastTickResult = await runApiTemplateRefreshSchedulerTick(new Date());
    } catch (error) {
      state.lastTickResult = { failed: true, error: String(error?.message || error) };
      // eslint-disable-next-line no-console
      console.warn(`[api-template-refresh] tick failed: ${String(error?.message || error)}`);
    } finally {
      state.running = false;
    }
  };

  tick().catch((error) => {
    // eslint-disable-next-line no-console
    console.warn(`[api-template-refresh] initial tick failed: ${String(error?.message || error)}`);
  });

  state.timer = setInterval(() => {
    tick().catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(`[api-template-refresh] scheduler tick crash: ${String(error?.message || error)}`);
    });
  }, intervalMs);
  if (typeof state.timer.unref === "function") {
    state.timer.unref();
  }
  // eslint-disable-next-line no-console
  console.info(`[api-template-refresh] scheduler started intervalMs=${intervalMs}`);
  global.__apiTemplateRefreshScheduler = state;
  return state;
}

function stopApiTemplateRefreshScheduler() {
  const state = global.__apiTemplateRefreshScheduler;
  if (state?.timer) clearInterval(state.timer);
  delete global.__apiTemplateRefreshScheduler;
}

module.exports = {
  runApiTemplateRefreshSchedulerTick,
  startApiTemplateRefreshScheduler,
  stopApiTemplateRefreshScheduler,
};
