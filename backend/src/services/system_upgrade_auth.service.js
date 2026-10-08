const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const createId = require("../utils/id");
const HttpError = require("../utils/httpError");
const { readDB } = require("../db/store");
const { listAuthTokens, saveAuthTokens } = require("./system_upgrade_storage.service");

function tokenHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

function randomToken() {
  return `${createId("subuildtok")}_${crypto.randomBytes(24).toString("hex")}`;
}

async function cleanupExpiredTokens() {
  const now = Date.now();
  const all = await listAuthTokens();
  const next = all.filter((item) => {
    const expireAt = Number(item?.expireAtTs || 0);
    return Number.isFinite(expireAt) && expireAt > now;
  });
  if (next.length !== all.length) {
    await saveAuthTokens(next);
  }
  return next;
}

async function verifyAdminPassword({ userId = "", password = "" }) {
  const uid = String(userId || "").trim();
  const pass = String(password || "");
  if (!uid || !pass) {
    throw new HttpError(400, "管理员密码不能为空");
  }
  const db = await readDB();
  const user = (db.users || []).find((item) => String(item?.id || "") === uid);
  if (!user || String(user.role || "") !== "admin" || String(user.status || "") === "blocked") {
    throw new HttpError(403, "仅管理员可执行此操作");
  }
  const ok = await bcrypt.compare(pass, String(user.passwordHash || ""));
  if (!ok) {
    throw new HttpError(401, "管理员密码校验失败");
  }
  return user;
}

async function issuePackageBuildToken({ userId = "", username = "", ttlMs = 5 * 60 * 1000 }) {
  const validFor = Math.max(30 * 1000, Number(ttlMs || 5 * 60 * 1000));
  const now = Date.now();
  const expireAtTs = now + validFor;
  const raw = randomToken();
  const hash = tokenHash(raw);
  const all = await cleanupExpiredTokens();
  all.unshift({
    id: createId("subuildauth"),
    tokenHash: hash,
    userId: String(userId || ""),
    username: String(username || ""),
    scope: "system-upgrade-build",
    createdAtTs: now,
    expireAtTs,
    usedAtTs: 0,
  });
  await saveAuthTokens(all.slice(0, 2000));
  return {
    token: raw,
    expireAt: new Date(expireAtTs).toISOString(),
    ttlMs: validFor,
  };
}

async function consumePackageBuildToken({ token = "", userId = "" }) {
  const raw = String(token || "").trim();
  if (!raw) {
    throw new HttpError(401, "缺少 packageBuildToken");
  }
  const now = Date.now();
  const hash = tokenHash(raw);
  const all = await cleanupExpiredTokens();
  const row = all.find((item) => String(item.tokenHash || "") === hash);
  if (!row) {
    throw new HttpError(401, "packageBuildToken 无效或已过期");
  }
  if (Number(row.usedAtTs || 0) > 0) {
    throw new HttpError(401, "packageBuildToken 已使用");
  }
  if (String(row.userId || "") !== String(userId || "")) {
    throw new HttpError(403, "packageBuildToken 与当前管理员不匹配");
  }
  row.usedAtTs = now;
  await saveAuthTokens(all);
  return {
    id: String(row.id || ""),
    userId: String(row.userId || ""),
    scope: String(row.scope || ""),
  };
}

module.exports = {
  verifyAdminPassword,
  issuePackageBuildToken,
  consumePackageBuildToken,
};
