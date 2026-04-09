const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createCanvas, registerFont, loadImage } = require("@napi-rs/canvas");

const createId = require("../utils/id");
const HttpError = require("../utils/httpError");
const { getGridBucket } = require("../utils/mongo");

const ROOT_DIR = path.join(__dirname, "../../..");
const QWEATHER_DIR = path.join(ROOT_DIR, "ico/QWeather-Icons-1.8.0");
const QWEATHER_FONT_DIR = path.join(QWEATHER_DIR, "font");
const QWEATHER_FONT_FILE = path.join(QWEATHER_FONT_DIR, "fonts/qweather-icons.ttf");
const QWEATHER_ICON_MAP_FILE = path.join(QWEATHER_FONT_DIR, "qweather-icons.json");
const QWEATHER_DEMO_FILE = path.join(QWEATHER_FONT_DIR, "demo.html");
const QWEATHER_CSS_FILE = path.join(QWEATHER_FONT_DIR, "qweather-icons.css");

let qweatherFontRegistered = false;
let qweatherIconMap = null;
let playwrightModule = null;
let browserLaunchPromise = null;
let browserCleanupHooked = false;

function parsePositiveInt(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return Math.floor(num);
  }
  return Math.floor(Number(fallback) > 0 ? Number(fallback) : 0);
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

  merged.image = merged.image || {};
  merged.image.format = String(merged.image.format || "epd4").toLowerCase();
  merged.image.preview_format = String(merged.image.preview_format || "png").toLowerCase();
  merged.image.render_source = String(merged.image.render_source || "server");
  merged.image.cache_ttl_sec = clamp(merged.image.cache_ttl_sec, 30, 86400, 3600);
  merged.image.refresh_policy = String(merged.image.refresh_policy || "on-demand");

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
  merged.time_overlay.background_clear_mode = String(merged.time_overlay.background_clear_mode || "fill-white");
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
  const envPaths = [
    process.env.PLAYWRIGHT_CHROMIUM_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  const defaults = [
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];

  return [...new Set([...envPaths, ...defaults])].filter((item) => fs.existsSync(item));
}

function shouldUseBrowserRender(templateHtml, config) {
  const engine = String(config?.template?.render_engine || "auto").toLowerCase();
  const html = String(templateHtml || "");
  const hasScript = /<script[\s>]/i.test(html) || /\bon[a-z]+\s*=/i.test(html);
  // JS/事件语法必须走浏览器渲染，避免 legacy 模式导致脚本失效与布局退化。
  if (hasScript) return true;

  if (engine === "legacy") return false;
  if (engine === "browser") return true;

  if (!html.trim()) return false;

  if (/<html[\s>]|<head[\s>]|<style[\s>]|<section[\s>]|<article[\s>]|<table[\s>]|<header[\s>]|<footer[\s>]|<main[\s>]/i.test(html)) {
    return true;
  }

  const hasLegacyDataLayout = /data-x\s*=|data-y\s*=|data-size\s*=/i.test(html);
  if (hasLegacyDataLayout) return false;

  return true;
}

