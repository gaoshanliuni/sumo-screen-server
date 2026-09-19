function trimOrigin(value = "") {
  return String(value || "").trim().replace(/\/+$/g, "");
}

function hostWithoutPort(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname;
  } catch (_) {
    return raw.split(":")[0] || "";
  }
}

function isPrivateHost(value = "") {
  const host = hostWithoutPort(value).toLowerCase();
  if (!host) return false;
  if (host === "localhost") return true;
  if (host === "127.0.0.1" || host.startsWith("127.")) return true;
  if (host === "::1") return true;
  const parts = host.split(".").map((item) => Number(item));
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function requestOrigin(req) {
  const forwardedProtoRaw = req?.headers?.["x-forwarded-proto"];
  const forwardedHostRaw = req?.headers?.["x-forwarded-host"];
  const proto = String(Array.isArray(forwardedProtoRaw) ? forwardedProtoRaw[0] : forwardedProtoRaw || req?.protocol || "http")
    .split(",")[0]
    .trim() || "http";
  const host = String(Array.isArray(forwardedHostRaw) ? forwardedHostRaw[0] : forwardedHostRaw || req?.get?.("host") || req?.headers?.host || "")
    .split(",")[0]
    .trim();
  return host ? `${proto}://${host}` : "";
}

function resolvePublicBaseUrl(req, configuredOrigin = "") {
  const configured = trimOrigin(configuredOrigin);
  const fromRequest = trimOrigin(requestOrigin(req));
  if (!configured) return fromRequest;
  if (fromRequest && isPrivateHost(configured) && !isPrivateHost(fromRequest)) {
    return fromRequest;
  }
  return configured;
}

module.exports = {
  resolvePublicBaseUrl,
  isPrivateHost,
  requestOrigin,
};
