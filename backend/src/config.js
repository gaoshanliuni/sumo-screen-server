module.exports = {
  port: Number(process.env.PORT || 8890),
  jwtSecret: process.env.JWT_SECRET || "ink-screen-super-secret-change-me",
  jwtLegacySecrets: String(process.env.JWT_LEGACY_SECRETS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  jwtLegacyExpiryGraceSec: Number(process.env.JWT_LEGACY_EXPIRY_GRACE_SEC || 30 * 24 * 60 * 60),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 8000),
  dbRetryCooldownMs: Number(process.env.DB_RETRY_COOLDOWN_MS || 30000),
  mongoUri: process.env.MONGO_URI || "",
  mysql: {
    host: process.env.DB_HOST || "gaoshanliuni.top",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "gly",
    password: process.env.DB_PASSWORD || "XiBk2QSddRheG2Ya",
    database: process.env.DB_NAME || "shuimoping",
    charset: process.env.DB_CHARSET || "utf8mb4",
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    connectTimeoutMs: Number(process.env.DB_CONNECT_TIMEOUT_MS || 2000),
    stateTable: process.env.DB_STATE_TABLE || "app_state",
  },
};
