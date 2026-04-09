const { createPageRouter } = require("./page_profile.routes");
const homepageService = require("../services/homepage_page.service");

module.exports = createPageRouter({
  pageType: "homepage",
  pageLabel: "主页",
  eventPrefix: "homepage",
  service: homepageService,
});
