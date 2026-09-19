const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { allowRoles } = require("../middleware/auth");
const { listDeviceTypes } = require("../services/device_type_registry.service");

const router = express.Router();
router.use(allowRoles("admin", "user"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.success(listDeviceTypes(), "ok");
  })
);

module.exports = router;
