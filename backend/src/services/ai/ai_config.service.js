const config = require("../../config");
const HttpError = require("../../utils/httpError");
const createId = require("../../utils/id");
const { encryptSecret, decryptSecret } = require("./credential_crypto.service");

const SUPPORTED_PROVIDERS = new Set(["deepseek"]);

function nowIso() {
  return new Date().toISOString();
}

function ensureShape(state) {
  state.aiProviderConfigs = Array.isArray(state.aiProviderConfigs) ? state.aiProviderConfigs : [];
  state.aiUserAssignments = Array.isArray(state.aiUserAssignments) ? state.aiUserAssignments : [];
  state.aiUsageLogs = Array.isArray(state.aiUsageLogs) ? state.aiUsageLogs : [];
  state.asrProviderConfigs = Array.isArray(state.asrProviderConfigs) ? state.asrProviderConfigs : [];
  state.asrUsageLogs = Array.isArray(state.asrUsageLogs) ? state.asrUsageLogs : [];
}

function assertAdmin(actor) {
  if (actor?.role !== "admin") throw new HttpError(403, "仅管理员可管理全局AI配置");
}

function normalizeProvider(value) {
  const provider = String(value || "deepseek").trim().toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(provider)) throw new HttpError(400, "AI provider暂仅支持deepseek");
  return provider;
}

function normalizeBaseUrl(value, fallback = "https://api.deepseek.com") {
  const raw = String(value || fallback || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new HttpError(400, "AI接入URL格式不正确");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new HttpError(400, "AI接入URL仅支持http(s)");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  return Boolean(value);
}

function maskApiKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= 8) return "****";
  return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

function redactConfig(row = {}) {
  const apiKey = row.encryptedApiKey ? decryptSecret(row.encryptedApiKey) : "";
  return {
    id: String(row.id || ""),
    ownerId: String(row.ownerId || ""),
    scope: String(row.scope || "user"),
    name: String(row.name || ""),
    provider: normalizeProvider(row.provider || "deepseek"),
    baseUrl: String(row.baseUrl || ""),
    model: String(row.model || ""),
    enabled: row.enabled !== false,
    thinkingEnabled: row.thinkingEnabled === true,
    isDefault: row.isDefault === true,
    hasApiKey: Boolean(apiKey),
    apiKeyMask: maskApiKey(apiKey),
    createdBy: String(row.createdBy || ""),
    updatedBy: String(row.updatedBy || ""),
    createdAt: String(row.createdAt || ""),
    updatedAt: String(row.updatedAt || ""),
  };
}

function hydrateConfig(row = {}, source = "user") {
  if (!row) return null;
  return {
    source,
    configId: String(row.id || ""),
    ownerId: String(row.ownerId || ""),
    provider: normalizeProvider(row.provider || "deepseek"),
    baseUrl: String(row.baseUrl || config.ai.deepseekBaseUrl || "https://api.deepseek.com"),
    model: String(row.model || config.ai.deepseekModel || "deepseek-chat"),
    apiKey: row.encryptedApiKey ? decryptSecret(row.encryptedApiKey) : "",
    enabled: row.enabled !== false,
    thinkingEnabled: row.thinkingEnabled === true,
  };
}

function createEnvConfig() {
  return {
    source: "env",
    configId: "",
    ownerId: "",
    provider: "deepseek",
    baseUrl: String(config.ai.deepseekBaseUrl || "https://api.deepseek.com").replace(/\/+$/, ""),
    model: String(config.ai.deepseekModel || "deepseek-chat"),
    apiKey: String(config.ai.deepseekApiKey || ""),
    enabled: config.ai.enabled !== false,
    thinkingEnabled: false,
  };
}

function sortLatestFirst(a, b) {
  return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
}

