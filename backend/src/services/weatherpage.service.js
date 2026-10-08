const fs = require("fs");
const path = require("path");

const {
  deepMerge,
  normalizePageConfig,
  ensureDefaultTemplate,
  listTemplates,
  resolveTemplateHtml,
  buildCommonDataModel,
  renderPageBuffers,
  resolvePageConfig,
  getLatestPageImage,
  buildDevicePagePayload,
  getQWeatherAssetsInfo,
  configKeyForPage,
  templateKeyForPage,
  imageKeyForPage,
} = require("./page_profile.service");

const PAGE_TYPE = "weatherpage";
const DEFAULT_TEMPLATE_ID = "tpl_weatherpage_default";
const DEFAULT_TEMPLATE_NAME = "Default Weather HTML";
const DEFAULT_CONFIG_PATH = path.join(__dirname, "../../config/default_weatherpage.json");
const DEFAULT_TEMPLATE_HTML = `
<div data-x="120" data-y="90" data-size="68" data-weight="600" data-align="left">{{weather.city}}</div>
<i data-icon="{{weather.code}}" data-x="130" data-y="220" data-size="260" data-width="300" data-align="left" data-color="#000000"></i>
<div data-x="470" data-y="280" data-size="120" data-weight="700" data-align="left">{{weather.temp}}C</div>
<div data-x="470" data-y="430" data-size="58" data-align="left">{{weather.text}}</div>
<div data-x="470" data-y="520" data-size="44" data-align="left">AQI {{weather.aqi}}  HUM {{weather.humidity}}%</div>
<div data-x="120" data-y="1450" data-size="30" data-align="left">Updated: {{weather.updated_at}}</div>
`;

function buildBuiltinWeatherConfig() {
  return {
    id: "weatherpage_default",
    name: "Default Weather Page",
    enabled: true,
    version: 1,
    screen: { width: 2560, height: 1600 },
    template: {
      type: "default_html",
      template_id: DEFAULT_TEMPLATE_ID,
      template_name: DEFAULT_TEMPLATE_NAME,
      template_path: "builtin://weatherpage/default",
      render_engine: "auto",
      render_mode: "hybrid",
    },
    image: {
      format: "epd4",
      preview_format: "png",
      render_source: "server",
      refresh_policy: "event-or-poll",
      cache_ttl_sec: 1800,
    },
    time_overlay: {
      enabled: true,
      x: 1880,
      y: 90,
      width: 620,
      height: 160,
      format: "HH:mm",
      font_size: 78,
      align: "right",
      refresh_interval_sec: 60,
      background_clear_mode: "fill-white",
      invert: false,
    },
    fallback: {
      enabled: true,
      mode: "local_text_weather",
    },
  };
}

function loadDefaultWeatherConfig() {
  let parsed = null;
  if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    try {
      parsed = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8"));
    } catch (error) {
      console.warn(
        `[weatherpage] failed to parse default config at ${DEFAULT_CONFIG_PATH}, fallback to builtin. err=${
          error && error.message ? error.message : String(error)
        }`
      );
    }
  } else {
    console.warn(
      `[weatherpage] default config not found at ${DEFAULT_CONFIG_PATH}, fallback to builtin.`
    );
  }
  if (!parsed || typeof parsed !== "object") {
    parsed = buildBuiltinWeatherConfig();
  }
  parsed.template = parsed.template || {};
  if (!parsed.template.template_id) parsed.template.template_id = DEFAULT_TEMPLATE_ID;
  parsed.qweather_assets = getQWeatherAssetsInfo();
  return normalizePageConfig(parsed, parsed, PAGE_TYPE);
}

function ensureDefaultWeatherTemplate(db) {
  return ensureDefaultTemplate(db, {
    pageType: PAGE_TYPE,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    defaultTemplateName: DEFAULT_TEMPLATE_NAME,
    defaultTemplateHtml: DEFAULT_TEMPLATE_HTML,
  });
}

