const HttpError = require("../utils/httpError");

const BACKEND_BASE_URL_MAX_LENGTH = 127;

function normalizeBackendBaseUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new HttpError(400, "backendBaseUrl不能为空");
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new HttpError(400, "backendBaseUrl格式不正确");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new HttpError(400, "backendBaseUrl必须是http(s)地址");
  }
  if (!parsed.hostname) {
    throw new HttpError(400, "backendBaseUrl格式不正确");
  }

  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/g, "") || "/";
  const normalized = parsed.toString().replace(/\/$/g, "");
  if (normalized.length > BACKEND_BASE_URL_MAX_LENGTH) {
    throw new HttpError(400, `backendBaseUrl过长，最多${BACKEND_BASE_URL_MAX_LENGTH}个字符`);
  }
  return normalized;
}

function buildBackendUrlCommandPayload({ commandId, backendBaseUrl, requestedAt = new Date().toISOString() }) {
  return {
    commandId: String(commandId || "").trim(),
    backendBaseUrl: normalizeBackendBaseUrl(backendBaseUrl),
    requestedAt: String(requestedAt || new Date().toISOString()),
  };
}

module.exports = {
  normalizeBackendBaseUrl,
  buildBackendUrlCommandPayload,
};
