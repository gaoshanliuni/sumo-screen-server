const { createPageRouter } = require("./page_profile.routes");
const badgepageService = require("../services/badgepage.service");

module.exports = createPageRouter({
  pageType: "badgepage",
  pageLabel: "桌牌页",
  eventPrefix: "badgepage",
  service: badgepageService,
});