function listWeatherTemplates(db, auth) {
  return listTemplates(db, auth, {
    pageType: PAGE_TYPE,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    defaultTemplateName: DEFAULT_TEMPLATE_NAME,
    defaultTemplateHtml: DEFAULT_TEMPLATE_HTML,
  });
}

function resolveWeatherTemplateHtml(db, config, auth) {
  return resolveTemplateHtml(db, config, auth, {
    pageType: PAGE_TYPE,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    defaultTemplateName: DEFAULT_TEMPLATE_NAME,
    defaultTemplateHtml: DEFAULT_TEMPLATE_HTML,
  });
}

function buildWeatherDataModel(db, device, extraData) {
  const base = buildCommonDataModel(db, device, extraData);
  base.qweather_assets = getQWeatherAssetsInfo();
  if (!base.weather || typeof base.weather !== "object") base.weather = {};
  base.weather.code = String(base.weather.code || "100");
  base.weather.text = String(base.weather.text || "Sunny");
  base.weather.temp = String(base.weather.temp || "26");
  base.weather.aqi = String(base.weather.aqi || "42");
  base.weather.humidity = String(base.weather.humidity || "43");
  base.weather.city = String(base.weather.city || "Shanghai");
  base.weather.updated_at = String(base.weather.updated_at || new Date().toISOString());
  return base;
}

async function renderWeatherBuffers({ config, templateHtml, dataModel }) {
  return await renderPageBuffers({
    config,
    templateHtml,
    dataModel,
    pageType: PAGE_TYPE,
  });
}

function resolveWeatherConfig(db, ownerId, deviceId) {
  return resolvePageConfig(db, ownerId, deviceId, {
    pageType: PAGE_TYPE,
    loadDefaultConfig: loadDefaultWeatherConfig,
  });
}

function getLatestWeatherImage(db, deviceId) {
  return getLatestPageImage(db, deviceId, { pageType: PAGE_TYPE });
}

function buildDeviceWeatherPayload({ deviceId, config, imageRow }) {
  const payload = buildDevicePagePayload({
    deviceId,
    config,
    imageRow,
    options: {
      pageType: PAGE_TYPE,
      defaultTemplateId: DEFAULT_TEMPLATE_ID,
      defaultTemplateName: DEFAULT_TEMPLATE_NAME,
    },
  });
  payload.qweather_assets = getQWeatherAssetsInfo();
  return payload;
}

function normalizeWeatherConfig(input) {
  return normalizePageConfig(input, loadDefaultWeatherConfig(), PAGE_TYPE);
}

module.exports = {
  PAGE_TYPE,
  configKey: configKeyForPage(PAGE_TYPE),
  templateKey: templateKeyForPage(PAGE_TYPE),
  imageKey: imageKeyForPage(PAGE_TYPE),
  DEFAULT_TEMPLATE_ID,
  DEFAULT_TEMPLATE_NAME,
  DEFAULT_TEMPLATE_HTML,
  loadDefaultWeatherConfig,
  loadDefaultConfig: loadDefaultWeatherConfig,
  normalizeWeatherConfig,
  normalizeConfig: normalizeWeatherConfig,
  ensureDefaultWeatherTemplate,
  ensureDefaultTemplate: ensureDefaultWeatherTemplate,
  listWeatherTemplates,
  listTemplates: listWeatherTemplates,
  resolveWeatherTemplateHtml,
  resolveTemplateHtml: resolveWeatherTemplateHtml,
  buildWeatherDataModel,
  buildDataModel: buildWeatherDataModel,
  renderWeatherBuffers,
  renderBuffers: renderWeatherBuffers,
  resolveWeatherConfig,
  resolveConfig: resolveWeatherConfig,
  getLatestWeatherImage,
  getLatestImage: getLatestWeatherImage,
  buildDeviceWeatherPayload,
  buildDevicePayload: buildDeviceWeatherPayload,
  getQWeatherAssetsInfo,
  deepMerge,
};
