const express = require("express");
const bcrypt = require("bcryptjs");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { readDB, updateDB } = require("../db/store");
const { signToken } = require("../utils/jwt");
const { authRequired, allowRoles } = require("../middleware/auth");
const { logOperation } = require("../utils/logging");

const router = express.Router();

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    nickname: user.nickname || "",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    status: user.status || "enabled",
  };
}

async function loginByRole(req, res, role) {
  const { username, password } = req.body || {};
  if (!username || !password) throw new HttpError(400, "username/password required");

  const db = await readDB();
  const user = db.users.find((item) => item.username === username && item.role === role);
  if (!user) throw new HttpError(401, "invalid username or password");
  if (user.status === "blocked") throw new HttpError(403, "account blocked");

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new HttpError(401, "invalid username or password");

  const token = signToken({
    userId: user.id,
    role: user.role,
    username: user.username,
  });

  await logOperation({
    actorId: user.id,
    actorRole: user.role,
    action: "auth.login",
    targetType: "user",
    targetId: user.id,
    detail: { username: user.username, role: user.role },
  });

  res.success({ token, user: toPublicUser(user) }, "login success");
}

router.post(
  "/user/login",
  asyncHandler(async (req, res) => {
    await loginByRole(req, res, "user");
  })
);

router.post(
  "/admin/login",
  asyncHandler(async (req, res) => {
    await loginByRole(req, res, "admin");
  })
);

router.post(
  "/logout",
  authRequired,
  asyncHandler(async (req, res) => {
    await logOperation({
      actorId: req.auth.userId || req.auth.deviceId,
      actorRole: req.auth.role,
      action: "auth.logout",
      targetType: "session",
      targetId: req.auth.userId || req.auth.deviceId || "",
    });
    res.success(null, "logout success");
  })
);

router.get(
  "/me",
  authRequired,
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const user = db.users.find((item) => item.id === req.auth.userId);
    if (!user) throw new HttpError(404, "user not found");
    res.success(toPublicUser(user), "ok");
  })
);

router.post(
  "/change-password",
  authRequired,
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) throw new HttpError(400, "old/new password required");
    if (String(newPassword).length < 6) throw new HttpError(400, "password length >= 6");

    const db = await readDB();
    const user = db.users.find((item) => item.id === req.auth.userId);
    if (!user) throw new HttpError(404, "user not found");

    const ok = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!ok) throw new HttpError(400, "old password invalid");

    const nextHash = await bcrypt.hash(newPassword, 10);
    await updateDB((draft) => {
      const target = draft.users.find((item) => item.id === req.auth.userId);
      target.passwordHash = nextHash;
      target.updatedAt = new Date().toISOString();
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "auth.change_password",
      targetType: "user",
      targetId: req.auth.userId,
    });

    res.success(null, "password updated");
  })
);

module.exports = router;
