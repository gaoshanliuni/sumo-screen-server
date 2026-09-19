const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { createNvsService } = require("../services/nvs/nvs.service");

const router = express.Router();
router.use(allowRoles("admin", "user"));

const nvsService = createNvsService();

router.get(
  "/devices/:deviceId/schema",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(nvsService.getSchema(db, req.auth, req.params.deviceId), "ok");
  })
);

router.get(
  "/devices/:deviceId/shadow",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(nvsService.getShadow(db, req.auth, req.params.deviceId), "ok");
  })
);

router.put(
  "/devices/:deviceId/values/:key",
  asyncHandler(async (req, res) => {
    let result = null;
    await updateDB(async (draft) => {
      result = await nvsService.setValue(draft, req.auth, req.params.deviceId, {
        key: req.params.key,
        value: req.body?.value,
        reboot: req.body?.reboot === true,
      });
    });
    res.success(result, "NVS写入已排队");
  })
);

router.post(
  "/devices/:deviceId/import",
  asyncHandler(async (req, res) => {
    let result = null;
    await updateDB(async (draft) => {
      result = await nvsService.importDeviceConfig(draft, req.auth, req.params.deviceId, req.body || {});
    });
    res.success(result, "NVS导入已排队");
  })
);

router.get(
  "/devices/:deviceId/export",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(nvsService.exportDeviceConfig(db, req.auth, req.params.deviceId), "ok");
  })
);

router.get(
  "/devices/:deviceId/backups",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(nvsService.listBackups(db, req.auth, req.params.deviceId), "ok");
  })
);

router.post(
  "/devices/:deviceId/backups/:backupId/restore",
  asyncHandler(async (req, res) => {
    let result = null;
    await updateDB(async (draft) => {
      result = await nvsService.restoreBackup(draft, req.auth, req.params.deviceId, req.params.backupId, {
        reboot: req.body?.reboot === true,
      });
    });
    res.success(result, "NVS备份恢复已排队");
  })
);

module.exports = router;
