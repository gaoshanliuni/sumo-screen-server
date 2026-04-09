const fs = require("fs");
const path = require("path");

const HttpError = require("../utils/httpError");
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

const PAGE_TYPE = "homepage";
const DEFAULT_TEMPLATE_ID = "tpl_home_default";
const DEFAULT_TEMPLATE_NAME = "Default Homepage HTML";
const DEFAULT_CONFIG_PATH = path.join(__dirname, "../../config/default_homepage.json");
const DEFAULT_TEMPLATE_HTML = `
<div data-x="120" data-y="120" data-size="126" data-weight="700" data-align="left">{{profile.name}}</div>
<div data-x="120" data-y="270" data-size="64" data-weight="400" data-align="left">{{profile.title}}</div>
<div data-x="120" data-y="370" data-size="48" data-align="left">{{profile.department}} · {{profile.workstation}}</div>
<div data-x="120" data-y="470" data-size="48" data-align="left">Status: {{profile.status}}</div>
<div data-x="120" data-y="660" data-size="52" data-weight="600" data-align="left">Today TODO</div>
<div data-x="120" data-y="735" data-size="42" data-align="left">{{todo_summary.text}}</div>
<div data-x="120" data-y="960" data-size="52" data-weight="600" data-align="left">Schedule</div>
<div data-x="120" data-y="1035" data-size="42" data-align="left">{{schedule_summary.text}}</div>
<div data-x="120" data-y="1415" data-size="30" data-align="left">Updated: {{meta.rendered_at}}</div>
`;

function loadDefaultHomepageConfig() {
  if (!fs.existsSync(DEFAULT_CONFIG_PATH)) throw new HttpError(500, "default homepage config missing");
  const parsed = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8"));
  parsed.template = parsed.template || {};
  if (!parsed.template.template_id) parsed.template.template_id = DEFAULT_TEMPLATE_ID;
  return normalizePageConfig(parsed, parsed, PAGE_TYPE);
}

function ensureDefaultHomepageTemplate(db) {
  return ensureDefaultTemplate(db, {
    pageType: PAGE_TYPE,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    defaultTemplateName: DEFAULT_TEMPLATE_NAME,
    defaultTemplateHtml: DEFAULT_TEMPLATE_HTML,
  });
}

function listHomepageTemplates(db, auth) {
  return listTemplates(db, auth, {
    pageType: PAGE_TYPE,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    defaultTemplateName: DEFAULT_TEMPLATE_NAME,
    defaultTemplateHtml: DEFAULT_TEMPLATE_HTML,
  });
}

function resolveHomepageTemplateHtml(db, config, auth) {
  return resolveTemplateHtml(db, config, auth, {
    pageType: PAGE_TYPE,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    defaultTemplateName: DEFAULT_TEMPLATE_NAME,
    defaultTemplateHtml: DEFAULT_TEMPLATE_HTML,
  });
}

function buildHomepageDataModel(db, device, extraData) {
  return buildCommonDataModel(db, device, extraData);
}

async function renderHomepageBuffers({ config, templateHtml, dataModel }) {
  return await renderPageBuffers({
    config,
    templateHtml,
    dataModel,
    pageType: PAGE_TYPE,
  });
}

function resolveHomepageConfig(db, ownerId, deviceId) {
  return resolvePageConfig(db, ownerId, deviceId, {
    pageType: PAGE_TYPE,
    loadDefaultConfig: loadDefaultHomepageConfig,
  });
}

function getLatestHomepageImage(db, deviceId) {
  return getLatestPageImage(db, deviceId, { pageType: PAGE_TYPE });
}

function buildDeviceHomepagePayload({ deviceId, config, imageRow }) {
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

function normalizeHomepageConfig(input) {
  return normalizePageConfig(input, loadDefaultHomepageConfig(), PAGE_TYPE);
}

module.exports = {
  PAGE_TYPE,
  configKey: configKeyForPage(PAGE_TYPE),
  templateKey: templateKeyForPage(PAGE_TYPE),
  imageKey: imageKeyForPage(PAGE_TYPE),
  DEFAULT_TEMPLATE_ID,
  DEFAULT_TEMPLATE_NAME,
  DEFAULT_TEMPLATE_HTML,
  loadDefaultHomepageConfig,
  loadDefaultConfig: loadDefaultHomepageConfig,
  normalizeHomepageConfig,
  normalizeConfig: normalizeHomepageConfig,
  ensureDefaultHomepageTemplate,
  ensureDefaultTemplate: ensureDefaultHomepageTemplate,
  listHomepageTemplates,
  listTemplates: listHomepageTemplates,
  resolveHomepageTemplateHtml,
  resolveTemplateHtml: resolveHomepageTemplateHtml,
  buildHomepageDataModel,
  buildDataModel: buildHomepageDataModel,
  renderHomepageBuffers,
  renderBuffers: renderHomepageBuffers,
  resolveHomepageConfig,
  resolveConfig: resolveHomepageConfig,
  getLatestHomepageImage,
  getLatestImage: getLatestHomepageImage,
  buildDeviceHomepagePayload,
  buildDevicePayload: buildDeviceHomepagePayload,
  deepMerge,
};
