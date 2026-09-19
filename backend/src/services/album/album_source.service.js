const HttpError = require("../../utils/httpError");
const createId = require("../../utils/id");
const { encryptSecret, decryptSecret } = require("./credential_crypto.service");

const PROVIDER_TYPES = new Set(["openlist", "nas_local", "local_upload", "tf_file"]);

function nowIso() {
  return new Date().toISOString();
}

function normalizePath(value, fallback = "/") {
  let text = String(value || fallback || "/").replace(/\\/g, "/").trim();
  if (!text) text = "/";
  if (!text.startsWith("/")) text = `/${text}`;
  return text.replace(/\/+/g, "/");
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  return Boolean(value);
}

function normalizeConfig(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    timeoutSec: Math.max(3, Math.min(120, Number(raw.timeoutSec || 20))),
    trustSelfSigned: Boolean(raw.trustSelfSigned),
    maxConcurrency: Math.max(1, Math.min(16, Number(raw.maxConcurrency || 4))),
    thumbnailCacheSec: Math.max(30, Math.min(86400, Number(raw.thumbnailCacheSec || 3600))),
    allowedExtensions: Array.isArray(raw.allowedExtensions)
      ? raw.allowedExtensions.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
      : undefined,
  };
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new HttpError(400, "OpenList站点地址格式不正确");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new HttpError(400, "OpenList站点仅支持http(s)");
  }
  const host = url.hostname.toLowerCase();
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    throw new HttpError(400, "OpenList站点地址不允许访问云metadata");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function getActorOwnerId(auth) {
  return String(auth?.userId || "");
}

function isAdmin(auth) {
  return auth?.role === "admin";
}

function canReadSource(source, auth) {
  if (isAdmin(auth)) return true;
  if (source.isPublic) return true;
  return String(source.ownerId || "") === getActorOwnerId(auth);
}

function canWriteSource(source, auth) {
  if (isAdmin(auth)) return true;
  return String(source.ownerId || "") === getActorOwnerId(auth);
}

function redactSource(source = {}, credential = null) {
  const cred = credential || {};
  return {
    ...source,
    username: String(cred.username || source.username || ""),
    password: undefined,
    token: undefined,
    encryptedPassword: undefined,
    encryptedToken: undefined,
    hasPassword: Boolean(cred.encryptedPassword),
    hasToken: Boolean(cred.encryptedToken),
  };
}

function normalizeSourcePayload(payload = {}, auth, options = {}) {
  const providerType = String(payload.providerType || payload.provider_type || "").trim() || "openlist";
  if (!PROVIDER_TYPES.has(providerType)) {
    throw new HttpError(400, "providerType不支持");
  }
  const ownerId = isAdmin(auth) && payload.ownerId ? String(payload.ownerId) : getActorOwnerId(auth);
  if (!ownerId) throw new HttpError(400, "ownerId不能为空");
  const now = options.now ? options.now() : nowIso();
  const source = {
    id: options.idFactory ? options.idFactory("src") : createId("src"),
    ownerId,
    providerType,
    name: String(payload.name || "").trim(),
    description: String(payload.description || "").trim(),
    baseUrl: providerType === "openlist" ? normalizeBaseUrl(payload.baseUrl) : String(payload.baseUrl || "").trim(),
    rootPath: normalizePath(payload.rootPath || payload.root || "/"),
    config: normalizeConfig(payload.config),
    isPublic: normalizeBoolean(payload.isPublic, false),
    isEnabled: normalizeBoolean(payload.isEnabled, true),
    lastTestStatus: "",
    lastTestMessage: "",
    lastTestAt: "",
    lastSyncAt: "",
    createdAt: now,
    updatedAt: now,
  };
  if (!source.name) throw new HttpError(400, "来源名称不能为空");
  if (providerType === "openlist" && !source.baseUrl) throw new HttpError(400, "OpenList站点地址不能为空");
  if (providerType === "nas_local" && !source.rootPath) throw new HttpError(400, "NAS目录不能为空");
  return source;
}

function normalizeCredentialPayload(source, payload = {}, auth, options = {}) {
  const now = options.now ? options.now() : nowIso();
  const password = payload.password !== undefined ? String(payload.password || "") : "";
  const token = payload.token !== undefined ? String(payload.token || "") : "";
  return {
    id: options.idFactory ? options.idFactory("cred") : createId("cred"),
    sourceId: source.id,
    ownerId: source.ownerId,
    username: String(payload.username || "").trim(),
    encryptedPassword: password ? encryptSecret(password) : "",
    encryptedToken: token ? encryptSecret(token) : "",
    tokenExpireAt: String(payload.tokenExpireAt || ""),
    createdAt: now,
    updatedAt: now,
    updatedBy: String(auth?.userId || ""),
  };
}

