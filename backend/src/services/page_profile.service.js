const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const canvasModule = require("@napi-rs/canvas");
const { createCanvas, loadImage } = canvasModule;

const config = require("../config");
const createId = require("../utils/id");
const HttpError = require("../utils/httpError");
const { getGridBucket } = require("../utils/mongo");
const { normalizeAutoRenderPushConfig } = require("./homepage_auto_push_time.service");
const {
  WEEKDAY_LABEL_MAP,
  normalizeWeeksArray,
  normalizeTermStartDate,
  extractCurrentWeekFromText,
  resolveTeachingWeekContext,
  isCourseActiveInWeek,
} = require("./xique_sync.service");

const ROOT_DIR = path.join(__dirname, "../../..");
const QWEATHER_DIR = path.join(ROOT_DIR, "ico/QWeather-Icons-1.8.0");
const QWEATHER_FONT_DIR = path.join(QWEATHER_DIR, "font");
const QWEATHER_FONT_FILE = path.join(QWEATHER_FONT_DIR, "fonts/qweather-icons.ttf");
const QWEATHER_ICON_MAP_FILE = path.join(QWEATHER_FONT_DIR, "qweather-icons.json");
const QWEATHER_DEMO_FILE = path.join(QWEATHER_FONT_DIR, "demo.html");
const QWEATHER_CSS_FILE = path.join(QWEATHER_FONT_DIR, "qweather-icons.css");

let qweatherFontRegistered = false;
let qweatherIconMap = null;
let qweatherFontDataUrl = "";
let playwrightModule = null;
let browserLaunchPromise = null;
let browserCleanupHooked = false;
let qweatherFontWarned = false;
let systemFontsLoaded = false;

function parsePositiveInt(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return Math.floor(num);
  }
  return Math.floor(Number(fallback) > 0 ? Number(fallback) : 0);
}

function registerCanvasFontCompat(fontPath, family) {
  if (!fontPath || !family) return false;
  try {
    if (typeof canvasModule.registerFont === "function") {
      canvasModule.registerFont(fontPath, { family });
      return true;
    }
    const gf = canvasModule.GlobalFonts;
    if (gf && typeof gf.registerFromPath === "function") {
      return Boolean(gf.registerFromPath(fontPath, family));
    }
    if (gf && typeof gf.register === "function") {
      const buf = fs.readFileSync(fontPath);
      return Boolean(gf.register(buf, family));
    }
  } catch (_) {
    return false;
  }
  return false;
}

function ensureSystemFontsLoaded() {
  if (systemFontsLoaded) return;
  try {
    const gf = canvasModule.GlobalFonts;
    if (gf && typeof gf.loadSystemFonts === "function") {
      gf.loadSystemFonts();
    }
    const cjkCandidates = [
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/opentype/noto/NotoSansCJKSC-Regular.otf",
      "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
      "C:/Windows/Fonts/msyh.ttc",
      "C:/Windows/Fonts/msyh.ttf",
    ];
    for (const fontPath of cjkCandidates) {
      if (fs.existsSync(fontPath)) {
        registerCanvasFontCompat(fontPath, "PageRenderCJK");
        break;
      }
    }
    const customCjkFont = String(process.env.PAGE_RENDER_CJK_FONT_PATH || "").trim();
    if (customCjkFont && fs.existsSync(customCjkFont)) {
      registerCanvasFontCompat(customCjkFont, "PageRenderCJK");
    }
  } catch (_) {
    // ignore
  } finally {
    systemFontsLoaded = true;
  }
}

