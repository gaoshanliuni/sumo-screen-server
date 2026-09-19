const assert = require("assert");

process.env.DEEPSEEK_API_KEY = "sk-env-0000";
process.env.DEEPSEEK_BASE_URL = "https://env.deepseek.test";
process.env.DEEPSEEK_MODEL = "deepseek-env";

const {
  createAiConfigService,
  maskApiKey,
} = require("../src/services/ai/ai_config.service");

const admin = { role: "admin", userId: "u_admin", username: "admin" };
const user = { role: "user", userId: "u_user", username: "demo" };

function makeState() {
  return {
    users: [
      { id: "u_admin", username: "admin", role: "admin", status: "enabled" },
      { id: "u_user", username: "demo", role: "user", status: "enabled" },
      { id: "u_other", username: "other", role: "user", status: "enabled" },
    ],
    aiProviderConfigs: [],
    aiUserAssignments: [],
    aiUsageLogs: [],
    asrProviderConfigs: [],
    asrUsageLogs: [],
  };
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[failed] ${name}: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}

async function main() {
  await run("api key mask is stable and non-revealing", async () => {
    assert.strictEqual(maskApiKey("sk-1234567890abcd"), "sk-****abcd");
    assert.strictEqual(maskApiKey(""), "");
  });

  await run("user-owned config is encrypted at rest and wins over assignment", async () => {
    const state = makeState();
    const service = createAiConfigService({
      now: () => "2026-06-06T00:00:00.000Z",
      idFactory: (prefix) => `${prefix}_fixed_${state.aiProviderConfigs.length + state.aiUserAssignments.length}`,
    });

    const adminConfig = service.createProviderConfig(state, admin, {
      name: "管理员 DeepSeek",
      provider: "deepseek",
      baseUrl: "https://admin.deepseek.test",
      model: "deepseek-admin",
      apiKey: "sk-admin-1111",
      enabled: true,
    });
    service.assignConfigToUsers(state, admin, {
      configId: adminConfig.id,
      userIds: ["u_user"],
    });

    const userConfig = service.saveMyConfig(state, user, {
      name: "我的 DeepSeek",
      provider: "deepseek",
      baseUrl: "https://user.deepseek.test",
      model: "deepseek-user",
      apiKey: "sk-user-2222",
      enabled: true,
      thinkingEnabled: true,
    });

    assert.strictEqual(userConfig.apiKey, undefined);
    assert.strictEqual(userConfig.hasApiKey, true);
    assert.strictEqual(userConfig.apiKeyMask, "sk-****2222");
    assert.strictEqual(userConfig.thinkingEnabled, true);
    assert.ok(!JSON.stringify(userConfig).includes("sk-user-2222"));
    assert.ok(!JSON.stringify(state.aiProviderConfigs).includes("sk-user-2222"));

    const effective = service.resolveEffectiveConfig(state, user);
    assert.strictEqual(effective.source, "user");
    assert.strictEqual(effective.baseUrl, "https://user.deepseek.test");
    assert.strictEqual(effective.model, "deepseek-user");
    assert.strictEqual(effective.apiKey, "sk-user-2222");
    assert.strictEqual(effective.thinkingEnabled, true);
  });

  await run("admin assignment wins when user has no config", async () => {
    const state = makeState();
    const service = createAiConfigService();
    const adminConfig = service.createProviderConfig(state, admin, {
      name: "管理员 DeepSeek",
      provider: "deepseek",
      baseUrl: "https://admin.deepseek.test",
      model: "deepseek-admin",
      apiKey: "sk-admin-3333",
      enabled: true,
    });
    const assignment = service.assignConfigToUsers(state, admin, {
      configId: adminConfig.id,
      userIds: ["u_other"],
    });
    assert.strictEqual(assignment.assigned, 1);

    const effective = service.resolveEffectiveConfig(state, { ...user, userId: "u_other" });
    assert.strictEqual(effective.source, "assignment");
    assert.strictEqual(effective.configId, adminConfig.id);
    assert.strictEqual(effective.apiKey, "sk-admin-3333");
  });

  await run("environment fallback remains default DeepSeek provider", async () => {
    const state = makeState();
    const service = createAiConfigService();
    const effective = service.resolveEffectiveConfig(state, { ...user, userId: "u_none" });
    assert.strictEqual(effective.source, "env");
    assert.strictEqual(effective.provider, "deepseek");
    assert.strictEqual(effective.baseUrl, "https://env.deepseek.test");
    assert.strictEqual(effective.model, "deepseek-env");
    assert.strictEqual(effective.apiKey, "sk-env-0000");
  });

  if (process.exitCode) {
    throw new Error("AI config self-test failed");
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
