export type PreviewPageType = "homepage" | "badgepage" | "weatherpage";
export type PreviewTimeAlign = "left" | "center" | "right";

type AnyObject = Record<string, any>;

function isObject(input: any): input is AnyObject {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function deepMerge(base: AnyObject, patch?: AnyObject): AnyObject {
  const out: AnyObject = JSON.parse(JSON.stringify(base || {}));
  if (!isObject(patch)) return out;
  Object.keys(patch).forEach((key) => {
    const v = patch[key];
    if (isObject(v) && isObject(out[key])) {
      out[key] = deepMerge(out[key], v);
    } else {
      out[key] = v;
    }
  });
  return out;
}

function getPathValue(source: AnyObject, dottedPath: string): string {
  const parts = String(dottedPath || "").split(".").filter(Boolean);
  let current: any = source;
  for (const part of parts) {
    if (!isObject(current) && !Array.isArray(current)) return "";
    current = current[part];
    if (current === undefined || current === null) return "";
  }
  if (typeof current === "string") return current;
  if (typeof current === "number" || typeof current === "boolean") return String(current);
  if (Array.isArray(current)) return current.join(", ");
  return "";
}

function escapeHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function interpolateTemplate(templateHtml: string, model: AnyObject): string {
  return String(templateHtml || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) =>
    escapeHtml(getPathValue(model, String(key || "")))
  );
}

export function buildTemplatePreviewModel(overrides?: AnyObject): AnyObject {
  const now = new Date();
  const fallback = {
    profile: {
      name: "Alex Chen",
      title: "Smart Badge Owner",
      department: "Device Platform",
      workstation: "A-12",
      employee_no: "EMP-2048",
      status: "online",
    },
    todo_summary: {
      count: 3,
      text: "Finish hardware sync / Verify OTA / Update docs",
    },
    schedule_summary: {
      count: 2,
      text: "10:00 Project Sync, 14:00 Demo Review",
    },
    weather: {
      city: "Shanghai",
      text: "Sunny",
      temp: "26",
      code: "100",
      aqi: "42",
      humidity: "43",
      updated_at: now.toISOString(),
    },
    custom_fields: {},
    meta: {
      rendered_at: now.toISOString(),
      backend: "preview",
      device_id: "preview-device",
    },
  };
  return deepMerge(fallback, isObject(overrides) ? overrides : {});
}

function safeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value || {})
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function extractInlineScripts(rawHtml: string): { htmlWithoutScripts: string; scripts: Array<{ src: string; type: string; content: string }> } {
  const scripts: Array<{ src: string; type: string; content: string }> = [];
  const htmlWithoutScripts = String(rawHtml || "").replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (_whole, attrsRaw, bodyRaw) => {
      const srcMatch = String(attrsRaw || "").match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      const typeMatch = String(attrsRaw || "").match(/\btype\s*=\s*["']([^"']+)["']/i);
      scripts.push({
        src: String(srcMatch?.[1] || "").trim(),
        type: String(typeMatch?.[1] || "").trim(),
        content: String(bodyRaw || ""),
      });
      return "";
    }
  );
  return { htmlWithoutScripts, scripts };
}

