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
  return String(templateHtml || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    return escapeHtml(getPathValue(model, String(key || "")));
  });
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
  const interpolated = interpolateTemplate(rawHtml, model);
  const sanitized = interpolated.replace(/<script[\s\S]*?<\/script>/gi, "");
  const rootClass = `preview-${pageType}`;

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
    * { box-sizing: border-box; }
    img { max-width: 100%; height: auto; }
    #preview-root { width: ${width}px; height: ${height}px; overflow: hidden; }
    #preview-root.preview-homepage { padding: 32px; }
    #preview-root.preview-badgepage { padding: 24px 32px; }
    #preview-root.preview-weatherpage { padding: 18px 24px; }
  `;

  if (/<html[\s>]/i.test(sanitized)) {
    if (/<head[\s>]/i.test(sanitized)) {
      return sanitized.replace(
        /<head[^>]*>/i,
        (m) => `${m}<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><style>${baseStyle}</style>`
      );
    }
    return sanitized.replace(
      /<html[^>]*>/i,
      (m) => `${m}<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><style>${baseStyle}</style></head>`
    );
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${baseStyle}</style>
</head>
<body>
  <div id="preview-root" class="${rootClass}">${sanitized}</div>
</body>
</html>`;
}
