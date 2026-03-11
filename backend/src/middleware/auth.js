const HttpError = require("../utils/httpError");
const { verifyToken } = require("../utils/jwt");

function normalizeToken(raw) {
  const text = String(raw || "").trim().replace(/^"(.*)"$/, "$1");
  if (!text) return "";
  const lower = text.toLowerCase();
  if (lower === "null" || lower === "undefined") return "";
  return text;
}

function parseToken(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader) {
    const lower = authHeader.toLowerCase();
    if (lower.startsWith("bearer ")) {
      return normalizeToken(authHeader.slice(7));
    }
    if (lower.startsWith("token ")) {
      return normalizeToken(authHeader.slice(6));
    }
  }

  const headerToken = req.headers["x-access-token"] || req.headers["x-token"] || req.headers.token || "";
  const parsedHeaderToken = normalizeToken(headerToken);
  if (parsedHeaderToken) return parsedHeaderToken;

  const queryToken = normalizeToken(req.query?.token || "");
  if (queryToken) return queryToken;
  return "";
}

function authRequired(req, res, next) {
  const token = parseToken(req);
  if (!token) {
    return next(new HttpError(401, "未登录或令牌缺失"));
  }

  try {
    req.auth = verifyToken(token);
    return next();
  } catch (_) {
    return next(new HttpError(401, "令牌无效或已过期"));
  }
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.auth) {
      return next(new HttpError(401, "未登录"));
    }
    if (!roles.includes(req.auth.role)) {
      return next(new HttpError(403, "权限不足"));
    }
    return next();
  };
}

module.exports = {
  authRequired,
  allowRoles,
};

