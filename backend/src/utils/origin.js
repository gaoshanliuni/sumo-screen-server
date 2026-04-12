const config = require("../config");

function normalizeOrigin(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  const normalized = value.replace(/\/+$/, "");
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return `https://${normalized}`;
}

function firstForwarded(value) {
  if (!value) return "";
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "")
    .split(",")[0]
    .trim();
}

function resolveRequestOrigin(req) {
  const configured = normalizeOrigin(config.publicOrigin);
  if (configured) return configured;

  const forwardedProto = firstForwarded(req?.headers?.["x-forwarded-proto"]);
  const forwardedHost = firstForwarded(req?.headers?.["x-forwarded-host"]);
  const host = forwardedHost || firstForwarded(req?.headers?.host) || `localhost:${Number(config.port || 8890)}`;
  const proto = forwardedProto || (req?.secure ? "https" : req?.protocol || "http");
  return `${proto}://${host}`;
}

function resolveWsOrigin(req) {
  return resolveRequestOrigin(req).replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
}

module.exports = {
  normalizeOrigin,
  resolveRequestOrigin,
  resolveWsOrigin,
};