function safeJsonForInlineScript(value) {
  return JSON.stringify(value || {})
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function buildRuntimeModelScript(dataModel, width, height, waitConfig) {
  const modelJson = safeJsonForInlineScript(dataModel || {});
  const canvasWidth = Number(width) > 0 ? Number(width) : 2560;
  const canvasHeight = Number(height) > 0 ? Number(height) : 1600;
  const readyTimeoutMs = parsePositiveInt(waitConfig?.readyTimeoutMs, 8000);
  const idleSettleMs = parsePositiveInt(waitConfig?.idleSettleMs, 450);
  return `<script>
(() => {
  const model = ${modelJson};
  const pageWidth = ${canvasWidth};
  const pageHeight = ${canvasHeight};
  const readyTimeoutMs = ${readyTimeoutMs};
  const idleSettleMs = ${idleSettleMs};
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
      if (cur === null || cur === undefined) return "";
      cur = cur[part];
    }
    if (cur === null || cur === undefined) return "";
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
      node.nodeValue = interpolate(node.nodeValue);
    });

    const attrs = ["title", "alt", "placeholder", "src", "href", "data-src", "data-text", "data-value"];
    document.querySelectorAll("*").forEach((el) => {
      attrs.forEach((attr) => {
        const raw = el.getAttribute(attr);
        if (raw && raw.indexOf("{{") >= 0) {
          el.setAttribute(attr, interpolate(raw));
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

  const applyDataLayout = () => {
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
    });
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

  const run = () => {
    applyBindings();
    applyDataLayout();
    observeMutations();
    noteActivity();
    startHardTimeout();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
</script>`;
}

function buildBrowserPreviewDocument(rawHtml, dataModel, width, height, waitConfig) {
  const html = String(rawHtml || "");
  const runtimeScript = buildRuntimeModelScript(dataModel, width, height, waitConfig);
  const baseStyle = `
    html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff;color:#111;}
    body{font-family:"Noto Sans SC","Microsoft YaHei",Arial,sans-serif;position:relative;}
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

  browserLaunchPromise = (async () => {
    const playwright = await getPlaywrightModule();
    if (!playwright || !playwright.chromium) {
      throw new Error("playwright-core not installed");
    }

    const executables = getBrowserExecutableCandidates();
    if (!executables.length) {
      throw new Error("no chromium browser executable found");
    }

    let lastError = null;
    for (const executablePath of executables) {
      try {
        return await playwright.chromium.launch({
          headless: true,
          executablePath,
          args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("failed to launch browser renderer");
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
    const doc = buildBrowserPreviewDocument(templateHtml, dataModel, width, height, waitConfig);
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
    return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
  } finally {
    await context.close();
  }
}

function ensureQWeatherAssets() {
  if (!qweatherIconMap && fs.existsSync(QWEATHER_ICON_MAP_FILE)) {
    qweatherIconMap = JSON.parse(fs.readFileSync(QWEATHER_ICON_MAP_FILE, "utf8"));
  }
  if (!qweatherFontRegistered && fs.existsSync(QWEATHER_FONT_FILE)) {
    registerFont(QWEATHER_FONT_FILE, { family: "QWeather Icons" });
    qweatherFontRegistered = true;
  }
  return {
    available: qweatherFontRegistered && isObject(qweatherIconMap),
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
  ctx.font = `${block.weight} ${block.fontSize}px "Noto Sans SC", "Microsoft YaHei", sans-serif`;
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
  for (const item of images) {
    try {
      const image = await loadTemplateImage(item.src);
      if (!image) continue;
      ctx.save();
      ctx.globalAlpha = item.opacity;
      ctx.drawImage(image, item.x, item.y, item.width, item.height);
      ctx.restore();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[page-render] draw image failed", {
        src: String(item.src || "").slice(0, 96),
        err: error?.message || String(error),
      });
    }
  }
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
    api: {
      third,
      formatted_by_slug: thirdFormatted,
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
  const width = Number(config.screen?.width || 2560);
  const height = Number(config.screen?.height || 1600);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  let browserRendered = false;
  const useBrowser = shouldUseBrowserRender(templateHtml, config);
  const forceBrowser =
    String(config?.template?.render_engine || "auto").toLowerCase() === "browser" ||
    /<script[\s>]/i.test(String(templateHtml || ""));

  if (useBrowser) {
    try {
      const browserPng = await renderWithBrowserEngine({ templateHtml, dataModel, width, height, config });
      const browserImage = await loadImage(browserPng);
      ctx.drawImage(browserImage, 0, 0, width, height);
      browserRendered = true;
    } catch (error) {
      if (forceBrowser) {
        throw new HttpError(500, `browser render failed: ${error?.message || String(error)}`);
      }
      // eslint-disable-next-line no-console
      console.warn("[page-render] browser engine fallback to legacy", {
        pageType: normalizePageType(pageType),
        reason: error?.message || String(error),
      });
    }
  }

  if (!browserRendered) {
    await drawTemplateImages(ctx, templateHtml, dataModel, width, height);

    const blocks = parseTemplateBlocks(templateHtml, dataModel, width, height);
    if (blocks.length) {
      blocks.forEach((block) => drawTextBlock(ctx, block));
    }

    if (normalizePageType(pageType) === "weatherpage") {
      drawWeatherIcons(ctx, templateHtml, dataModel, width, height);
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