function createAlbumSourceService(options = {}) {
  const clock = options.now || nowIso;
  const idFactory = options.idFactory || createId;

  function ensureShape(state) {
    state.albumSources = Array.isArray(state.albumSources) ? state.albumSources : [];
    state.albumSourceCredentials = Array.isArray(state.albumSourceCredentials) ? state.albumSourceCredentials : [];
  }

  function getCredential(state, sourceId) {
    ensureShape(state);
    return state.albumSourceCredentials.find((item) => item.sourceId === sourceId) || null;
  }

  function listSources(state, auth) {
    ensureShape(state);
    return state.albumSources
      .filter((source) => canReadSource(source, auth))
      .map((source) => redactSource(source, getCredential(state, source.id)))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  function getSource(state, sourceId, auth) {
    ensureShape(state);
    const source = state.albumSources.find((item) => item.id === sourceId);
    if (!source) throw new HttpError(404, "相册来源不存在");
    if (!canReadSource(source, auth)) throw new HttpError(403, "无权限访问该相册来源");
    return source;
  }

  function getWritableSource(state, sourceId, auth) {
    const source = getSource(state, sourceId, auth);
    if (!canWriteSource(source, auth)) throw new HttpError(403, "无权限修改该相册来源");
    return source;
  }

  function createSource(state, auth, payload = {}) {
    ensureShape(state);
    const source = normalizeSourcePayload(payload, auth, { now: clock, idFactory });
    const credential = normalizeCredentialPayload(source, payload, auth, { now: clock, idFactory });
    state.albumSources.unshift(source);
    state.albumSourceCredentials = state.albumSourceCredentials.filter((item) => item.sourceId !== source.id);
    state.albumSourceCredentials.unshift(credential);
    return redactSource(source, credential);
  }

  function patchSource(state, auth, sourceId, payload = {}) {
    ensureShape(state);
    const source = getWritableSource(state, sourceId, auth);
    const providerType = String(payload.providerType || source.providerType || "").trim();
    if (payload.name !== undefined) source.name = String(payload.name || "").trim();
    if (payload.description !== undefined) source.description = String(payload.description || "").trim();
    if (payload.baseUrl !== undefined) {
      source.baseUrl = providerType === "openlist" ? normalizeBaseUrl(payload.baseUrl) : String(payload.baseUrl || "").trim();
    }
    if (payload.rootPath !== undefined) source.rootPath = normalizePath(payload.rootPath || "/");
    if (payload.config !== undefined) source.config = normalizeConfig(payload.config);
    if (payload.isEnabled !== undefined) source.isEnabled = normalizeBoolean(payload.isEnabled, true);
    if (payload.isPublic !== undefined) source.isPublic = normalizeBoolean(payload.isPublic, false);
    source.updatedAt = clock();

    const credential = getCredential(state, source.id);
    if (
      payload.username !== undefined ||
      payload.password !== undefined ||
      payload.token !== undefined ||
      payload.tokenExpireAt !== undefined
    ) {
      const nextCredential = credential || normalizeCredentialPayload(source, {}, auth, { now: clock, idFactory });
      if (payload.username !== undefined) nextCredential.username = String(payload.username || "").trim();
      if (payload.password !== undefined) nextCredential.encryptedPassword = payload.password ? encryptSecret(payload.password) : "";
      if (payload.token !== undefined) nextCredential.encryptedToken = payload.token ? encryptSecret(payload.token) : "";
      if (payload.tokenExpireAt !== undefined) nextCredential.tokenExpireAt = String(payload.tokenExpireAt || "");
      nextCredential.updatedAt = clock();
      nextCredential.updatedBy = String(auth?.userId || "");
      if (!credential) state.albumSourceCredentials.unshift(nextCredential);
    }
    return redactSource(source, getCredential(state, source.id));
  }

  function deleteSource(state, auth, sourceId) {
    ensureShape(state);
    const source = getWritableSource(state, sourceId, auth);
    state.albumSources = state.albumSources.filter((item) => item.id !== source.id);
    state.albumSourceCredentials = state.albumSourceCredentials.filter((item) => item.sourceId !== source.id);
    return { id: source.id };
  }

  function markTestResult(state, auth, sourceId, status, message) {
    const source = getWritableSource(state, sourceId, auth);
    source.lastTestStatus = String(status || "");
    source.lastTestMessage = String(message || "");
    source.lastTestAt = clock();
    source.updatedAt = clock();
    return redactSource(source, getCredential(state, source.id));
  }

  function getCredentialForProvider(state, sourceId, auth) {
    const source = getSource(state, sourceId, auth);
    const credential = getCredential(state, source.id) || {};
    return {
      sourceId: source.id,
      ownerId: source.ownerId,
      username: String(credential.username || ""),
      password: credential.encryptedPassword ? decryptSecret(credential.encryptedPassword) : "",
      token: credential.encryptedToken ? decryptSecret(credential.encryptedToken) : "",
      tokenExpireAt: String(credential.tokenExpireAt || ""),
    };
  }

  return {
    listSources,
    getSource,
    getWritableSource,
    createSource,
    patchSource,
    deleteSource,
    markTestResult,
    getCredentialForProvider,
    redactSource,
  };
}

module.exports = {
  createAlbumSourceService,
  normalizePath,
  normalizeBaseUrl,
  canReadSource,
  canWriteSource,
};