function withPromiseTimeout(taskPromise, timeoutMs, timeoutMessage) {
  const safeTimeoutMs = Math.max(1000, parsePositiveInt(timeoutMs, 12000));
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage || `timeout after ${safeTimeoutMs}ms`));
    }, safeTimeoutMs);
  });
  return Promise.race([taskPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function getBrowserRenderWaitConfig(config) {
  const template = isObject(config?.template) ? config.template : {};
  const image = isObject(config?.image) ? config.image : {};
  const readyTimeoutMs = parsePositiveInt(
    template.render_ready_timeout_ms ?? template.render_timeout_ms ?? image.render_ready_timeout_ms ?? image.render_timeout_ms,
    8000
  );
  const idleSettleMs = parsePositiveInt(
    template.render_idle_settle_ms ?? template.render_settle_ms ?? image.render_idle_settle_ms ?? image.render_settle_ms,
    450
  );
  return {
    readyTimeoutMs: Math.max(1500, readyTimeoutMs),
    idleSettleMs: Math.max(150, idleSettleMs),
  };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function isObject(input) {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function deepMerge(base, patch) {
  const out = isObject(base) ? deepClone(base) : {};
  if (!isObject(patch)) return out;
  Object.keys(patch).forEach((key) => {
    const baseValue = out[key];
    const patchValue = patch[key];
    if (isObject(baseValue) && isObject(patchValue)) {
      out[key] = deepMerge(baseValue, patchValue);
    } else {
      out[key] = deepClone(patchValue);
    }
  });
  return out;
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function normalizePageType(pageType) {
  const v = String(pageType || "").trim().toLowerCase();
  if (["home", "homepage"].includes(v)) return "homepage";
  if (["badge", "badgepage", "nameplate"].includes(v)) return "badgepage";
  if (["weather", "weatherpage"].includes(v)) return "weatherpage";
  throw new HttpError(400, `unsupported page type: ${pageType}`);
}

function configKeyForPage(pageType) {
  const t = normalizePageType(pageType);
  if (t === "homepage") return "homepageConfigs";
  if (t === "badgepage") return "badgepageConfigs";
  return "weatherpageConfigs";
}

function templateKeyForPage(pageType) {
  const t = normalizePageType(pageType);
  if (t === "homepage") return "homepageTemplates";
  if (t === "badgepage") return "badgepageTemplates";
  return "weatherpageTemplates";
}

function imageKeyForPage(pageType) {
  const t = normalizePageType(pageType);
  if (t === "homepage") return "homepageImages";
  if (t === "badgepage") return "badgepageImages";
  return "weatherpageImages";
}

function normalizeAlign(input, fallback = "left") {
  const v = String(input || fallback).toLowerCase();
  return ["left", "center", "right"].includes(v) ? v : fallback;
}

function normalizeRenderMode(modeInput, engineInput) {
  const mode = String(modeInput || "").trim().toLowerCase();
  if (["legacy", "web", "hybrid"].includes(mode)) return mode;
  if (mode === "browser") return "web";
  if (mode === "auto") return "hybrid";

  const engine = String(engineInput || "").trim().toLowerCase();
  if (engine === "legacy") return "legacy";
  if (engine === "browser") return "web";
  return "hybrid";
}

function normalizePageConfig(input, fallback, pageType) {
  const page = normalizePageType(pageType);
  const merged = deepMerge(fallback || {}, input || {});

  merged.id = String(merged.id || `${page}_default`);
  merged.page_type = page;
  merged.name = String(merged.name || page);
  merged.enabled = merged.enabled !== false;
  merged.version = Number(merged.version || 1);

  merged.screen = merged.screen || {};
  merged.screen.width = clamp(merged.screen.width, 320, 4096, 2560);
  merged.screen.height = clamp(merged.screen.height, 240, 4096, 1600);

  merged.template = merged.template || {};
  merged.template.type = String(merged.template.type || "default_html");
  merged.template.template_id = String(merged.template.template_id || `tpl_${page}_default`);
  merged.template.template_name = String(merged.template.template_name || `${page} template`);
  merged.template.render_engine = String(merged.template.render_engine || "auto").toLowerCase();
  merged.template.render_mode = normalizeRenderMode(merged.template.render_mode, merged.template.render_engine);
  merged.template.debug = Boolean(merged.template.debug);

  merged.image = merged.image || {};
  merged.image.format = String(merged.image.format || "epd4").toLowerCase();
  merged.image.preview_format = String(merged.image.preview_format || "png").toLowerCase();
  merged.image.render_source = String(merged.image.render_source || "server");
  merged.image.cache_ttl_sec = clamp(merged.image.cache_ttl_sec, 30, 86400, 3600);
  merged.image.refresh_policy = String(merged.image.refresh_policy || "on-demand");

  if (page === "homepage") {
    merged.auto_render_push = normalizeAutoRenderPushConfig(merged.auto_render_push || {}, {
      now: new Date(),
      timeZone: config.timezone || "Asia/Shanghai",
      recomputeNext: false,
    });
  }

  merged.time_overlay = merged.time_overlay || {};
  merged.time_overlay.enabled = Boolean(merged.time_overlay.enabled);
  merged.time_overlay.x = clamp(merged.time_overlay.x, 0, merged.screen.width, Math.max(0, merged.screen.width - 720));
  merged.time_overlay.y = clamp(merged.time_overlay.y, 0, merged.screen.height, 80);
  merged.time_overlay.width = clamp(merged.time_overlay.width, 80, merged.screen.width, 680);
  merged.time_overlay.height = clamp(merged.time_overlay.height, 40, merged.screen.height, 180);
  merged.time_overlay.format = String(merged.time_overlay.format || "HH:mm");
  merged.time_overlay.font_size = clamp(merged.time_overlay.font_size, 12, 220, 88);
  merged.time_overlay.align = normalizeAlign(merged.time_overlay.align, "right");
  merged.time_overlay.refresh_interval_sec = clamp(merged.time_overlay.refresh_interval_sec, 1, 3600, 60);
  merged.time_overlay.background_clear_mode = String(merged.time_overlay.background_clear_mode || "none");
  merged.time_overlay.invert = Boolean(merged.time_overlay.invert);

  merged.cache_policy = merged.cache_policy || {};
  merged.cache_policy.cache_ttl_sec = clamp(merged.cache_policy.cache_ttl_sec, 30, 86400, 3600);
  merged.cache_policy.max_versions = clamp(merged.cache_policy.max_versions, 1, 30, 3);
  merged.cache_policy.use_etag = merged.cache_policy.use_etag !== false;

  merged.refresh_control = merged.refresh_control || {};
  merged.refresh_control.partial_refresh_enabled = merged.refresh_control.partial_refresh_enabled !== false;
  merged.refresh_control.full_refresh_every_n_partials = clamp(merged.refresh_control.full_refresh_every_n_partials, 1, 120, 6);
  merged.refresh_control.force_full_refresh_on_image_version_change =
    merged.refresh_control.force_full_refresh_on_image_version_change !== false;
  merged.refresh_control.max_partial_age_sec = clamp(merged.refresh_control.max_partial_age_sec, 10, 86400, 900);

  merged.refresh_control.partial_refresh_region = merged.refresh_control.partial_refresh_region || {};
  merged.refresh_control.partial_refresh_region.x = clamp(
    merged.refresh_control.partial_refresh_region.x,
    0,
    merged.screen.width,
    0
  );
  merged.refresh_control.partial_refresh_region.y = clamp(
    merged.refresh_control.partial_refresh_region.y,
    0,
    merged.screen.height,
    0
  );
  merged.refresh_control.partial_refresh_region.width = clamp(
    merged.refresh_control.partial_refresh_region.width,
    1,
    merged.screen.width,
    merged.screen.width
  );
  merged.refresh_control.partial_refresh_region.height = clamp(
    merged.refresh_control.partial_refresh_region.height,
    1,
    merged.screen.height,
    merged.screen.height
  );

  merged.fallback = merged.fallback || {};
  merged.fallback.enabled = merged.fallback.enabled !== false;
  merged.fallback.mode = String(merged.fallback.mode || "local_text_fallback");

  return merged;
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseAttributes(rawAttrs) {
  const attrs = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = attrRegex.exec(rawAttrs || "");
  while (match) {
    attrs[match[1]] = match[2] !== undefined ? match[2] : match[3] || "";
    match = attrRegex.exec(rawAttrs || "");
  }
  return attrs;
}

function getPathValue(source, dottedPath) {
  if (!isObject(source) || !dottedPath) return "";
  const parts = String(dottedPath).split(".").filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (!isObject(current) && !Array.isArray(current)) {
      return "";
    }
    current = current[part];
    if (current === undefined || current === null) return "";
  }
  if (typeof current === "string") return current;
  if (typeof current === "number" || typeof current === "boolean") return String(current);
  if (Array.isArray(current)) return current.join(", ");
  return "";
}

function interpolate(text, dataModel) {
  return String(text || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => getPathValue(dataModel, key));
}

function interpolateHtml(text, dataModel) {
  return String(text || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => escapeHtml(getPathValue(dataModel, key)));
}

function parseTemplateBlocks(templateHtml, dataModel, width, height) {
  const blocks = [];
  const regex = /<div([^>]*)>([\s\S]*?)<\/div>/gi;
  let match = regex.exec(templateHtml || "");

  while (match) {
    const attrs = parseAttributes(match[1]);
    const rawText = stripTags(match[2]);
    const text = interpolate(rawText, dataModel);
    if (!text) {
      match = regex.exec(templateHtml || "");
      continue;
    }

    blocks.push({
      x: clamp(attrs["data-x"], 0, width, 120),
      y: clamp(attrs["data-y"], 0, height, 120),
      fontSize: clamp(attrs["data-size"], 10, 256, 48),
      maxWidth: clamp(attrs["data-width"], 80, width, width - 100),
      align: normalizeAlign(attrs["data-align"], "left"),
      weight: attrs["data-weight"] || "400",
      color: attrs["data-color"] || "#000000",
      text,
    });

    match = regex.exec(templateHtml || "");
  }

  return blocks;
}

function getBrowserExecutableCandidates() {
  const resolveExecutableFromPath = (names) => {
    const pathEntries = String(process.env.PATH || "")
      .split(path.delimiter)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (!pathEntries.length) return [];

    const out = [];
    pathEntries.forEach((entry) => {
      names.forEach((name) => {
        const full = path.join(entry, name);
        if (fs.existsSync(full)) out.push(full);
      });
    });
    return out;
  };

  const envPaths = [
    process.env.PLAYWRIGHT_CHROMIUM_PATH,
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    process.env.EDGE_PATH,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  const defaults = [
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
    "/usr/lib/chromium/chromium",
  ];

  const fromPath = resolveExecutableFromPath([
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
    "msedge",
    "microsoft-edge",
  ]);

  return [...new Set([...envPaths, ...defaults, ...fromPath])].filter((item) => fs.existsSync(item));
}

function shouldUseBrowserRender(templateHtml, config) {
  const html = String(templateHtml || "");
  if (!html.trim()) return false;
  const renderMode = normalizeRenderMode(config?.template?.render_mode, config?.template?.render_engine);
  if (renderMode === "legacy") return false;
  return true;
}

function collectPlaceholderDebug(templateHtml, dataModel) {
  const all = [];
  const missing = [];
  const seenAll = new Set();
  const seenMissing = new Set();
  String(templateHtml || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, keyRaw) => {
    const key = String(keyRaw || "").trim();
    if (!key) return "";
    if (!seenAll.has(key)) {
      seenAll.add(key);
      all.push(key);
    }
    const value = getPathValue(dataModel || {}, key);
    if ((value === "" || value === null || value === undefined) && !seenMissing.has(key)) {
      seenMissing.add(key);
      missing.push(key);
    }
    return "";
  });
  return {
    placeholders: all,
    missing,
    placeholderCount: all.length,
    missingCount: missing.length,
  };
}

function extractInlineScripts(rawHtml) {
  const scripts = [];
  const htmlWithoutScripts = String(rawHtml || "").replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (_whole, attrsRaw, bodyRaw) => {
      const attrs = parseAttributes(attrsRaw || "");
      scripts.push({
        src: String(attrs.src || "").trim(),
        type: String(attrs.type || "").trim(),
        content: String(bodyRaw || ""),
      });
      return "";
    }
  );
  return {
    htmlWithoutScripts,
    scripts,
  };
}

function safeJsonForInlineScript(value) {
  return JSON.stringify(value || {})
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function buildRuntimeModelScript(dataModel, width, height, waitConfig, runtimeOptions = {}) {
  const modelJson = safeJsonForInlineScript(dataModel || {});
  const canvasWidth = Number(width) > 0 ? Number(width) : 2560;
  const canvasHeight = Number(height) > 0 ? Number(height) : 1600;
  const readyTimeoutMs = parsePositiveInt(waitConfig?.readyTimeoutMs, 8000);
  const idleSettleMs = parsePositiveInt(waitConfig?.idleSettleMs, 450);
  const renderMode = normalizeRenderMode(runtimeOptions.renderMode, runtimeOptions.renderEngine);
  const deferredScriptsJson = safeJsonForInlineScript(
    Array.isArray(runtimeOptions.deferredScripts) ? runtimeOptions.deferredScripts : []
  );
  const qweatherIconMapJson = safeJsonForInlineScript(
    isObject(runtimeOptions.qweatherIconMap) ? runtimeOptions.qweatherIconMap : {}
  );
  return `<script>
(() => {
  const model = ${modelJson};
  const pageWidth = ${canvasWidth};
  const pageHeight = ${canvasHeight};
  const readyTimeoutMs = ${readyTimeoutMs};
  const idleSettleMs = ${idleSettleMs};
  const renderMode = ${JSON.stringify(renderMode)};
  const deferredScripts = ${deferredScriptsJson};
  const qweatherIconMap = ${qweatherIconMapJson};
  window.__PAGE_MODEL__ = model;
  const renderState = {
    pending: 0,
    ready: false,
    reason: "loading",
    lastActivityAt: performance.now(),
    settleTimer: null,
    hardTimer: null,
    observer: null,
  };
  window.__PAGE_RENDER_STATE__ = renderState;
  window.__PAGE_RENDER_READY__ = false;
  window.__PAGE_RENDER_READY_REASON__ = "loading";
  const debugState = {
    renderMode,
    replacedTextNodes: 0,
    replacedAttributes: 0,
    mappedLegacyCount: 0,
    deferredScriptCount: deferredScripts.length,
    deferredScriptErrors: [],
    missingVariables: [],
    missingCount: 0,
    readyReason: "loading",
  };
  window.__PAGE_RUNTIME_DEBUG__ = debugState;
  const missingSet = new Set();

  const clearTimer = (name) => {
    if (renderState[name]) {
      clearTimeout(renderState[name]);
      renderState[name] = null;
    }
  };

  const finishReady = (reason) => {
    if (renderState.ready) return;
    renderState.ready = true;
    renderState.reason = reason || "settled";
    window.__PAGE_RENDER_READY_REASON__ = renderState.reason;
    window.__PAGE_RENDER_READY__ = true;
    debugState.readyReason = window.__PAGE_RENDER_READY_REASON__;
    debugState.missingVariables = Array.from(missingSet).sort();
    debugState.missingCount = debugState.missingVariables.length;
    clearTimer("settleTimer");
    clearTimer("hardTimer");
    if (renderState.observer) {
      try {
        renderState.observer.disconnect();
      } catch (_) {
        // ignore
      }
      renderState.observer = null;
    }
  };

  const scheduleSettledCheck = (reason) => {
    if (renderState.ready) return;
    clearTimer("settleTimer");
    const elapsed = Math.max(0, performance.now() - renderState.lastActivityAt);
    const delay = Math.max(50, idleSettleMs - elapsed);
    renderState.settleTimer = setTimeout(() => {
      if (renderState.ready) return;
      if (renderState.pending > 0) {
        scheduleSettledCheck("pending");
        return;
      }
      const idle = Math.max(0, performance.now() - renderState.lastActivityAt);
      if (idle >= idleSettleMs) {
        finishReady(reason || "settled");
        return;
      }
      scheduleSettledCheck("activity");
    }, delay);
  };

  const noteActivity = () => {
    if (renderState.ready) return;
    renderState.lastActivityAt = performance.now();
    scheduleSettledCheck("activity");
  };

  const bumpPending = () => {
    if (renderState.ready) return;
    renderState.pending += 1;
    noteActivity();
  };

  const dropPending = () => {
    renderState.pending = Math.max(0, renderState.pending - 1);
    noteActivity();
  };

  const startHardTimeout = () => {
    clearTimer("hardTimer");
    renderState.hardTimer = setTimeout(() => {
      if (renderState.ready) return;
      renderState.reason = "timeout";
      window.__PAGE_RENDER_READY_REASON__ = "timeout";
      finishReady("timeout");
    }, readyTimeoutMs);
  };

  if (typeof window.fetch === "function") {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      bumpPending();
      try {
        const result = nativeFetch(...args);
        return Promise.resolve(result).finally(() => {
          dropPending();
        });
      } catch (error) {
        dropPending();
        throw error;
      }
    };
  }

  window.__PAGE_RENDER_DONE__ = (reason) => {
    renderState.pending = 0;
    renderState.lastActivityAt = performance.now();
    finishReady(reason || "manual");
  };

  const resolve = (obj, path) => {
    if (!path || typeof path !== "string") return "";
    const parts = path.split(".").filter(Boolean);
    let cur = obj;
    for (const part of parts) {
      if (cur === null || cur === undefined) {
        if (!missingSet.has(path)) missingSet.add(path);
        return "";
      }
      cur = cur[part];
    }
    if (cur === null || cur === undefined) {
      if (!missingSet.has(path)) missingSet.add(path);
      return "";
    }
    if (typeof cur === "object") {
      try { return JSON.stringify(cur); } catch (_) { return ""; }
    }
    return String(cur);
  };
  const interpolate = (text) =>
    String(text || "").replace(/\\{\\{\\s*([a-zA-Z0-9_.-]+)\\s*\\}\\}/g, (_m, key) => resolve(model, key));

  window.__PAGE_INTERPOLATE__ = interpolate;
  window.__PAGE_RESOLVE__ = (key) => resolve(model, key);

  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const applyBindings = () => {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => {
      if (!node || !node.nodeValue || node.nodeValue.indexOf("{{") < 0) return;
      const replaced = interpolate(node.nodeValue);
      if (replaced !== node.nodeValue) {
        debugState.replacedTextNodes += 1;
      }
      node.nodeValue = replaced;
    });

    document.querySelectorAll("*").forEach((el) => {
      const attrs = Array.from(el.attributes || []);
      attrs.forEach((attr) => {
        if (!attr || !attr.name) return;
        const raw = String(attr.value || "");
        if (raw && raw.indexOf("{{") >= 0) {
          const replaced = interpolate(raw);
          if (replaced !== raw) debugState.replacedAttributes += 1;
          el.setAttribute(attr.name, replaced);
        }
      });
      const bind = el.getAttribute("data-bind");
      if (bind) {
        el.textContent = resolve(model, bind);
      }
      const bindHtml = el.getAttribute("data-bind-html");
      if (bindHtml) {
        el.innerHTML = resolve(model, bindHtml);
      }
    });
  };

  const resolveIconCodePoint = (iconCode, iconName) => {
    const iconCodeRaw = String(iconCode || "").trim();
    const iconNameRaw = String(iconName || "").trim();
    let codePoint = NaN;

    if (iconCodeRaw) {
      if (/^0x[0-9a-f]+$/i.test(iconCodeRaw)) {
        codePoint = parseInt(iconCodeRaw, 16);
      } else if (/^[0-9]+$/.test(iconCodeRaw)) {
        if (Object.prototype.hasOwnProperty.call(qweatherIconMap, iconCodeRaw)) {
          codePoint = Number(qweatherIconMap[iconCodeRaw]);
        } else {
          codePoint = Number(iconCodeRaw);
        }
      } else if (Object.prototype.hasOwnProperty.call(qweatherIconMap, iconCodeRaw)) {
        codePoint = Number(qweatherIconMap[iconCodeRaw]);
      }
    }

    if (!Number.isFinite(codePoint) && iconNameRaw && Object.prototype.hasOwnProperty.call(qweatherIconMap, iconNameRaw)) {
      codePoint = Number(qweatherIconMap[iconNameRaw]);
    }

    return Number.isFinite(codePoint) ? codePoint : NaN;
  };

  const applyWeatherIconBindings = () => {
    if (!qweatherIconMap || typeof qweatherIconMap !== "object") return;
    const icons = document.querySelectorAll("[data-icon], [data-icon-name]");
    icons.forEach((el) => {
      const cp = resolveIconCodePoint(el.getAttribute("data-icon"), el.getAttribute("data-icon-name"));
      if (!Number.isFinite(cp)) return;
      const glyph = String.fromCodePoint(cp);
      if (el.textContent !== glyph) {
        el.textContent = glyph;
      }
      if (!String(el.style.fontFamily || "").trim()) {
        el.style.fontFamily = '"QWeather Icons", "Noto Sans SC", "Microsoft YaHei", Arial, sans-serif';
      }
      if (!String(el.style.fontWeight || "").trim()) {
        el.style.fontWeight = "400";
      }
    });
  };

  const applyDataLayout = () => {
    if (renderMode === "web") return;
    const targets = document.querySelectorAll("[data-x], [data-y], [data-size], [data-width], [data-align], [data-weight], [data-color]");
    targets.forEach((el) => {
      const x = toNum(el.getAttribute("data-x"));
      const y = toNum(el.getAttribute("data-y"));
      const size = toNum(el.getAttribute("data-size"));
      const widthAttr = toNum(el.getAttribute("data-width"));
      const align = String(el.getAttribute("data-align") || "").trim().toLowerCase();
      const weight = String(el.getAttribute("data-weight") || "").trim();
      const color = String(el.getAttribute("data-color") || "").trim();

      if (x !== null || y !== null) {
        el.style.position = "absolute";
      }
      if (!String(el.style.boxSizing || "").trim()) {
        el.style.boxSizing = "border-box";
      }
      if (x !== null) {
        el.style.left = String(x) + "px";
      }
      if (y !== null) {
        el.style.top = String(y) + "px";
      }
      if (size !== null && size > 0) {
        el.style.fontSize = String(size) + "px";
      }
      if (weight) {
        el.style.fontWeight = weight;
      }
      if (align === "left" || align === "center" || align === "right") {
        el.style.textAlign = align;
      }
      if (color) {
        el.style.color = color;
      }

      if (widthAttr !== null && widthAttr > 0) {
        el.style.width = String(widthAttr) + "px";
        el.style.maxWidth = String(widthAttr) + "px";
      } else if (!String(el.style.width || "").trim() && x !== null) {
        const remain = Math.max(80, pageWidth - x - 24);
        el.style.width = String(remain) + "px";
        el.style.maxWidth = String(remain) + "px";
      }

      if (!String(el.style.whiteSpace || "").trim()) {
        el.style.whiteSpace = "pre-wrap";
      }
      if (!String(el.style.overflowWrap || "").trim()) {
        el.style.overflowWrap = "break-word";
      }
      if (!String(el.style.lineHeight || "").trim()) {
        el.style.lineHeight = "1.2";
      }
      debugState.mappedLegacyCount += 1;
    });
  };

  const executeDeferredScripts = async () => {
    if (!Array.isArray(deferredScripts) || !deferredScripts.length) return;
    const parent = document.body || document.documentElement;
    if (!parent) return;
    for (const item of deferredScripts) {
      const src = String(item && item.src ? item.src : "").trim();
      const contentRaw = String(item && item.content ? item.content : "");
      const type = String(item && item.type ? item.type : "").trim();
      if (src) {
        await new Promise((resolvePromise) => {
          try {
            const node = document.createElement("script");
            if (type) node.type = type;
            node.src = src;
            node.async = false;
            node.onload = () => resolvePromise();
            node.onerror = () => {
              debugState.deferredScriptErrors.push("load_failed:" + src);
              resolvePromise();
            };
            parent.appendChild(node);
          } catch (error) {
            debugState.deferredScriptErrors.push(String(error && error.message ? error.message : error));
            resolvePromise();
          }
        });
        continue;
      }
      if (!contentRaw.trim()) continue;
      try {
        const node = document.createElement("script");
        if (type) node.type = type;
        const resolvedContent = interpolate(contentRaw);
        node.text =
          "(function(){try{\\n" +
          resolvedContent +
          "\\n}catch(error){console.error('[page-render] inline script error', error);}})();";
        parent.appendChild(node);
      } catch (error) {
        debugState.deferredScriptErrors.push(String(error && error.message ? error.message : error));
      }
    }
  };

  const observeMutations = () => {
    if (!window.MutationObserver || renderState.observer) return;
    try {
      renderState.observer = new MutationObserver(() => {
        noteActivity();
      });
      const root = document.body || document.documentElement;
      if (root) {
        renderState.observer.observe(root, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }
    } catch (_) {
      renderState.observer = null;
    }
  };

  const run = async () => {
    applyBindings();
    applyDataLayout();
    applyWeatherIconBindings();
    await executeDeferredScripts();
    applyBindings();
    applyDataLayout();
    applyWeatherIconBindings();
    observeMutations();
    noteActivity();
    startHardTimeout();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      run().catch((error) => {
        console.error("[page-render] runtime run failed", error);
        finishReady("runtime-error");
      });
    }, { once: true });
  } else {
    run().catch((error) => {
      console.error("[page-render] runtime run failed", error);
      finishReady("runtime-error");
    });
  }
})();
</script>`;
}

function getQWeatherFontDataUrl() {
  if (qweatherFontDataUrl) return qweatherFontDataUrl;
  if (!fs.existsSync(QWEATHER_FONT_FILE)) return "";
  try {
    const file = fs.readFileSync(QWEATHER_FONT_FILE);
    qweatherFontDataUrl = `data:font/ttf;base64,${file.toString("base64")}`;
    return qweatherFontDataUrl;
  } catch (_) {
    return "";
  }
}

function buildBrowserPreviewDocument(rawHtml, dataModel, width, height, waitConfig, config) {
  const extracted = extractInlineScripts(rawHtml);
  const html = String(extracted.htmlWithoutScripts || "");
  const renderMode = normalizeRenderMode(config?.template?.render_mode, config?.template?.render_engine);
  const qweather = ensureQWeatherAssets();
  const runtimeScript = buildRuntimeModelScript(dataModel, width, height, waitConfig, {
    renderMode,
    renderEngine: config?.template?.render_engine,
    deferredScripts: extracted.scripts,
    qweatherIconMap: qweather?.map || {},
  });
  const qweatherFontUrl = getQWeatherFontDataUrl();
  const fontFaceStyle = qweatherFontUrl
    ? `@font-face{font-family:"QWeather Icons";src:url("${qweatherFontUrl}") format("truetype");font-display:swap;}`
    : "";
  const baseStyle = `
    ${fontFaceStyle}
    html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff;color:#000;}
    body{font-family:"PageRenderCJK","Noto Sans CJK SC","Noto Sans SC","WenQuanYi Zen Hei","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Arial,sans-serif;position:relative;}
    *,*::before,*::after{box-sizing:border-box;}
    #page-root{position:relative;width:${width}px;height:${height}px;overflow:hidden;}
    img{max-width:100%;height:auto;}
  `;

  if (/<html[\s>]/i.test(html)) {
    if (/<head[\s>]/i.test(html)) {
      return html.replace(
        /<head[^>]*>/i,
        (m) =>
          `${m}<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><style>${baseStyle}</style>${runtimeScript}`
      );
    }
    return html.replace(
      /<html[^>]*>/i,
      (m) =>
        `${m}<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><style>${baseStyle}</style>${runtimeScript}</head>`
    );
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${baseStyle}</style>
  ${runtimeScript}
</head>
<body>
  <div id="page-root" style="width:${width}px;height:${height}px;overflow:hidden;">${html}</div>
</body>
</html>`;
}

async function getPlaywrightModule() {
  if (playwrightModule) return playwrightModule;
  try {
    // Optional dependency for full HTML/CSS rendering.
    playwrightModule = require("playwright-core");
    return playwrightModule;
  } catch (_) {
    return null;
  }
}

async function getBrowserInstance() {
  if (browserLaunchPromise) return browserLaunchPromise;
  const launchTimeoutMs = Math.max(
    2500,
    parsePositiveInt(process.env.PAGE_RENDER_BROWSER_LAUNCH_TIMEOUT_MS, 7000)
  );
  const maxCandidateAttempts = Math.max(
    1,
    parsePositiveInt(process.env.PAGE_RENDER_BROWSER_MAX_CANDIDATES, 3)
  );
  const isFatalLinkerError = (error) =>
    /error while loading shared libraries|Failed to launch browser process|lib[a-z0-9_.-]+\.so/i.test(
      String(error?.message || error || "")
    );

  browserLaunchPromise = (async () => {
    const playwright = await getPlaywrightModule();
    if (!playwright || !playwright.chromium) {
      throw new Error("playwright-core not installed");
    }

    const launchArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"];
    const launchWithTimeout = async (options, label) => {
      let timer = null;
      let timedOut = false;
      const launchPromise = playwright.chromium.launch(options);
      const hardTimeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`browser launch hard-timeout after ${launchTimeoutMs}ms: ${label}`));
        }, launchTimeoutMs + 1200);
      });
      try {
        const instance = await Promise.race([launchPromise, hardTimeoutPromise]);
        if (timer) clearTimeout(timer);
        return instance;
      } catch (error) {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          launchPromise
            .then((instance) => instance && instance.close && instance.close().catch(() => {}))
            .catch(() => {});
        }
        throw error;
      }
    };

    let lastError = null;

    // 1) Prefer Playwright-managed browser path (PLAYWRIGHT_BROWSERS_PATH + playwright install).
    try {
      return await launchWithTimeout(
        {
          headless: true,
          timeout: launchTimeoutMs,
          args: launchArgs,
        },
        "playwright-managed"
      );
    } catch (error) {
      lastError = error;
    }

    // 2) Fallback to explicit executable candidates from env/system paths.
    const executables = getBrowserExecutableCandidates().slice(0, maxCandidateAttempts);
    for (const executablePath of executables) {
      try {
        return await launchWithTimeout(
          {
            headless: true,
            executablePath,
            timeout: launchTimeoutMs,
            args: launchArgs,
          },
          executablePath
        );
      } catch (error) {
        lastError = error;
        if (isFatalLinkerError(error)) break;
      }
    }

    throw (
      lastError ||
      new Error(
        "no chromium browser executable found; install via `npx playwright-core install chromium` or set CHROME_PATH/CHROME_BIN"
      )
    );
  })();

  try {
    const browser = await browserLaunchPromise;
    if (!browserCleanupHooked) {
      browserCleanupHooked = true;
      const cleanup = async () => {
        if (!browserLaunchPromise) return;
        try {
          const instance = await browserLaunchPromise;
          await instance.close();
        } catch (_) {
          // ignore
        } finally {
          browserLaunchPromise = null;
        }
      };
      process.once("beforeExit", cleanup);
      process.once("SIGINT", async () => {
        await cleanup();
        process.exit(0);
      });
      process.once("SIGTERM", async () => {
        await cleanup();
        process.exit(0);
      });
    }
    return browser;
  } catch (error) {
    browserLaunchPromise = null;
    throw error;
  }
}

async function renderWithBrowserEngine({ templateHtml, dataModel, width, height, config }) {
  const waitConfig = getBrowserRenderWaitConfig(config);
  const waitForReadyTimeoutMs = Math.max(waitConfig.readyTimeoutMs + waitConfig.idleSettleMs + 1500, 6000);
  const browser = await getBrowserInstance();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });

  try {
    const page = await context.newPage();
    const doc = buildBrowserPreviewDocument(templateHtml, dataModel, width, height, waitConfig, config);
    await page.setContent(doc, { waitUntil: "domcontentloaded" });
    let readyWaitError = null;
    await page
      .waitForFunction(() => window.__PAGE_RENDER_READY__ === true, undefined, { timeout: waitForReadyTimeoutMs })
      .catch((error) => {
        readyWaitError = error;
      });
    const readyMeta = await page.evaluate(() => {
      const state = window.__PAGE_RENDER_STATE__ || {};
      return {
        ready: Boolean(window.__PAGE_RENDER_READY__),
        reason: String(window.__PAGE_RENDER_READY_REASON__ || state.reason || ""),
        pending: Number(state.pending || 0),
        lastActivityDeltaMs: Number.isFinite(Number(state.lastActivityAt))
          ? Math.max(0, performance.now() - Number(state.lastActivityAt))
          : -1,
      };
    }).catch(() => ({ ready: false, reason: "", pending: -1, lastActivityDeltaMs: -1 }));
    await page.evaluate(async () => {
      if (document && document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    });
    await page.waitForTimeout(120);
    if (readyWaitError || readyMeta.reason === "timeout") {
      // eslint-disable-next-line no-console
      console.warn("[page-render] browser render settled by fallback", {
        ready: readyMeta.ready,
        reason: readyMeta.reason || "unknown",
        pending: readyMeta.pending,
        lastActivityDeltaMs: readyMeta.lastActivityDeltaMs,
        timeoutMs: waitForReadyTimeoutMs,
      });
    } else {
      // eslint-disable-next-line no-console
      console.info("[page-render] browser render ready", {
        reason: readyMeta.reason || "settled",
        pending: readyMeta.pending,
        lastActivityDeltaMs: readyMeta.lastActivityDeltaMs,
        timeoutMs: waitForReadyTimeoutMs,
      });
    }
    const runtimeDebug = await page
      .evaluate(() => window.__PAGE_RUNTIME_DEBUG__ || {})
      .catch(() => ({}));
    const debugEnabled = Boolean(config?.template?.debug);
    const missingCount = Number(runtimeDebug?.missingCount || 0);
    const scriptErrorCount = Array.isArray(runtimeDebug?.deferredScriptErrors)
      ? runtimeDebug.deferredScriptErrors.length
      : 0;
    if (debugEnabled || missingCount > 0 || scriptErrorCount > 0) {
      // eslint-disable-next-line no-console
      console.info("[page-render] runtime debug", {
        renderMode: runtimeDebug?.renderMode || "hybrid",
        missingCount,
        mappedLegacyCount: Number(runtimeDebug?.mappedLegacyCount || 0),
        replacedTextNodes: Number(runtimeDebug?.replacedTextNodes || 0),
        replacedAttributes: Number(runtimeDebug?.replacedAttributes || 0),
        deferredScriptCount: Number(runtimeDebug?.deferredScriptCount || 0),
        deferredScriptErrors: runtimeDebug?.deferredScriptErrors || [],
      });
    }
    return {
      pngBuffer: await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } }),
      runtimeDebug,
      readyMeta,
    };
  } finally {
    await context.close();
  }
}

function ensureQWeatherAssets() {
  if (!qweatherIconMap && fs.existsSync(QWEATHER_ICON_MAP_FILE)) {
    try {
      qweatherIconMap = JSON.parse(fs.readFileSync(QWEATHER_ICON_MAP_FILE, "utf8"));
    } catch (error) {
      qweatherIconMap = {};
      // eslint-disable-next-line no-console
      console.warn("[page-render] qweather icon map parse failed", {
        reason: error?.message || String(error),
      });
    }
  }
  if (!qweatherFontRegistered && fs.existsSync(QWEATHER_FONT_FILE)) {
    qweatherFontRegistered = registerCanvasFontCompat(QWEATHER_FONT_FILE, "QWeather Icons");
    if (!qweatherFontRegistered && !qweatherFontWarned) {
      qweatherFontWarned = true;
      // eslint-disable-next-line no-console
      console.warn("[page-render] qweather font registration skipped (canvas runtime does not expose registerFont)");
    }
  }
  return {
    available: isObject(qweatherIconMap),
    map: qweatherIconMap || {},
  };
}

function parseWeatherIcons(templateHtml, dataModel, width, height) {
  const icons = [];
  const regex = /<i([^>]*)>([\s\S]*?)<\/i>/gi;
  let match = regex.exec(templateHtml || "");
  while (match) {
    const attrs = parseAttributes(match[1]);
    const iconCodeRaw = interpolate(attrs["data-icon"] || "", dataModel).trim();
    const iconNameRaw = interpolate(attrs["data-icon-name"] || "", dataModel).trim();
    if (!iconCodeRaw && !iconNameRaw) {
      match = regex.exec(templateHtml || "");
      continue;
    }

    icons.push({
      code: iconCodeRaw,
      name: iconNameRaw,
      x: clamp(attrs["data-x"], 0, width, 120),
      y: clamp(attrs["data-y"], 0, height, 120),
      size: clamp(attrs["data-size"], 12, 360, 120),
      color: attrs["data-color"] || "#000000",
      align: normalizeAlign(attrs["data-align"], "left"),
      width: clamp(attrs["data-width"], 1, width, 280),
    });

    match = regex.exec(templateHtml || "");
  }

  return icons;
}

function resolveWeatherIconGlyph(item, iconMap) {
  const raw = String(item.code || "").trim();
  const name = String(item.name || "").trim();
  let codePoint = NaN;

  if (raw) {
    if (/^0x[0-9a-f]+$/i.test(raw)) {
      codePoint = parseInt(raw, 16);
    } else if (/^[0-9]+$/.test(raw)) {
      if (iconMap[raw] !== undefined) {
        codePoint = Number(iconMap[raw]);
      } else {
        codePoint = Number(raw);
      }
    } else if (iconMap[raw] !== undefined) {
      codePoint = Number(iconMap[raw]);
    }
  }

  if (!Number.isFinite(codePoint) && name && iconMap[name] !== undefined) {
    codePoint = Number(iconMap[name]);
  }

  if (!Number.isFinite(codePoint)) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch (_) {
    return "";
  }
}

function drawTextBlock(ctx, block) {
  const anchorX =
    block.align === "left" ? block.x : block.align === "right" ? block.x + block.maxWidth : block.x + Math.floor(block.maxWidth / 2);
  ctx.textAlign = block.align;
  ctx.textBaseline = "top";
  ctx.fillStyle = block.color;
  ctx.font = `${block.weight} ${block.fontSize}px "PageRenderCJK", "Noto Sans CJK SC", "Noto Sans SC", "WenQuanYi Zen Hei", "Microsoft YaHei", sans-serif`;
  ctx.fillText(block.text, anchorX, block.y, block.maxWidth);
}

function parseTemplateImages(templateHtml, dataModel, width, height) {
  const images = [];
  const regex = /<img([^>]*)\/?\s*>/gi;
  let match = regex.exec(templateHtml || "");
  while (match) {
    const attrs = parseAttributes(match[1]);
    const src = interpolate(attrs.src || attrs["data-src"] || "", dataModel).trim();
    if (!src) {
      match = regex.exec(templateHtml || "");
      continue;
    }

    const imgWidth = clamp(attrs["data-width"] || attrs.width, 1, width, width);
    const imgHeight = clamp(attrs["data-height"] || attrs.height, 1, height, height);
    images.push({
      src,
      x: clamp(attrs["data-x"], 0, width, 0),
      y: clamp(attrs["data-y"], 0, height, 0),
      width: imgWidth,
      height: imgHeight,
      opacity: clamp(attrs["data-opacity"], 0, 1, 1),
    });
    match = regex.exec(templateHtml || "");
  }
  return images;
}

async function loadTemplateImage(src) {
  const text = String(src || "").trim();
  if (!text) return null;

  if (text.startsWith("data:")) {
    const comma = text.indexOf(",");
    if (comma <= 0) return null;
    const meta = text.slice(0, comma);
    const payload = text.slice(comma + 1);
    if (meta.includes(";base64")) {
      const buf = Buffer.from(payload, "base64");
      return await loadImage(buf);
    }
    const buf = Buffer.from(decodeURIComponent(payload), "utf8");
    return await loadImage(buf);
  }

  if (fs.existsSync(text)) {
    return await loadImage(text);
  }

  return null;
}

async function drawTemplateImages(ctx, templateHtml, dataModel, width, height) {
  const images = parseTemplateImages(templateHtml, dataModel, width, height);
  let drawnCount = 0;
  for (const item of images) {
    try {
      const image = await loadTemplateImage(item.src);
      if (!image) continue;
      ctx.save();
      ctx.globalAlpha = item.opacity;
      ctx.drawImage(image, item.x, item.y, item.width, item.height);
      ctx.restore();
      drawnCount += 1;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[page-render] draw image failed", {
        src: String(item.src || "").slice(0, 96),
        err: error?.message || String(error),
      });
    }
  }
  return drawnCount;
}

function drawHtmlTextFallback(ctx, templateHtml, dataModel, width, height) {
  const plain = stripTags(interpolate(String(templateHtml || ""), dataModel || {}));
  if (!plain) return false;

  const maxCharsPerLine = Math.max(16, Math.floor(width / 26));
  const lines = [];
  plain.split(/\n+/).forEach((rawLine) => {
    const line = String(rawLine || "").trim();
    if (!line) return;
    if (line.length <= maxCharsPerLine) {
      lines.push(line);
      return;
    }
    for (let i = 0; i < line.length; i += maxCharsPerLine) {
      lines.push(line.slice(i, i + maxCharsPerLine));
    }
  });

  if (!lines.length) return false;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#111111";
  ctx.font = `500 46px "PageRenderCJK", "Noto Sans CJK SC", "Noto Sans SC", "WenQuanYi Zen Hei", "Microsoft YaHei", sans-serif`;

  const startX = 96;
  let y = 96;
  const lineHeight = 58;
  for (const line of lines.slice(0, 80)) {
    if (y > height - 80) break;
    ctx.fillText(line, startX, y, width - startX * 2);
    y += lineHeight;
  }
  return true;
}

function drawWeatherIcons(ctx, templateHtml, dataModel, width, height) {
  const qweather = ensureQWeatherAssets();
  if (!qweather.available) return;

  const icons = parseWeatherIcons(templateHtml, dataModel, width, height);
  icons.forEach((item) => {
    const glyph = resolveWeatherIconGlyph(item, qweather.map);
    if (!glyph) return;

    const anchorX = item.align === "left" ? item.x : item.align === "right" ? item.x + item.width : item.x + Math.floor(item.width / 2);
    ctx.textAlign = item.align;
    ctx.textBaseline = "top";
    ctx.fillStyle = item.color;
    ctx.font = `400 ${item.size}px "QWeather Icons", "Noto Sans SC", sans-serif`;
    ctx.fillText(glyph, anchorX, item.y, item.width);
  });
}

function reserveTimeOverlay(ctx, config) {
  const overlay = config.time_overlay || {};
  if (!overlay.enabled) return;
  const mode = String(overlay.background_clear_mode || "").toLowerCase();
  const reserveRegion = overlay.reserve_region === true || mode === "reserve";
  if (!reserveRegion) return;

  const x = Number(overlay.x || 0);
  const y = Number(overlay.y || 0);
  const w = Number(overlay.width || 0);
  const h = Number(overlay.height || 0);
  if (w <= 0 || h <= 0) return;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);
}

function rgbaToEpd4(rgba, width, height) {
  const rowsPadding = width % 2 ? 1 : 0;
  const bytes = Math.ceil(((width + rowsPadding) * height) / 2);
  const output = Buffer.alloc(bytes, 0xff);
  let valueIndex = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
            const srcR = rgba[idx] ?? 255;
      const srcG = rgba[idx + 1] ?? 255;
      const srcB = rgba[idx + 2] ?? 255;
      const alpha = rgba[idx + 3] ?? 255;
      /* Composite source over white background before gray quantization.
       * Important: channel value 0 is valid black and must NOT fallback to 255.
       */
      const r = Math.round((srcR * alpha + 255 * (255 - alpha)) / 255);
      const g = Math.round((srcG * alpha + 255 * (255 - alpha)) / 255);
      const b = Math.round((srcB * alpha + 255 * (255 - alpha)) / 255);
      const luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      const nibble = clamp(Math.round(luminance / 17), 0, 15, 15);
      const byteIndex = Math.floor(valueIndex / 2);
      if (valueIndex % 2 === 0) {
        output[byteIndex] = (output[byteIndex] & 0xf0) | (nibble & 0x0f);
      } else {
        output[byteIndex] = (output[byteIndex] & 0x0f) | ((nibble & 0x0f) << 4);
      }
      valueIndex += 1;
    }
    if (width % 2) valueIndex += 1;
  }

  return output;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function uploadTfBlob({ ownerId, category, fileName, mime, buffer, source }) {
  const recordId = createId("tf");
  const filename = `${recordId}_${fileName}`;
  const bucket = await getGridBucket("tf_files");
  const sha256 = sha256Hex(buffer);

  const uploadStream = bucket.openUploadStream(filename, {
    contentType: mime || "application/octet-stream",
    metadata: {
      ownerId,
      category,
      source: source || "page",
      originalName: fileName,
      sha256,
    },
  });

  const gridId = await new Promise((resolve, reject) => {
    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(uploadStream.id));
    uploadStream.end(buffer);
  });

  const now = new Date().toISOString();
  return {
    id: recordId,
    ownerId,
    category,
    name: filename,
    originalName: fileName,
    size: buffer.length,
    mime: mime || "application/octet-stream",
    gridId: String(gridId),
    url: `/api/tf/${recordId}/download`,
    sha256,
    createdAt: now,
    updatedAt: now,
  };
}

function ensureDefaultTemplate(db, options) {
  const key = templateKeyForPage(options.pageType);
  db[key] = Array.isArray(db[key]) ? db[key] : [];

  const builtin = db[key].find((row) => row.id === options.defaultTemplateId);
  if (builtin) return builtin;

  const now = new Date().toISOString();
  const row = {
    id: options.defaultTemplateId,
    ownerId: "",
    name: options.defaultTemplateName,
    type: "default_html",
    html: options.defaultTemplateHtml,
    builtin: true,
    createdAt: now,
    updatedAt: now,
  };
  db[key].unshift(row);
  return row;
}

function listTemplates(db, auth, options) {
  const key = templateKeyForPage(options.pageType);
  db[key] = Array.isArray(db[key]) ? db[key] : [];
  ensureDefaultTemplate(db, options);

  const rows = db[key].filter((item) => {
    if (item.builtin) return true;
    if (auth?.role === "admin") return true;
    return String(item.ownerId || "") === String(auth?.userId || "");
  });

  return rows
    .map((item) => ({
      id: String(item.id || ""),
      ownerId: String(item.ownerId || ""),
      name: String(item.name || ""),
      type: String(item.type || "custom_html"),
      html: String(item.html || ""),
      builtin: Boolean(item.builtin),
      updatedAt: String(item.updatedAt || item.createdAt || ""),
      createdAt: String(item.createdAt || ""),
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function resolveTemplateHtml(db, config, auth, options) {
  const key = templateKeyForPage(options.pageType);
  db[key] = Array.isArray(db[key]) ? db[key] : [];
  ensureDefaultTemplate(db, options);

  const templateId = String(config?.template?.template_id || options.defaultTemplateId);
  let row = db[key].find((item) => String(item.id || "") === templateId);
  if (!row && templateId !== options.defaultTemplateId) {
    row = db[key].find((item) => String(item.id || "") === options.defaultTemplateId);
  }
  if (!row) {
    row = {
      id: options.defaultTemplateId,
      ownerId: "",
      name: options.defaultTemplateName,
      type: "default_html",
      html: options.defaultTemplateHtml,
      builtin: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const isAllowed = row.builtin || auth?.role === "admin" || String(row.ownerId || "") === String(auth?.userId || "");
  if (!isAllowed) throw new HttpError(403, "无权限访问该模板");

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    html: String(row.html || options.defaultTemplateHtml),
    builtin: Boolean(row.builtin),
  };
}

function buildCommonDataModel(db, device, extraData) {
  const todoRows = (db.todos || []).filter((item) => String(item.deviceId || "") === String(device.id || ""));
  const scheduleRows = (db.schedules || []).filter((item) => String(item.deviceId || "") === String(device.id || ""));
  const WEEKDAY_LABELS = [1, 2, 3, 4, 5, 6, 7].map((day) => WEEKDAY_LABEL_MAP[day] || "Monday");

  const todoOpen = todoRows.filter((item) => !item.done);
  const todoSummary = todoOpen.length
    ? `Open ${todoOpen.length}, next: ${String(todoOpen[0].content || "-").slice(0, 40)}`
    : "No pending TODO";

  const scheduleSummary = scheduleRows.length
    ? `${scheduleRows.length} items, next: ${String(scheduleRows[0].title || "-").slice(0, 40)}`
    : "No schedule";

  const profile = {
    name: String(device.displayName || device.mac || device.id || "Unnamed Device"),
    title: String(device.remark || "Smart E-Ink Device"),
    department: "Device Platform",
    workstation: String(device.id || ""),
    employee_no: String(device.id || "").slice(-8),
    status: device.online ? "online" : "offline",
  };

  const thirdCacheRaw =
    device?.thirdApiCache && typeof device.thirdApiCache === "object" && !Array.isArray(device.thirdApiCache)
      ? device.thirdApiCache
      : {};
  const third = {};
  const thirdFormatted = {};
  const thirdRaw = {};

  const normalizeWeekday = (value, slotKey = "") => {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 1 && num <= 7) return Math.floor(num);
    const match = String(slotKey || "").match(/^([1-7])-/);
    return match?.[1] ? Number(match[1]) : 1;
  };

  const normalizePeriod = (value, fallback = 1) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
  };

  const buildDerivedXiqueFromSchedules = (rows) => {
    if (!Array.isArray(rows) || !rows.length) return null;
    const xiqueRows = rows.filter((row) => String(row?.source || "").trim().toLowerCase() === "xique");
    if (!xiqueRows.length) return null;

    const termKey = xiqueRows
      .map((item) => String(item?.termKey || "").trim())
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a))[0] || "";
    const termRows = termKey
      ? xiqueRows.filter((item) => String(item?.termKey || "").trim() === termKey)
      : xiqueRows;
    const syncConfigs = Array.isArray(db?.scheduleSyncConfigs) ? db.scheduleSyncConfigs : [];
    const targetConfig =
      syncConfigs.find(
        (item) =>
          String(item?.deviceId || "") === String(device.id || "") &&
          String(item?.currentTermKey || "") === String(termKey || "")
      ) ||
      syncConfigs.find((item) => String(item?.deviceId || "") === String(device.id || "")) ||
      null;
    const getLocalDateKey = (date = new Date()) => {
      try {
        return new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone || "Asia/Shanghai" }).format(date);
      } catch (_) {
        return new Intl.DateTimeFormat("en-CA").format(date);
      }
    };
    const nowDateKey = getLocalDateKey(new Date());
    const cfgWeekDateKey = targetConfig?.currentWeekAt ? getLocalDateKey(new Date(targetConfig.currentWeekAt)) : "";
    const rowWeekCandidates = [];
    termRows.forEach((row) => {
      const sourceMeta = row?.sourceMeta && typeof row.sourceMeta === "object" ? row.sourceMeta : {};
      rowWeekCandidates.push(
        row?.currentWeek,
        row?.weekIndex,
        row?.teachingWeek,
        sourceMeta.currentWeek,
        sourceMeta.weekIndex,
        sourceMeta.teachingWeek
      );
      const fromText = extractCurrentWeekFromText(row?.content || row?.note || "");
      if (fromText) rowWeekCandidates.push(fromText);
    });
    const weekContext = resolveTeachingWeekContext({
      now: new Date(),
      timezone: config.timezone || "Asia/Shanghai",
      currentWeekCandidates: [
        ...rowWeekCandidates,
        ...(cfgWeekDateKey && cfgWeekDateKey === nowDateKey
          ? [
              targetConfig?.currentWeek,
              targetConfig?.weekIndex,
              targetConfig?.teachingWeek,
              targetConfig?.academicWeek,
              targetConfig?.schoolWeek,
            ]
          : []),
      ],
      termStartDateCandidates: [
        termRows[0]?.termStartDate,
        termRows[0]?.sourceMeta?.termStartDate,
        targetConfig?.termStartDate,
        targetConfig?.semesterStart,
        targetConfig?.startDate,
      ],
      fallbackTermStartDate: "",
    });
    const termStartDate = normalizeTermStartDate(weekContext.termStartDate || "");
    const currentWeek = Number.isFinite(Number(weekContext.currentWeek || 0))
      ? Math.floor(Number(weekContext.currentWeek))
      : null;
    const canFilterByWeek = Boolean(weekContext.weekFilteringApplied && currentWeek);

    const normalizedAll = termRows
      .map((row) => {
        const slotKeyRaw = String(row?.position?.slotKey || row?.sourceKey || "");
        const startPeriod = normalizePeriod(
          row?.position?.startPeriod || row?.orderIndex || row?.sourceMeta?.startPeriod,
          1
        );
        const endPeriod = normalizePeriod(row?.position?.endPeriod, startPeriod);
        const weekday = normalizeWeekday(row?.weekday, slotKeyRaw || `${startPeriod}-${endPeriod}`);
        const weekdayLabel = WEEKDAY_LABELS[weekday - 1] || "Monday";
        const sourceMeta = row?.sourceMeta && typeof row.sourceMeta === "object" ? row.sourceMeta : {};
        const weeks = normalizeWeeksArray(
          Array.isArray(row?.weeks) ? row.weeks : (Array.isArray(sourceMeta.weeks) ? sourceMeta.weeks : [])
        );
        const weekRule = String(row?.weekRule || sourceMeta.weekRule || (weeks.length ? "custom" : "all")).trim() || "all";
        const isActiveThisWeek = isCourseActiveInWeek(weeks, currentWeek);
        return {
          id: String(row?.id || ""),
          courseName: String(row?.courseName || row?.title || ""),
          title: String(row?.title || row?.courseName || row?.content || ""),
          teacherName: String(row?.teacherName || row?.teacher || sourceMeta.teacherName || ""),
          location: String(row?.location || sourceMeta.location || ""),
          weekday,
          weekdayLabel,
          weeks,
          weekRule,
          isActiveThisWeek,
          position: {
            startPeriod,
            endPeriod,
            slotKey: `${weekday}-${startPeriod}-${endPeriod}`,
          },
          timeRange: {
            startTime: String(row?.timeRange?.startTime || row?.startTime || ""),
            endTime: String(row?.timeRange?.endTime || row?.endTime || ""),
          },
          termKey: String(row?.termKey || ""),
        };
      })
      .sort((a, b) => {
        if (a.weekday !== b.weekday) return a.weekday - b.weekday;
        if (a.position.startPeriod !== b.position.startPeriod) return a.position.startPeriod - b.position.startPeriod;
        if (a.position.endPeriod !== b.position.endPeriod) return a.position.endPeriod - b.position.endPeriod;
        return String(a.title || "").localeCompare(String(b.title || ""));
      });

    const normalized = canFilterByWeek
      ? normalizedAll.filter((course) => course.isActiveThisWeek)
      : normalizedAll;

    const byDayMap = new Map();
    const bySlotMap = new Map();
    normalized.forEach((course) => {
      const day = byDayMap.get(course.weekday) || {
        weekday: course.weekday,
        weekdayLabel: course.weekdayLabel,
        count: 0,
        courses: [],
      };
      day.courses.push({
        id: course.id,
        courseName: course.courseName,
        title: course.title,
        teacherName: course.teacherName,
        location: course.location,
        weekday: course.weekday,
        weekdayLabel: course.weekdayLabel,
        weeks: course.weeks,
        weekRule: course.weekRule,
        isActiveThisWeek: course.isActiveThisWeek,
        position: { ...course.position },
        timeRange: { ...course.timeRange },
      });
      day.count = day.courses.length;
      byDayMap.set(course.weekday, day);

      const slot = bySlotMap.get(course.position.slotKey) || {
        slotKey: course.position.slotKey,
        weekday: course.weekday,
        weekdayLabel: course.weekdayLabel,
        startPeriod: course.position.startPeriod,
        endPeriod: course.position.endPeriod,
        courses: [],
      };
      slot.courses.push({
        id: course.id,
        title: course.title,
        teacherName: course.teacherName,
        location: course.location,
        weeks: course.weeks,
        weekRule: course.weekRule,
        isActiveThisWeek: course.isActiveThisWeek,
        timeRange: { ...course.timeRange },
      });
      bySlotMap.set(course.position.slotKey, slot);
    });

    const byDay = [];
    for (let day = 1; day <= 7; day += 1) {
      const row = byDayMap.get(day) || {
        weekday: day,
        weekdayLabel: WEEKDAY_LABELS[day - 1] || "Monday",
        count: 0,
        courses: [],
      };
      byDay.push(row);
    }
    const bySlot = [...bySlotMap.values()].sort((a, b) => {
      if (a.weekday !== b.weekday) return a.weekday - b.weekday;
      if (a.startPeriod !== b.startPeriod) return a.startPeriod - b.startPeriod;
      return a.endPeriod - b.endPeriod;
    });

    const todayWeekday = ((new Date().getDay() + 6) % 7) + 1;
    const todayWeekdayLabel = WEEKDAY_LABELS[todayWeekday - 1] || "Monday";
    const todayDay = byDay.find((item) => Number(item.weekday || 0) === todayWeekday);
    const todayCourses = (todayDay?.courses || []).map((item) => {
      const startTime = String(item?.timeRange?.startTime || "");
      const endTime = String(item?.timeRange?.endTime || "");
      return {
        title: String(item?.title || item?.courseName || ""),
        teacherName: String(item?.teacherName || ""),
        location: String(item?.location || ""),
        startTime,
        endTime,
        timeText: `${startTime || "-"}-${endTime || "-"}`,
      };
    });
    const todayCourseText = todayCourses.length
      ? todayCourses
          .map(
            (item, index) =>
              `${index + 1}. ${item.timeText}\n${item.title || "-"}｜${item.teacherName || "-"}｜${item.location || "-"}`
          )
          .join("\n\n")
      : "今天没有课程";

    return {
      status: "derived_from_schedule",
      termKey,
      imported: normalized.length,
      added: 0,
      updated: 0,
      skipped: 0,
      overwritten: 0,
      needCaptchaReverify: false,
      needManualCaptcha: false,
      taskId: "",
      captchaSession: "",
      captchaImage: "",
      captchaExpiresAt: "",
      loginUsername: "",
        schedule: {
          schema: "xique_schedule_v1",
          deviceId: String(device.id || ""),
          termKey,
          termStartDate,
          currentWeek: canFilterByWeek ? Number(currentWeek) : null,
          currentWeekSource: canFilterByWeek ? String(weekContext.currentWeekSource || "") : "",
          weekFilteringApplied: canFilterByWeek,
        totalCoursesRaw: normalizedAll.length,
        totalCourses: normalized.length,
        byDay,
        bySlot,
        courses: normalized.map((item) => ({
          id: item.id,
          courseName: item.courseName,
          title: item.title,
          teacherName: item.teacherName,
          location: item.location,
          weekday: item.weekday,
          weekdayLabel: item.weekdayLabel,
          weeks: item.weeks,
          weekRule: item.weekRule,
          isActiveThisWeek: item.isActiveThisWeek,
          position: { ...item.position },
          timeRange: { ...item.timeRange },
        })),
        generatedAt: new Date().toISOString(),
      },
      view: {
        todayWeekday,
        todayWeekdayLabel,
        currentWeek: canFilterByWeek ? Number(currentWeek) : null,
        currentWeekSource: canFilterByWeek ? String(weekContext.currentWeekSource || "") : "",
        termStartDate,
        weekFilteringApplied: canFilterByWeek,
        todayCourseCount: todayCourses.length,
        todayCourses,
        todayCourseText,
        hasCourseToday: todayCourses.length > 0,
      },
    };
  };

  const derivedXiqueFormatted = buildDerivedXiqueFromSchedules(scheduleRows);
  const apiTemplateCatalog = Array.isArray(db?.apiTemplates)
    ? db.apiTemplates
        .filter((row) => row && typeof row === "object" && !Array.isArray(row) && String(row.slug || "").trim())
        .map((row) => ({
          slug: String(row.slug || "").trim(),
          name: String(row.name || row.slug || "").trim(),
          enabled: row.enabled !== false,
        }))
    : [];
  Object.keys(thirdCacheRaw).forEach((slug) => {
    const row = thirdCacheRaw[slug];
    if (!row || typeof row !== "object" || Array.isArray(row)) return;

    const formatted =
      row.formatted !== undefined
        ? row.formatted
        : row.raw && typeof row.raw === "object" && !Array.isArray(row.raw)
          ? row.raw.output
          : null;
    const raw =
      row.raw && typeof row.raw === "object" && !Array.isArray(row.raw)
        ? row.raw
        : {
            output: formatted,
          };

    third[slug] = {
      template:
        row.template && typeof row.template === "object" && !Array.isArray(row.template)
          ? row.template
          : { slug, name: slug },
      formatted: formatted === undefined ? null : formatted,
      raw,
      updated_at: String(row.updatedAt || row.updated_at || ""),
    };
    thirdFormatted[slug] = formatted === undefined ? null : formatted;
    thirdRaw[slug] = raw;
  });

  // Keep Weather API variables visible in template-variable panel even before
  // a device has an explicit thirdApiCache.weather entry.
  if (!third.weather) {
    const weatherFormatted = {
      temperature: "",
      humidity: "",
      weather: "",
      windDir: "",
      windScale: "",
      observeTime: "",
      location: "",
      hourly: [],
      daily: [],
    };
    third.weather = {
      template: { slug: "weather", name: "和风天气" },
      formatted: weatherFormatted,
      raw: { output: weatherFormatted },
      updated_at: new Date().toISOString(),
    };
    thirdFormatted.weather = weatherFormatted;
    thirdRaw.weather = { output: weatherFormatted };
  }

  const xiqueFormattedSkeleton = {
    status: "",
    termKey: "",
    imported: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    overwritten: 0,
    needCaptchaReverify: false,
    needManualCaptcha: false,
    taskId: "",
    captchaSession: "",
    captchaImage: "",
    captchaExpiresAt: "",
    loginUsername: "",
    schedule: {
      schema: "xique_schedule_v1",
      deviceId: String(device.id || ""),
      termKey: "",
      termStartDate: "",
      currentWeek: null,
      currentWeekSource: "",
      weekFilteringApplied: false,
      totalCoursesRaw: 0,
      totalCourses: 0,
      byDay: [],
      bySlot: [],
      courses: [],
      generatedAt: new Date().toISOString(),
    },
    view: {
      todayWeekday: ((new Date().getDay() + 6) % 7) + 1,
      todayWeekdayLabel: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][
        ((new Date().getDay() + 6) % 7)
      ],
      currentWeek: null,
      currentWeekSource: "",
      termStartDate: "",
      weekFilteringApplied: false,
      todayCourseCount: 0,
      todayCourses: [],
      todayCourseText: "xique schedule not imported",
      hasCourseToday: false,
    },
  };

  apiTemplateCatalog
    .filter((tpl) => tpl.enabled)
    .forEach((tpl) => {
      const slug = String(tpl.slug || "").trim();
      if (!slug) return;
      if (!third[slug]) {
        const fallbackFormatted = slug === "xique_schedule" ? (derivedXiqueFormatted || xiqueFormattedSkeleton) : {};
        third[slug] = {
          template: { slug, name: String(tpl.name || slug) },
          formatted: fallbackFormatted,
          raw: { output: fallbackFormatted },
          updated_at: "",
        };
        thirdFormatted[slug] = fallbackFormatted;
        thirdRaw[slug] = { output: fallbackFormatted };
        return;
      }

      if (!third[slug].template || typeof third[slug].template !== "object") {
        third[slug].template = { slug, name: String(tpl.name || slug) };
      } else {
        if (!String(third[slug].template.slug || "").trim()) third[slug].template.slug = slug;
      if (!String(third[slug].template.name || "").trim()) third[slug].template.name = String(tpl.name || slug);
      }
    });

  // Compatibility layer:
  // - current path: api.formatted_by_slug.<slug>.<field>
  // - legacy path:  api.formatted_by_slug.<slug>.formatted.<field>
  const apiFormattedBySlug = {};
  Object.keys(thirdFormatted).forEach((slug) => {
    const formattedValue = thirdFormatted[slug];
    if (isObject(formattedValue)) {
      apiFormattedBySlug[slug] = {
        ...formattedValue,
        formatted: formattedValue,
        raw: thirdRaw[slug],
        template: third?.[slug]?.template || { slug, name: slug },
      };
      return;
    }

    apiFormattedBySlug[slug] = {
      value: formattedValue,
      formatted: formattedValue,
      raw: thirdRaw[slug],
      template: third?.[slug]?.template || { slug, name: slug },
    };
  });

  const model = {
    profile,
    todo_summary: {
      count: todoOpen.length,
      text: todoSummary,
    },
    schedule_summary: {
      count: scheduleRows.length,
      text: scheduleSummary,
    },
    weather: {
      code: "100",
      text: "Sunny",
      temp: "26",
      aqi: "42",
      humidity: "43",
      city: "Shanghai",
      updated_at: new Date().toISOString(),
    },
    third,
    third_formatted: thirdFormatted,
    third_raw: thirdRaw,
    formatted_by_slug: apiFormattedBySlug,
    api: {
      third,
      formatted_by_slug: apiFormattedBySlug,
      raw_by_slug: thirdRaw,
    },
    custom_fields: isObject(extraData?.custom_fields) ? extraData.custom_fields : {},
    meta: {
      rendered_at: new Date().toISOString(),
      device_id: String(device.id || ""),
      backend: "render-service",
    },
  };

  Object.keys(thirdFormatted).forEach((slug) => {
    if (model[slug] === undefined) {
      model[slug] = thirdFormatted[slug];
    }
  });

  const latestSlug = Object.keys(third)
    .sort((a, b) => String(third[b]?.updated_at || "").localeCompare(String(third[a]?.updated_at || "")))[0];
  if (latestSlug) {
    model.third_latest = third[latestSlug];
    model.api.latest = third[latestSlug];
    if (model.formatted === undefined) {
      model.formatted = third[latestSlug].formatted;
    }
    if (model.raw === undefined) {
      model.raw = third[latestSlug].raw;
    }
  }

  if (isObject(extraData)) return deepMerge(model, extraData);
  return model;
}

async function renderPageBuffers({ config, templateHtml, dataModel, pageType }) {
  ensureSystemFontsLoaded();

  const width = Number(config.screen?.width || 2560);
  const height = Number(config.screen?.height || 1600);
  const renderMode = normalizeRenderMode(config?.template?.render_mode, config?.template?.render_engine);
  const placeholderDebug = collectPlaceholderDebug(templateHtml, dataModel);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  let browserRendered = false;
  let browserDebug = null;
  const useBrowser = shouldUseBrowserRender(templateHtml, config);
  const browserStrict =
    String(config?.template?.browser_strict ?? process.env.PAGE_RENDER_BROWSER_STRICT ?? "0").trim().toLowerCase() === "1" ||
    String(config?.template?.browser_strict ?? process.env.PAGE_RENDER_BROWSER_STRICT ?? "0").trim().toLowerCase() === "true";
  const forceBrowser =
    renderMode === "web" ||
    (renderMode !== "legacy" && /<script[\s>]/i.test(String(templateHtml || "")));
  const browserTotalTimeoutMs = Math.max(
    4000,
    parsePositiveInt(
      config?.template?.browser_total_timeout_ms ?? process.env.PAGE_RENDER_BROWSER_TOTAL_TIMEOUT_MS,
      12000
    )
  );

  if (useBrowser) {
    try {
      const browserResult = await withPromiseTimeout(
        renderWithBrowserEngine({ templateHtml, dataModel, width, height, config }),
        browserTotalTimeoutMs,
        `browser render timeout after ${browserTotalTimeoutMs}ms`
      );
      const browserImage = await loadImage(browserResult.pngBuffer);
      ctx.drawImage(browserImage, 0, 0, width, height);
      browserRendered = true;
      browserDebug = browserResult.runtimeDebug || null;
    } catch (error) {
      if (forceBrowser && browserStrict) {
        throw new HttpError(500, `browser render failed: ${error?.message || String(error)}`);
      }
      // eslint-disable-next-line no-console
      console.warn("[page-render] browser engine fallback to legacy", {
        pageType: normalizePageType(pageType),
        forceBrowser,
        browserStrict,
        reason: error?.message || String(error),
      });
    }
  }

  if (!browserRendered) {
    const imageCount = await drawTemplateImages(ctx, templateHtml, dataModel, width, height);

    const blocks = parseTemplateBlocks(templateHtml, dataModel, width, height);
    if (blocks.length) {
      blocks.forEach((block) => drawTextBlock(ctx, block));
    }

    if (normalizePageType(pageType) === "weatherpage") {
      drawWeatherIcons(ctx, templateHtml, dataModel, width, height);
    }

    // If browser render is unavailable and template is pure standard HTML
    // (without legacy data-* blocks), avoid blank white preview by drawing
    // a readable text fallback.
    if (!blocks.length && imageCount === 0) {
      drawHtmlTextFallback(ctx, templateHtml, dataModel, width, height);
    }
  }

  reserveTimeOverlay(ctx, config);
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, width - 2, height - 2);

  const pngBuffer = await canvas.encode("png");
  const imageData = ctx.getImageData(0, 0, width, height);
  const epd4Buffer = rgbaToEpd4(imageData.data, width, height);
  const etag = sha256Hex(epd4Buffer);

  return {
    width,
    height,
    pngBuffer,
    epd4Buffer,
    etag,
    debug: {
      pageType: normalizePageType(pageType),
      render_engine: String(config?.template?.render_engine || "auto"),
      render_mode: renderMode,
      browserRendered,
      placeholder: placeholderDebug,
      browser: browserDebug || {},
    },
  };
}

function resolvePageConfig(db, ownerId, deviceId, options) {
  const key = configKeyForPage(options.pageType);
  db[key] = Array.isArray(db[key]) ? db[key] : [];

  const normalizedOwnerId = String(ownerId || "");
  const normalizedDeviceId = String(deviceId || "");

  const globalRow = db[key]
    .filter((item) => String(item.ownerId || "") === normalizedOwnerId && !item.deviceId)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];

  const deviceRow = db[key]
    .filter(
      (item) => String(item.ownerId || "") === normalizedOwnerId && String(item.deviceId || "") === normalizedDeviceId
    )
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];

  let merged = normalizePageConfig(options.loadDefaultConfig(), options.loadDefaultConfig(), options.pageType);
  if (globalRow?.config) merged = normalizePageConfig(deepMerge(merged, globalRow.config), options.loadDefaultConfig(), options.pageType);
  if (deviceRow?.config) merged = normalizePageConfig(deepMerge(merged, deviceRow.config), options.loadDefaultConfig(), options.pageType);

  const versionBase = Math.max(Number(globalRow?.version || 0), Number(deviceRow?.version || 0), Number(merged.version || 1));
  merged.version = versionBase || 1;

  return {
    config: merged,
    globalRow: globalRow || null,
    deviceRow: deviceRow || null,
  };
}

function getLatestPageImage(db, deviceId, options) {
  const key = imageKeyForPage(options.pageType);
  db[key] = Array.isArray(db[key]) ? db[key] : [];

  const rows = db[key]
    .filter((item) => String(item.deviceId || "") === String(deviceId || ""))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return rows[0] || null;
}

function buildDevicePagePayload({ deviceId, config, imageRow, options }) {
  return {
    id: config.id,
    page_type: normalizePageType(options.pageType),
    name: config.name,
    version: Number(config.version || 1),
    screen: deepClone(config.screen || {}),
    template: {
      type: String(config.template?.type || "default_html"),
      template_id: String(config.template?.template_id || options.defaultTemplateId),
      template_name: String(config.template?.template_name || options.defaultTemplateName),
      render_engine: String(config.template?.render_engine || "auto"),
      render_mode: normalizeRenderMode(config.template?.render_mode, config.template?.render_engine),
    },
    image: {
      format: String(config.image?.format || "epd4"),
      preview_format: String(config.image?.preview_format || "png"),
      render_source: String(config.image?.render_source || "server"),
      cache_ttl_sec: Number(config.image?.cache_ttl_sec || 3600),
      refresh_policy: String(config.image?.refresh_policy || "on-demand"),
      image_id: imageRow ? String(imageRow.imageFileId || "") : "",
      image_url: imageRow ? `/api/hardware/tf/download/${String(imageRow.imageFileId || "")}` : "",
      admin_image_url: imageRow ? `/api/tf/${String(imageRow.imageFileId || "")}/download` : "",
      preview_id: imageRow ? String(imageRow.previewFileId || "") : "",
      preview_url: imageRow ? `/api/hardware/tf/download/${String(imageRow.previewFileId || "")}` : "",
      admin_preview_url: imageRow ? `/api/tf/${String(imageRow.previewFileId || "")}/download` : "",
      image_width: imageRow ? Number(imageRow.width || config.screen?.width || 0) : Number(config.screen?.width || 0),
      image_height: imageRow ? Number(imageRow.height || config.screen?.height || 0) : Number(config.screen?.height || 0),
      etag: imageRow ? String(imageRow.etag || "") : "",
      updated_at: imageRow ? String(imageRow.updatedAt || "") : "",
      image_key: imageRow ? String(imageRow.imageFileId || "") : "",
    },
    auto_render_push: deepClone(config.auto_render_push || {}),
    time_overlay: deepClone(config.time_overlay || {}),
    refresh_control: deepClone(config.refresh_control || {}),
    data_sources: deepClone(config.data_sources || {}),
    data_bindings: deepClone(config.data_bindings || {}),
    refresh_policy: deepClone(config.refresh_policy || {}),
    cache_policy: deepClone(config.cache_policy || {}),
    fallback: deepClone(config.fallback || {}),
    device_id: String(deviceId || ""),
  };
}

function getQWeatherAssetsInfo() {
  const fontsDir = path.join(QWEATHER_FONT_DIR, "fonts");
  const iconsDir = path.join(QWEATHER_DIR, "icons");
  const listFiles = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => fs.statSync(path.join(dir, name)).isFile())
      .sort();
  };

  return {
    root: QWEATHER_DIR,
    demo_html: QWEATHER_DEMO_FILE,
    css: QWEATHER_CSS_FILE,
    icon_map_json: QWEATHER_ICON_MAP_FILE,
    font_ttf: QWEATHER_FONT_FILE,
    font_files: listFiles(fontsDir),
    icon_svg_count: listFiles(iconsDir).filter((name) => name.toLowerCase().endsWith(".svg")).length,
  };
}

module.exports = {
  deepClone,
  deepMerge,
  normalizePageType,
  normalizeRenderMode,
  normalizePageConfig,
  uploadTfBlob,
  ensureDefaultTemplate,
  listTemplates,
  resolveTemplateHtml,
  buildCommonDataModel,
  renderPageBuffers,
  resolvePageConfig,
  getLatestPageImage,
  buildDevicePagePayload,
  configKeyForPage,
  imageKeyForPage,
  templateKeyForPage,
  getQWeatherAssetsInfo,
};
