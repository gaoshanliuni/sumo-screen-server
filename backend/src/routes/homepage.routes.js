const { createPageRouter } = require("./page_profile.routes");
const homepageService = require("../services/homepage_page.service");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const {
  runHomepageAutoPushNow,
  getHomepageAutoPushStatus,
} = require("../services/homepage_auto_push.service");

const router = createPageRouter({
  pageType: "homepage",
  pageLabel: "主页",
  eventPrefix: "homepage",
  service: homepageService,
});

router.get(
  "/auto-render/status",
  asyncHandler(async (req, res) => {
    const deviceId = String(req.query?.deviceId || "").trim();
    if (!deviceId) throw new HttpError(400, "deviceId不能为空");
    const status = await getHomepageAutoPushStatus({
      auth: req.auth,
      deviceId,
    });
    res.success(status, "ok");
  })
);

router.post(
  "/auto-render/run",
  asyncHandler(async (req, res) => {
    const deviceId = String(req.body?.deviceId || "").trim();
    if (!deviceId) throw new HttpError(400, "deviceId不能为空");
    const result = await runHomepageAutoPushNow({
      auth: req.auth,
      deviceId,
      reason: "manual_trigger",
      dataPatch:
        req.body?.data && typeof req.body.data === "object" && !Array.isArray(req.body.data)
          ? req.body.data
          : undefined,
      configPatch:
        req.body?.config && typeof req.body.config === "object" && !Array.isArray(req.body.config)
          ? req.body.config
          : undefined,
      templatePatch:
        req.body?.template && typeof req.body.template === "object" && !Array.isArray(req.body.template)
          ? req.body.template
          : undefined,
    });
    res.success(result, "自动渲染任务已执行");
  })
);

module.exports = router;
