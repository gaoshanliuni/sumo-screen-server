/* eslint-disable no-console */
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "1";
process.env.DB_CONNECT_TIMEOUT_MS = process.env.DB_CONNECT_TIMEOUT_MS || "200";
process.env.DB_OP_TIMEOUT_MS = process.env.DB_OP_TIMEOUT_MS || "1000";
process.env.DB_INIT_RETRY_MAX = process.env.DB_INIT_RETRY_MAX || "1";
process.env.DB_RETRY_COOLDOWN_MS = process.env.DB_RETRY_COOLDOWN_MS || "60000";

const assert = require("assert");
const { readDB, updateDB } = require("../src/db/store");
const {
  collectReferencedTemplateSlugsForDevice,
} = require("../src/services/api_template_refresh.service");
const {
  runApiTemplateRefreshSchedulerTick,
} = require("../src/services/api_template_refresh_scheduler.service");
const {
  DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC,
  createPlayCollectionService,
} = require("../src/services/play_collection.service");
const { closeMongoClient } = require("../src/utils/mongo");

const TEST_NOW = "2026-06-25T00:00:00.000Z";

function weatherTemplate(overrides = {}) {
  return {
    id: "tpl_weather",
    name: "和风天气",
    slug: "weather",
    method: "GET",
    url: "https://devapi.qweather.com/v7/weather/now",
    keyField: "key",
    keyIn: ["query"],
    deviceKeyRequired: true,
    defaultParams: { location: "101010100" },
    refreshConfig: {
      mode: "interval",
      enabled: true,
      intervalMinutes: 1,
      ttlSeconds: 45,
      minRequestGapSeconds: 10,
      timeoutMs: 8000,
      fallbackToStale: true,
      jitterSeconds: 0,
    },
    enabled: true,
    builtin: true,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

function resetDraft(draft) {
  draft.meta = {
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    version: 2,
    migrations: {},
  };
  draft.users = [];
  draft.devices = [];
  draft.apiTemplates = [];
  draft.apiLogs = [];
  draft.homepageTemplates = [];
  draft.homepageConfigs = [];
  draft.badgepageTemplates = [];
  draft.badgepageConfigs = [];
  draft.weatherpageTemplates = [];
  draft.weatherpageConfigs = [];
  draft.playCollections = [];
  draft.playCollectionItems = [];
  draft.imageAssets = [];
  draft.tfFiles = [];
  draft.e6RenderedAssets = [];
  draft.remoteCommandAcks = [];
}

function explicitWeatherHomepageTemplate() {
  return {
    id: "tpl_home_weather_api",
    ownerId: "",
    name: "显式天气 API 模板",
    type: "custom_html",
    html: "<div>{{api.formatted_by_slug.weather.daily.0.textDay}}</div>",
    builtin: true,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  };
}

function explicitWeatherHomepageConfig(deviceId = "dev_explicit_weather") {
  return {
    id: `cfg_${deviceId}`,
    ownerId: "u_api_refresh",
    deviceId,
    config: {
      template: {
        type: "custom_html",
        template_id: "tpl_home_weather_api",
      },
    },
    version: 1,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  };
}

function testTemplateReferenceCollection() {
  const localWeatherDb = {
    apiTemplates: [weatherTemplate()],
    homepageTemplates: [],
    homepageConfigs: [],
    badgepageTemplates: [],
    badgepageConfigs: [],
    weatherpageTemplates: [],
    weatherpageConfigs: [],
  };
  const localWeatherSlugs = collectReferencedTemplateSlugsForDevice(
    localWeatherDb,
    { id: "dev_local_weather", ownerId: "u_api_refresh" },
    { pageTypes: ["weatherpage"] }
  );
  assert.ok(
    !localWeatherSlugs.includes("weather"),
    "默认 weatherpage 的 {{weather.*}} 本地变量不应收集 weather API slug"
  );

  const explicitDb = {
    apiTemplates: [weatherTemplate()],
    homepageTemplates: [explicitWeatherHomepageTemplate()],
    homepageConfigs: [explicitWeatherHomepageConfig()],
    badgepageTemplates: [],
    badgepageConfigs: [],
    weatherpageTemplates: [],
    weatherpageConfigs: [],
  };
  const explicitSlugs = collectReferencedTemplateSlugsForDevice(
    explicitDb,
    { id: "dev_explicit_weather", ownerId: "u_api_refresh" },
    { pageTypes: ["homepage"] }
  );
  assert.ok(
    explicitSlugs.includes("weather"),
    "显式 {{api.formatted_by_slug.weather.*}} 应继续收集 weather API slug"
  );
}

async function testSchedulerSkipsMissingDeviceKey() {
  await updateDB((draft) => {
    resetDraft(draft);
    draft.users = [
      { id: "u_api_refresh", username: "api-refresh-user", role: "user", status: "active" },
    ];
    draft.devices = [
      {
        id: "dev_no_weather_key",
        ownerId: "u_api_refresh",
        status: "enabled",
        bindState: "bound",
        apiKeys: {},
        thirdApiCache: {},
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      },
    ];
    draft.apiTemplates = [weatherTemplate()];
    draft.homepageTemplates = [explicitWeatherHomepageTemplate()];
    draft.homepageConfigs = [explicitWeatherHomepageConfig("dev_no_weather_key")];
  });

  const tick = await runApiTemplateRefreshSchedulerTick(new Date("2026-06-25T01:00:00.000Z"));
  assert.strictEqual(tick.scannedDevices, 1);
  assert.strictEqual(tick.dueCount, 0, "无 weather key 的设备不应进入 weather 定时刷新队列");

  const db = await readDB();
  const weatherLogs = (db.apiLogs || []).filter((row) => String(row.templateSlug || row.slug || "") === "weather");
  assert.strictEqual(weatherLogs.length, 0, "无 weather key 时不应产生 weather API 执行日志");
}

async function testWeatherRefreshConfigMigration() {
  await updateDB((draft) => {
    resetDraft(draft);
    draft.apiTemplates = [
      weatherTemplate({
        enabled: false,
        refreshConfig: {
          mode: "interval",
          enabled: false,
          intervalMinutes: 1,
          ttlSeconds: 45,
          minRequestGapSeconds: 10,
          timeoutMs: 8000,
          fallbackToStale: true,
          jitterSeconds: 2,
        },
      }),
    ];
  });

  const db = await readDB();
  const tpl = db.apiTemplates.find((item) => item.slug === "weather");
  assert.ok(tpl, "weather 模板应存在");
  assert.strictEqual(tpl.enabled, false, "模板 enabled=false 不应被迁移重新启用");
  assert.strictEqual(tpl.refreshConfig.enabled, false, "refreshConfig.enabled=false 不应被迁移重新启用");
  assert.strictEqual(tpl.refreshConfig.mode, "interval");
  assert.strictEqual(tpl.refreshConfig.intervalMinutes, 60);
  assert.strictEqual(tpl.refreshConfig.ttlSeconds, 3600);
  assert.ok(tpl.refreshConfig.minRequestGapSeconds >= 600);
}

async function testPlayCollectionMigration() {
  await updateDB((draft) => {
    resetDraft(draft);
    draft.playCollections = [
      {
        id: "col_legacy_2m",
        ownerId: "u_api_refresh",
        name: "旧默认 2 分钟集合",
        slideIntervalSec: 120,
        loopEnabled: true,
        offlineSyncEnabled: true,
        version: 4,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      },
      {
        id: "col_custom_3m",
        ownerId: "u_api_refresh",
        name: "显式 3 分钟集合",
        slideIntervalSec: 180,
        loopEnabled: true,
        offlineSyncEnabled: true,
        version: 7,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      },
    ];
  });

  const db = await readDB();
  const legacy = db.playCollections.find((item) => item.id === "col_legacy_2m");
  const custom = db.playCollections.find((item) => item.id === "col_custom_3m");
  assert.strictEqual(legacy.slideIntervalSec, DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC);
  assert.strictEqual(legacy.version, 5, "迁移 120 秒旧集合时应递增 version");
  assert.strictEqual(custom.slideIntervalSec, 180, "非 120 秒显式间隔不应被迁移覆盖");
  assert.strictEqual(custom.version, 7);
}

function testPlayCollectionServiceDefaults() {
  let seq = 0;
  const service = createPlayCollectionService({
    now: () => TEST_NOW,
    idFactory: (prefix) => `${prefix}_${++seq}`,
  });
  const auth = { role: "user", userId: "u_api_refresh" };
  const state = {
    playCollections: [],
    playCollectionItems: [],
    imageAssets: [],
    e6RenderedAssets: [],
    tfFiles: [],
    devices: [],
    remoteCommandAcks: [],
  };

  const created = service.createCollection(state, auth, { name: "默认间隔集合" });
  assert.strictEqual(created.slideIntervalSec, DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC);

  state.playCollections.push(
    {
      id: "col_src_a",
      ownerId: "u_api_refresh",
      name: "源集合 A",
      slideIntervalSec: 60,
      loopEnabled: true,
      offlineSyncEnabled: true,
      version: 1,
    },
    {
      id: "col_src_b",
      ownerId: "u_api_refresh",
      name: "源集合 B",
      slideIntervalSec: 90,
      loopEnabled: true,
      offlineSyncEnabled: true,
      version: 1,
    }
  );
  state.imageAssets.push(
    { id: "img_a", ownerId: "u_api_refresh", originalName: "a.png", mime: "image/png" },
    { id: "img_b", ownerId: "u_api_refresh", originalName: "b.png", mime: "image/png" }
  );
  state.playCollectionItems.push(
    { id: "item_a", collectionId: "col_src_a", imageId: "img_a", sortOrder: 1, enabled: true },
    { id: "item_b", collectionId: "col_src_b", imageId: "img_b", sortOrder: 1, enabled: true }
  );

  const mergedDefault = service.createMergedPlayCollection(state, auth, {
    collectionIds: ["col_src_a", "col_src_b"],
  });
  assert.strictEqual(mergedDefault.slideIntervalSec, DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC);

  const mergedExplicitTwo = service.createMergedPlayCollection(state, auth, {
    collectionIds: ["col_src_a"],
    slideIntervalSec: 120,
  });
  assert.strictEqual(mergedExplicitTwo.slideIntervalSec, 120, "未来用户显式选择 2 分钟仍应允许");
}

async function main() {
  testTemplateReferenceCollection();
  await testSchedulerSkipsMissingDeviceKey();
  await testWeatherRefreshConfigMigration();
  await testPlayCollectionMigration();
  testPlayCollectionServiceDefaults();
  console.log("[ok] API refresh guards and 10-minute play defaults verified");
}

main()
  .then(async () => {
    await closeMongoClient();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(`[fail] ${error && error.stack ? error.stack : error}`);
    await closeMongoClient().catch(() => undefined);
    process.exit(1);
  });
