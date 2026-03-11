const jwt = require("jsonwebtoken");
const config = require("../config");

const BUILTIN_LEGACY_SECRETS = [
  "ink-screen-super-secret-change-me",
  "ink-screen-super-secret",
  "ink_screen_secret",
  "shuimoping-secret",
  "admin123",
];

function signToken(payload, expiresIn = config.jwtExpiresIn) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn });
}

function verifyToken(token) {
  const candidates = [...new Set([
    config.jwtSecret,
    ...(Array.isArray(config.jwtLegacySecrets) ? config.jwtLegacySecrets : []),
    ...BUILTIN_LEGACY_SECRETS,
  ])].filter(Boolean);

  let lastError = null;
  for (const secret of candidates) {
    try {
      return jwt.verify(token, secret);
    } catch (error) {
      // Compatibility mode: allow recently expired legacy tokens to pass verification.
      if (error?.name === "TokenExpiredError" && Number(config.jwtLegacyExpiryGraceSec || 0) > 0) {
        try {
          const payload = jwt.verify(token, secret, { ignoreExpiration: true });
          const exp = Number(payload?.exp || 0);
          const nowSec = Math.floor(Date.now() / 1000);
          if (exp > 0 && nowSec - exp <= Number(config.jwtLegacyExpiryGraceSec)) {
            payload.__legacyExpired = true;
            return payload;
          }
        } catch (_) {
          // ignore and continue with next secret
        }
      }
      lastError = error;
    }
  }
  throw lastError || new Error("invalid token");
}

module.exports = {
  signToken,
  verifyToken,
};
