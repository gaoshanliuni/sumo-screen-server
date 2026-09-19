const crypto = require("crypto");
const config = require("../../config");

const VERSION = "v1";

function deriveKey() {
  const secret = String(process.env.AI_CREDENTIAL_SECRET || config.jwtSecret || "ai-credential-secret");
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

function decryptSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  const parts = text.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) return "";
  const [, ivRaw, tagRaw, encryptedRaw] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = {
  encryptSecret,
  decryptSecret,
};
