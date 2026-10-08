const { createPageRouter } = require("./page_profile.routes");
const weatherpageService = require("../services/weatherpage.service");

const router = createPageRouter({
  pageType: "weatherpage",
  pageLabel: "天气页",
  eventPrefix: "weatherpage",
  service: weatherpageService,
});

router.get("/qweather-assets", (req, res) => {
  res.success(weatherpageService.getQWeatherAssetsInfo(), "ok");
});

module.exports = router;
