function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createMemoryCache() {
  const map = new Map();
  function isExpired(row) {
    return row && row.expiresAt > 0 && row.expiresAt <= Date.now();
  }
  return {
    async get(key) {
      const row = map.get(String(key));
      if (!row) return null;
      if (isExpired(row)) {
        map.delete(String(key));
        return null;
      }
      return clone(row.value);
    },
    async set(key, value, ttlSeconds = 30) {
      const ttl = Number(ttlSeconds || 0);
      map.set(String(key), {
        value: clone(value),
        expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
      });
      return true;
    },
    async del(key) {
      map.delete(String(key));
      return true;
    },
    async clear() {
      map.clear();
      return true;
    },
    async status() {
      return { enabled: false, backend: "memory", size: map.size };
    },
  };
}

function safeRequire(name) {
  try {
    return require(name);
  } catch (_) {
    return null;
  }
}

function createRedisCache({ url, username, password } = {}) {
  const IORedis = safeRequire("ioredis");
  if (!IORedis || !url) return null;
  const client = new IORedis(url, {
    username: username || undefined,
    password: password || undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  let ready = false;
  async function ensureReady() {
    if (ready) return true;
    try {
      await client.connect();
      ready = true;
      return true;
    } catch (_) {
      ready = false;
      return false;
    }
  }
  return {
    async get(key) {
      if (!(await ensureReady())) return null;
      const raw = await client.get(String(key));
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (_) {
        return raw;
      }
    },
    async set(key, value, ttlSeconds = 30) {
      if (!(await ensureReady())) return false;
      const raw = JSON.stringify(value);
      const ttl = Math.max(1, Number(ttlSeconds || 30));
      await client.set(String(key), raw, "EX", ttl);
      return true;
    },
    async del(key) {
      if (!(await ensureReady())) return false;
      await client.del(String(key));
      return true;
    },
    async clear() {
      return false;
    },
    async status() {
      return { enabled: true, backend: "redis", ready };
    },
    async close() {
      try {
        await client.quit();
      } catch (_) {
        client.disconnect();
      }
    },
  };
}

function createCacheService(options = {}) {
  const enabled = options.enabled === true || String(options.enabled || process.env.REDIS_ENABLED || "0") === "1";
  const fallback = createMemoryCache();
  if (!enabled) return fallback;
  const redis = createRedisCache({
    url: options.url || process.env.REDIS_URL || "",
    username: options.username || process.env.REDIS_USERNAME || "",
    password: options.password || process.env.REDIS_PASSWORD || "",
  });
  if (!redis) return fallback;
  return {
    async get(key) {
      const value = await redis.get(key);
      return value === null || value === undefined ? fallback.get(key) : value;
    },
    async set(key, value, ttlSeconds) {
      const ok = await redis.set(key, value, ttlSeconds);
      await fallback.set(key, value, ttlSeconds);
      return ok;
    },
    async del(key) {
      await redis.del(key);
      await fallback.del(key);
      return true;
    },
    async clear() {
      await fallback.clear();
      return true;
    },
    async status() {
      const redisStatus = await redis.status();
      return { ...redisStatus, fallback: "memory" };
    },
    async close() {
      if (typeof redis.close === "function") await redis.close();
    },
  };
}

module.exports = {
  createCacheService,
  createMemoryCache,
};
