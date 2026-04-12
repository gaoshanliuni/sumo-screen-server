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
  configKeyForPage,
  templateKeyForPage,
  imageKeyForPage,
} = require("./page_profile.service");

const PAGE_TYPE = "badgepage";
const DEFAULT_TEMPLATE_ID = "tpl_badge_default";
const DEFAULT_TEMPLATE_NAME = "Default Badge HTML";
const DEFAULT_CONFIG_PATH = path.join(__dirname, "../../config/default_badgepage.json");
const DEFAULT_TEMPLATE_HTML = `
<div data-x="120" data-y="130" data-size="120" data-weight="700" data-align="left">{{profile.name}}</div>
<div data-x="120" data-y="300" data-size="60" data-weight="400" data-align="left">{{profile.employee_no}}</div>
<div data-x="120" data-y="390" data-size="48" data-align="left">{{profile.department}}</div>
<div data-x="120" data-y="470" data-size="54" data-align="left">{{profile.title}}</div>
<div data-x="120" data-y="560" data-size="42" data-align="left">Desk: {{profile.workstation}}</div>
<div data-x="120" data-y="640" data-size="42" data-align="left">Status: {{profile.status}}</div>
<div data-x="120" data-y="1460" data-size="28" data-align="left">Updated: {{meta.rendered_at}}</div>
`;

function buildBuiltinBadgeConfig() {
  return {
    id: "badgepage_default",
    name: "Default Badge Page",
    enabled: true,
    version: 1,
    screen: { width: 2560, height: 1600 },
    template: {
      type: "default_html",
      template_id: DEFAULT_TEMPLATE_ID,
      template_name: DEFAULT_TEMPLATE_NAME,
      template_path: "builtin://badgepage/default",
      render_engine: "auto",
      render_mode: "hybrid",
    },
    image: {
      format: "epd4",
      preview_format: "png",
      render_source: "server",
      refresh_policy: "on-demand",
      cache_ttl_sec: 3600,
    },
    time_overlay: {
      enabled: false,
      x: 1880,
      y: 100,
      width: 620,
      height: 160,
      format: "HH:mm",
      font_size: 80,
      align: "right",
      refresh_interval_sec: 60,
      background_clear_mode: "fill-white",
      invert: false,
    },
    fallback: {
      enabled: true,
      mode: "local_text_badge",
    },
  };
}

function loadDefaultBadgeConfig() {
  let parsed = null;
  if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    try {
      parsed = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8"));
    } catch (error) {
      console.warn(
        `[badgepage] failed to parse default config at ${DEFAULT_CONFIG_PATH}, fallback to builtin. err=${
          error && error.message ? error.message : String(error)
        }`
      );
    }
  } else {
    console.warn(
      `[badgepage] default config not found at ${DEFAULT_CONFIG_PATH}, fallback to builtin.`
    );
  }
  if (!parsed || typeof parsed !== "object") {
    parsed = buildBuiltinBadgeConfig();
  }
  parsed.template = parsed.template || {};
  if (!parsed.template.template_id) parsed.template.template_id = DEFAULT_TEMPLATE_ID;
  return normalizePageConfig(parsed, parsed, PAGE_TYPE);
}

function ensureDefaultBadgeTemplate(db) {
  return ensureDefaultTemplate(db, {
    pageType: PAGE_TYPE,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    defaultTemplateName: DEFAULT_TEMPLATE_NAME,
    defaultTemplateHtml: DEFAULT_TEMPLATE_HTML,
  });
}

function listBadgeTemplates(db, auth) {
  return listTemplates(db, auth, {
    pageType: PAGE_TYPE,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    defaultTemplateName: DEFAULT_TEMPLATE_NAME,
    defaultTemplateHtml: DEFAULT_TEMPLATE_HTML,
  });
}

function resolveBadgeTemplateHtml(db, config, auth) {
  return resolveTemplateHtml(db, config, auth, {
    pageType: PAGE_TYPE,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    defaultTemplateName: DEFAULT_TEMPLATE_NAME,
    defaultTemplateHtml: DEFAULT_TEMPLATE_HTML,
  });
}

function buildBadgeDataModel(db, device, extraData) {
  return buildCommonDataModel(db, device, extraData);
}

async function renderBadgeBuffers({ config, templateHtml, dataModel }) {
  return await renderPageBuffers({
    config,
    templateHtml,
    dataModel,
    pageType: PAGE_TYPE,
  });
}

function resolveBadgeConfig(db, ownerId, deviceId) {
  return resolvePageConfig(db, ownerId, deviceId, {
    pageType: PAGE_TYPE,
    loadDefaultConfig: loadDefaultBadgeConfig,
  });
}

function getLatestBadgeImage(db, deviceId) {
  return getLatestPageImage(db, deviceId, { pageType: PAGE_TYPE });
}

function buildDeviceBadgePayload({ deviceId, config, imageRow }) {
  return buildDevicePagePayload({
    deviceId,
    config,
    imageRow,
    options: {
      pageType: PAGE_TYPE,
      defaultTemplateId: DEFAULT_TEMPLATE_ID,
      defaultTemplateName: DEFAULT_TEMPLATE_NAME,
    },
  });
}

function normalizeBadgeConfig(input) {
  return normalizePageConfig(input, loadDefaultBadgeConfig(), PAGE_TYPE);
}

module.exports = {
  PAGE_TYPE,
  configKey: configKeyForPage(PAGE_TYPE),
  templateKey: templateKeyForPage(PAGE_TYPE),
  imageKey: imageKeyForPage(PAGE_TYPE),
  DEFAULT_TEMPLATE_ID,
  DEFAULT_TEMPLATE_NAME,
  DEFAULT_TEMPLATE_HTML,
  loadDefaultBadgeConfig,
  loadDefaultConfig: loadDefaultBadgeConfig,
  normalizeBadgeConfig,
  normalizeConfig: normalizeBadgeConfig,
  ensureDefaultBadgeTemplate,
  ensureDefaultTemplate: ensureDefaultBadgeTemplate,
  listBadgeTemplates,
  listTemplates: listBadgeTemplates,
  resolveBadgeTemplateHtml,
  resolveTemplateHtml: resolveBadgeTemplateHtml,
  buildBadgeDataModel,
  buildDataModel: buildBadgeDataModel,
  renderBadgeBuffers,
  renderBuffers: renderBadgeBuffers,
  resolveBadgeConfig,
  resolveConfig: resolveBadgeConfig,
  getLatestBadgeImage,
  getLatestImage: getLatestBadgeImage,
  buildDeviceBadgePayload,
  buildDevicePayload: buildDeviceBadgePayload,
  deepMerge,
};