function normalizeConfigPayload(payload = {}, actor, options = {}) {
  const now = options.now || nowIso;
  const idFactory = options.idFactory || createId;
  const provider = normalizeProvider(payload.provider || "deepseek");
  const name = String(payload.name || (provider === "deepseek" ? "DeepSeek" : provider)).trim();
  return {
    id: idFactory("aicfg"),
    ownerId: String(payload.ownerId || actor?.userId || ""),
    scope: String(payload.scope || "user"),
    name: name || "DeepSeek",
    provider,
    baseUrl: normalizeBaseUrl(payload.baseUrl || config.ai.deepseekBaseUrl || "https://api.deepseek.com"),
    model: String(payload.model || config.ai.deepseekModel || "deepseek-chat").trim() || "deepseek-chat",
    encryptedApiKey: payload.apiKey ? encryptSecret(payload.apiKey) : "",
    enabled: normalizeBoolean(payload.enabled, true),
    thinkingEnabled: normalizeBoolean(payload.thinkingEnabled, false),
    isDefault: payload.isDefault === true,
    createdBy: String(actor?.userId || ""),
    updatedBy: String(actor?.userId || ""),
    createdAt: now(),
    updatedAt: now(),
  };
}

function createAiConfigService(options = {}) {
  const clock = options.now || nowIso;
  const idFactory = options.idFactory || createId;

  function listProviderConfigs(state, actor) {
    ensureShape(state);
    assertAdmin(actor);
    return state.aiProviderConfigs.map(redactConfig).sort(sortLatestFirst);
  }

  function createProviderConfig(state, actor, payload = {}) {
    ensureShape(state);
    assertAdmin(actor);
    const row = normalizeConfigPayload(
      {
        ...payload,
        ownerId: payload.ownerId || actor.userId,
        scope: payload.scope || "admin",
      },
      actor,
      { now: clock, idFactory }
    );
    state.aiProviderConfigs.unshift(row);
    return redactConfig(row);
  }

  function updateProviderConfig(state, actor, configId, payload = {}) {
    ensureShape(state);
    assertAdmin(actor);
    const row = state.aiProviderConfigs.find((item) => item.id === configId);
    if (!row) throw new HttpError(404, "AI配置不存在");
    if (payload.name !== undefined) row.name = String(payload.name || "").trim() || row.name;
    if (payload.provider !== undefined) row.provider = normalizeProvider(payload.provider);
    if (payload.baseUrl !== undefined) row.baseUrl = normalizeBaseUrl(payload.baseUrl);
    if (payload.model !== undefined) row.model = String(payload.model || "").trim() || "deepseek-chat";
    if (payload.enabled !== undefined) row.enabled = normalizeBoolean(payload.enabled, true);
    if (payload.thinkingEnabled !== undefined) row.thinkingEnabled = normalizeBoolean(payload.thinkingEnabled, false);
    if (payload.isDefault !== undefined) row.isDefault = payload.isDefault === true;
    if (payload.apiKey !== undefined) row.encryptedApiKey = payload.apiKey ? encryptSecret(payload.apiKey) : "";
    row.updatedBy = String(actor?.userId || "");
    row.updatedAt = clock();
    return redactConfig(row);
  }

  function saveMyConfig(state, actor, payload = {}) {
    ensureShape(state);
    const ownerId = String(actor?.userId || "");
    if (!ownerId) throw new HttpError(400, "userId不能为空");
    let row = state.aiProviderConfigs
      .filter((item) => item.ownerId === ownerId && String(item.scope || "user") === "user")
      .sort(sortLatestFirst)[0];
    if (!row) {
      row = normalizeConfigPayload(
        {
          ...payload,
          ownerId,
          scope: "user",
          isDefault: true,
        },
        actor,
        { now: clock, idFactory }
      );
      state.aiProviderConfigs.unshift(row);
      return redactConfig(row);
    }

    if (payload.name !== undefined) row.name = String(payload.name || "").trim() || row.name;
    if (payload.provider !== undefined) row.provider = normalizeProvider(payload.provider);
    if (payload.baseUrl !== undefined) row.baseUrl = normalizeBaseUrl(payload.baseUrl);
    if (payload.model !== undefined) row.model = String(payload.model || "").trim() || "deepseek-chat";
    if (payload.enabled !== undefined) row.enabled = normalizeBoolean(payload.enabled, true);
    if (payload.thinkingEnabled !== undefined) row.thinkingEnabled = normalizeBoolean(payload.thinkingEnabled, false);
    if (payload.apiKey !== undefined) row.encryptedApiKey = payload.apiKey ? encryptSecret(payload.apiKey) : row.encryptedApiKey;
    row.isDefault = true;
    row.updatedBy = ownerId;
    row.updatedAt = clock();
    return redactConfig(row);
  }

  function getMyConfig(state, actor) {
    ensureShape(state);
    const ownerId = String(actor?.userId || "");
    const row = state.aiProviderConfigs
      .filter((item) => item.ownerId === ownerId && String(item.scope || "user") === "user")
      .sort(sortLatestFirst)[0];
    const effective = resolveEffectiveConfig(state, actor);
    return {
      config: row ? redactConfig(row) : null,
      effective: {
        source: effective.source,
        configId: effective.configId,
        provider: effective.provider,
        baseUrl: effective.baseUrl,
        model: effective.model,
        enabled: effective.enabled,
        thinkingEnabled: effective.thinkingEnabled === true,
        hasApiKey: Boolean(effective.apiKey),
        apiKeyMask: maskApiKey(effective.apiKey),
      },
    };
  }

  function assignConfigToUsers(state, actor, payload = {}) {
    ensureShape(state);
    assertAdmin(actor);
    const configId = String(payload.configId || "").trim();
    const row = state.aiProviderConfigs.find((item) => item.id === configId);
    if (!row) throw new HttpError(404, "AI配置不存在");
    const userIds = Array.isArray(payload.userIds) ? payload.userIds.map((item) => String(item || "").trim()).filter(Boolean) : [];
    if (!userIds.length) throw new HttpError(400, "userIds不能为空");
    const now = clock();
    let assigned = 0;
    userIds.forEach((userId) => {
      if (Array.isArray(state.users) && state.users.length && !state.users.some((item) => item.id === userId)) {
        return;
      }
      const existing = state.aiUserAssignments.find((item) => item.userId === userId);
      if (existing) {
        existing.configId = configId;
        existing.enabled = payload.enabled !== false;
        existing.assignedBy = String(actor?.userId || "");
        existing.updatedAt = now;
      } else {
        state.aiUserAssignments.unshift({
          id: idFactory("aiassign"),
          userId,
          configId,
          enabled: payload.enabled !== false,
          assignedBy: String(actor?.userId || ""),
          createdAt: now,
          updatedAt: now,
        });
      }
      assigned += 1;
    });
    return { configId, assigned, userIds };
  }

  function resolveEffectiveConfig(state, actor) {
    ensureShape(state);
    const ownerId = String(actor?.userId || "");
    const own = state.aiProviderConfigs
      .filter((item) => item.enabled !== false && item.ownerId === ownerId && String(item.scope || "user") === "user")
      .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true) || sortLatestFirst(a, b))[0];
    if (own) return hydrateConfig(own, "user");

    const assignment = state.aiUserAssignments
      .filter((item) => item.enabled !== false && item.userId === ownerId)
      .sort(sortLatestFirst)[0];
    if (assignment) {
      const assignedConfig = state.aiProviderConfigs.find((item) => item.id === assignment.configId && item.enabled !== false);
      if (assignedConfig) return hydrateConfig(assignedConfig, "assignment");
    }

    return createEnvConfig();
  }

  return {
    listProviderConfigs,
    createProviderConfig,
    updateProviderConfig,
    saveMyConfig,
    getMyConfig,
    assignConfigToUsers,
    resolveEffectiveConfig,
    redactConfig,
  };
}

const defaultService = createAiConfigService();

module.exports = {
  createAiConfigService,
  maskApiKey,
  createEnvConfig,
  resolveEffectiveAiConfig: (...args) => defaultService.resolveEffectiveConfig(...args),
};