function buildPreviewRuntimeScript(model: AnyObject, width: number, height: number, pageType: PreviewPageType, scripts: Array<{ src: string; type: string; content: string }>) {
  const modelJson = safeJsonForInlineScript(model || {});
  const scriptsJson = safeJsonForInlineScript(Array.isArray(scripts) ? scripts : []);
  const pageTypeJson = JSON.stringify(String(pageType || "homepage"));
  return `<script>
(() => {
  const model = ${modelJson};
  const pageWidth = ${Math.max(320, Number(width || 2560))};
  const pageHeight = ${Math.max(240, Number(height || 1600))};
  const pageType = ${pageTypeJson};
  const deferredScripts = ${scriptsJson};
  const missing = new Set();
  const debug = {
    pageType,
    replacedTextNodes: 0,
    replacedAttributes: 0,
    mappedLegacyCount: 0,
    missingVariables: [],
    scriptErrors: [],
  };
  window.__PREVIEW_DEBUG__ = debug;

  const resolve = (obj, path) => {
    if (!path || typeof path !== "string") return "";
    const parts = path.split(".").filter(Boolean);
    let cur = obj;
    for (const part of parts) {
      if (cur === null || cur === undefined) {
        missing.add(path);
        return "";
      }
      cur = cur[part];
    }
    if (cur === null || cur === undefined) {
      missing.add(path);
      return "";
    }
    if (typeof cur === "object") {
      try { return JSON.stringify(cur); } catch (_) { return ""; }
    }
    return String(cur);
  };

  const interpolate = (text) =>
    String(text || "").replace(/\\{\\{\\s*([a-zA-Z0-9_.-]+)\\s*\\}\\}/g, (_m, key) => resolve(model, key));

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
      if (replaced !== node.nodeValue) debug.replacedTextNodes += 1;
      node.nodeValue = replaced;
    });

    document.querySelectorAll("*").forEach((el) => {
      Array.from(el.attributes || []).forEach((attr) => {
        const raw = String(attr?.value || "");
        if (!raw || raw.indexOf("{{") < 0) return;
        const replaced = interpolate(raw);
        if (replaced !== raw) debug.replacedAttributes += 1;
        el.setAttribute(attr.name, replaced);
      });
      const bind = el.getAttribute("data-bind");
      if (bind) el.textContent = resolve(model, bind);
      const bindHtml = el.getAttribute("data-bind-html");
      if (bindHtml) el.innerHTML = resolve(model, bindHtml);
    });
  };

  const applyDataLayout = () => {
    const nodes = document.querySelectorAll("[data-x], [data-y], [data-size], [data-width], [data-align], [data-weight], [data-color]");
    nodes.forEach((el) => {
      const x = toNum(el.getAttribute("data-x"));
      const y = toNum(el.getAttribute("data-y"));
      const size = toNum(el.getAttribute("data-size"));
      const widthAttr = toNum(el.getAttribute("data-width"));
      const align = String(el.getAttribute("data-align") || "").trim().toLowerCase();
      const weight = String(el.getAttribute("data-weight") || "").trim();
      const color = String(el.getAttribute("data-color") || "").trim();
      if (x !== null || y !== null) el.style.position = "absolute";
      if (!String(el.style.boxSizing || "").trim()) el.style.boxSizing = "border-box";
      if (x !== null) el.style.left = x + "px";
      if (y !== null) el.style.top = y + "px";
      if (size !== null && size > 0) el.style.fontSize = size + "px";
      if (weight) el.style.fontWeight = weight;
      if (align === "left" || align === "center" || align === "right") el.style.textAlign = align;
      if (color) el.style.color = color;
      if (widthAttr !== null && widthAttr > 0) {
        el.style.width = widthAttr + "px";
        el.style.maxWidth = widthAttr + "px";
      } else if (!String(el.style.width || "").trim() && x !== null) {
        const remain = Math.max(80, pageWidth - x - 24);
        el.style.width = remain + "px";
        el.style.maxWidth = remain + "px";
      }
      if (!String(el.style.whiteSpace || "").trim()) el.style.whiteSpace = "pre-wrap";
      if (!String(el.style.overflowWrap || "").trim()) el.style.overflowWrap = "break-word";
      if (!String(el.style.lineHeight || "").trim()) el.style.lineHeight = "1.2";
      debug.mappedLegacyCount += 1;
    });
  };

  const runDeferredScripts = async () => {
    const parent = document.body || document.documentElement;
    if (!parent) return;
    for (const item of deferredScripts) {
      const src = String(item?.src || "").trim();
      const type = String(item?.type || "").trim();
      const contentRaw = String(item?.content || "");
      if (src) {
        await new Promise((resolvePromise) => {
          const node = document.createElement("script");
          if (type) node.type = type;
          node.src = src;
          node.async = false;
          node.onload = () => resolvePromise(true);
          node.onerror = () => {
            debug.scriptErrors.push("load_failed:" + src);
            resolvePromise(true);
          };
          parent.appendChild(node);
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
          "\\n}catch(error){console.error('[preview] inline script error', error);}})();";
        parent.appendChild(node);
      } catch (error) {
        debug.scriptErrors.push(String(error && error.message ? error.message : error));
      }
    }
  };

  const run = async () => {
    applyBindings();
    applyDataLayout();
    await runDeferredScripts();
    applyBindings();
    applyDataLayout();
    debug.missingVariables = Array.from(missing).sort();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      run().catch((error) => {
        debug.scriptErrors.push(String(error && error.message ? error.message : error));
      });
    }, { once: true });
  } else {
    run().catch((error) => {
      debug.scriptErrors.push(String(error && error.message ? error.message : error));
    });
  }
})();
</script>`;
}

export function formatPreviewTime(formatRaw: string, inputDate?: Date): string {
  const format = String(formatRaw || "HH:mm");
  const now = inputDate instanceof Date ? inputDate : new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return format
    .replace(/HH/g, hh)
    .replace(/hh/g, hh)
    .replace(/mm/g, mm)
    .replace(/ss/g, ss)
    .replace(/%H/g, hh)
    .replace(/%M/g, mm)
    .replace(/%S/g, ss);
}

export function buildTemplatePreviewSrcdoc(
  rawHtml: string,
  options?: {
    pageType?: PreviewPageType;
    width?: number;
    height?: number;
    model?: AnyObject;
  }
): string {
  const width = Math.max(320, Number(options?.width || 2560));
  const height = Math.max(240, Number(options?.height || 1600));
  const pageType = (options?.pageType || "homepage") as PreviewPageType;
  const model = buildTemplatePreviewModel(options?.model);
  const extracted = extractInlineScripts(rawHtml);
  const interpolated = String(extracted.htmlWithoutScripts || "");
  const rootClass = `preview-${pageType}`;
  const runtimeScript = buildPreviewRuntimeScript(model, width, height, pageType, extracted.scripts);

  const baseStyle = `
    html, body {
      margin: 0;
      padding: 0;
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      background: #fff;
      color: #111;
      font-family: "Noto Sans SC", "Microsoft YaHei", Arial, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    img { max-width: 100%; height: auto; }
    #preview-root { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; }
  `;

  if (/<html[\s>]/i.test(interpolated)) {
    if (/<head[\s>]/i.test(interpolated)) {
      return interpolated.replace(
        /<head[^>]*>/i,
        (m) =>
          `${m}<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><style>${baseStyle}</style>${runtimeScript}`
      );
    }
    return interpolated.replace(
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
  <div id="preview-root" class="${rootClass}">${interpolated}</div>
</body>
</html>`;
}
