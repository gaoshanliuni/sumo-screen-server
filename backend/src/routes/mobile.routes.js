const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { allowRoles } = require("../middleware/auth");
const { readDB } = require("../db/store");
const { buildMobileBootstrap, buildMobileOverview } = require("../services/mobile.service");
const { getCache } = require("../cache/redis");
const cacheKeys = require("../cache/cache_keys");
const config = require("../config");

const router = express.Router();
router.use(allowRoles("admin", "user"));

router.get(
  "/bootstrap",
  asyncHandler(async (req, res) => {
    const cache = getCache();
    const key = cacheKeys.mobileBootstrap(req.auth.userId || "", req.auth.role || "");
    const cached = await cache.get(key);
    if (cached) return res.success(cached, "ok");
    const db = await readDB();
    const payload = buildMobileBootstrap(db, req.auth);
    await cache.set(key, payload, config.redis.dashboardTtlSeconds || 10);
    return res.success(payload, "ok");
  })
);

router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(
      buildMobileOverview(db, req.auth, {
        status: req.query?.status || "",
        keyword: req.query?.keyword || "",
        page: req.query?.page || 1,
        pageSize: req.query?.pageSize || 20,
      }),
      "ok"
    );
  })
);

module.exports = router;
