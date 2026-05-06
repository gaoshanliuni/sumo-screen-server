# Firmware Launchpad Device Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ESP Launchpad browser flashing, one-time upload flashing, device type management, and device-resolution-aware previews to the ink-screen platform.

**Architecture:** Backend stores device types, device resolution fields, flash sessions, temporary flash files, and launch manifests. Frontend adds management UI and uses browser Web Serial via ESP Launchpad while sharing a single resolution/preview scaling composable across PageStudio and Dashboard previews. Existing OTA firmware APIs remain intact.

**Tech Stack:** Node.js 20, Express, MySQL-backed store with payload JSON tables, Mongo GridFS for uploaded binaries, Vue 3, Pinia, Element Plus, TypeScript, Vite.

---

## Working Notes

- The worktree is already dirty. Do not revert files you did not change.
- Keep route additions small and use service modules for pure logic.
- Existing backend has no unified test runner. Use focused Node scripts under `backend/scripts/` for RED/GREEN checks and `npm run build` in `frontend-vue` for frontend verification.
- Use `backend/src/routes/firmware_flash.routes.js` mounted at `/api/firmware/flash` before `/api/firmware`.
- Use `2560 x 1600` as the project fallback resolution.

## File Structure

- Create `backend/src/services/device_type.service.js`: pure normalization and resolution helpers for device types and devices.
- Create `backend/scripts/test_device_type_service.js`: Node assertions for device type and resolution rules.
- Modify `backend/src/db/store.js`: add `deviceTypes`, `firmwareFlashSessions`, `firmwareFlashTempFiles`, normalize new device fields, persist new collections.
- Create `backend/src/routes/device_type.routes.js`: CRUD routes for device types.
- Modify `backend/src/app.js`: mount `/api/device-types` and `/api/firmware/flash`.
- Modify `backend/src/routes/device.routes.js`: register/update/list with device type and resolution fields.
- Modify `backend/src/routes/hardware.routes.js`: auto-register accepts device type and resolution fields.
- Create `backend/src/services/firmware_flash.service.js`: flash args parsing, project-build scanning, manifest rendering, source/session helpers.
- Create `backend/scripts/test_firmware_flash_service.js`: Node assertions for project-build scanning and manifest generation.
- Create `backend/src/routes/firmware_flash.routes.js`: source listing, scan, one-time upload, prepare, manifest, files, status.
- Modify `frontend-vue/src/stores/devices.ts`: add device type and resolution fields.
- Create `frontend-vue/src/services/deviceTypes.ts`: frontend API types and calls for device type management.
- Create `frontend-vue/src/services/firmwareFlash.ts`: frontend API types and calls for launchpad flashing.
- Create `frontend-vue/src/composables/useDeviceResolution.ts`: shared resolution and scale helpers.
- Modify `frontend-vue/src/components/DeviceLassoPicker.vue`: display device type and resolution.
- Modify `frontend-vue/src/views/PageStudio.vue`: resolution-aware edit and delivery preview.
- Modify `frontend-vue/src/views/DashboardCore.vue`: device type management UI, device edit fields, firmware launchpad UI, homepage and image preview scaling.
- Optional after implementation passes: update `README.md` with the new browser flashing entry point and required Chromium/Web Serial note.

---

### Task 1: Device Type Pure Helpers

**Files:**
- Create: `backend/src/services/device_type.service.js`
- Create: `backend/scripts/test_device_type_service.js`
- Modify: `backend/package.json`

- [ ] **Step 1: Write the failing test**

Create `backend/scripts/test_device_type_service.js`:

```js
const assert = require("assert");
const {
  DEFAULT_DEVICE_TYPE,
  DEFAULT_DEVICE_RESOLUTION,
  normalizeDeviceTypeRow,
  ensureDefaultDeviceTypes,
  resolveDeviceType,
  normalizeDeviceResolutionFields,
  applyDeviceTypePatchToDevice,
} = require("../src/services/device_type.service");

function testNormalizeDeviceTypeRow() {
  const row = normalizeDeviceTypeRow({
    id: "dtype_epd_7",
    name: "EPD 7.3",
    defaultWidth: "800",
    defaultHeight: "480",
    description: "desktop panel",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.strictEqual(row.id, "dtype_epd_7");
  assert.strictEqual(row.name, "EPD 7.3");
  assert.strictEqual(row.defaultWidth, 800);
  assert.strictEqual(row.defaultHeight, 480);
  assert.strictEqual(row.description, "desktop panel");
}

function testEnsureDefaultDeviceTypes() {
  const rows = ensureDefaultDeviceTypes([]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, DEFAULT_DEVICE_TYPE.id);
  assert.strictEqual(rows[0].name, DEFAULT_DEVICE_TYPE.name);
  assert.strictEqual(rows[0].defaultWidth, DEFAULT_DEVICE_TYPE.defaultWidth);
  assert.strictEqual(rows[0].defaultHeight, DEFAULT_DEVICE_TYPE.defaultHeight);
  assert.ok(rows[0].createdAt);
  assert.ok(rows[0].updatedAt);

  const existing = ensureDefaultDeviceTypes([{ id: "dtype_custom", name: "custom", defaultWidth: 300, defaultHeight: 200 }]);
  assert.strictEqual(existing.length, 2);
  assert.strictEqual(existing[0].id, "dtype_custom");
  assert.strictEqual(existing[1].id, DEFAULT_DEVICE_TYPE.id);
}

function testResolveDeviceType() {
  const rows = ensureDefaultDeviceTypes([{ id: "dtype_wide", name: "wide", defaultWidth: 1600, defaultHeight: 900 }]);
  assert.strictEqual(resolveDeviceType(rows, "dtype_wide", "").id, "dtype_wide");
  assert.strictEqual(resolveDeviceType(rows, "", "wide").id, "dtype_wide");
  assert.strictEqual(resolveDeviceType(rows, "", "missing").id, DEFAULT_DEVICE_TYPE.id);
}

function testNormalizeDeviceResolutionFields() {
  const rows = ensureDefaultDeviceTypes([{ id: "dtype_small", name: "small", defaultWidth: 320, defaultHeight: 240 }]);
  const normalized = normalizeDeviceResolutionFields(
    { type: "small", width: "", height: 0 },
    rows
  );
  assert.strictEqual(normalized.deviceTypeId, "dtype_small");
  assert.strictEqual(normalized.deviceTypeName, "small");
  assert.strictEqual(normalized.width, 320);
  assert.strictEqual(normalized.height, 240);

  const manual = normalizeDeviceResolutionFields(
    { deviceTypeId: "dtype_small", width: 640, height: 384 },
    rows
  );
  assert.strictEqual(manual.width, 640);
  assert.strictEqual(manual.height, 384);
}

function testApplyDeviceTypePatchToDevice() {
  const rows = ensureDefaultDeviceTypes([{ id: "dtype_panel", name: "panel", defaultWidth: 1024, defaultHeight: 758 }]);
  const device = { id: "dev_1", type: "ink-screen", width: 2560, height: 1600 };
  const patched = applyDeviceTypePatchToDevice(device, { deviceTypeId: "dtype_panel" }, rows);
  assert.strictEqual(patched.deviceTypeId, "dtype_panel");
  assert.strictEqual(patched.deviceTypeName, "panel");
  assert.strictEqual(patched.type, "panel");
  assert.strictEqual(patched.width, 1024);
  assert.strictEqual(patched.height, 758);

  const manual = applyDeviceTypePatchToDevice(device, { deviceTypeId: "dtype_panel", width: 1200, height: 825 }, rows);
  assert.strictEqual(manual.width, 1200);
  assert.strictEqual(manual.height, 825);
}

testNormalizeDeviceTypeRow();
testEnsureDefaultDeviceTypes();
testResolveDeviceType();
testNormalizeDeviceResolutionFields();
testApplyDeviceTypePatchToDevice();

console.log("device_type.service tests passed", DEFAULT_DEVICE_RESOLUTION);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd backend
node scripts/test_device_type_service.js
```

Expected: FAIL with `Cannot find module '../src/services/device_type.service'`.

- [ ] **Step 3: Implement the helper module**

Create `backend/src/services/device_type.service.js`:

```js
const createId = require("../utils/id");

const DEFAULT_DEVICE_RESOLUTION = Object.freeze({ width: 2560, height: 1600 });

const DEFAULT_DEVICE_TYPE = Object.freeze({
  id: "dtype_ink_screen",
  name: "ink-screen",
  defaultWidth: DEFAULT_DEVICE_RESOLUTION.width,
  defaultHeight: DEFAULT_DEVICE_RESOLUTION.height,
  description: "默认水墨屏设备",
  createdAt: "",
  updatedAt: "",
});

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizePositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return Math.max(1, Number(fallback || 1));
  const int = Math.floor(num);
  return int > 0 ? int : Math.max(1, Number(fallback || 1));
}

function normalizeDeviceTypeRow(row = {}) {
  const ts = nowIso();
  const id = cleanString(row.id, createId("dtype"));
  const name = cleanString(row.name || row.deviceTypeName || row.type, DEFAULT_DEVICE_TYPE.name);
  return {
    id,
    name,
    defaultWidth: normalizePositiveInt(row.defaultWidth ?? row.width, DEFAULT_DEVICE_RESOLUTION.width),
    defaultHeight: normalizePositiveInt(row.defaultHeight ?? row.height, DEFAULT_DEVICE_RESOLUTION.height),
    description: cleanString(row.description),
    createdAt: cleanString(row.createdAt, ts),
    updatedAt: cleanString(row.updatedAt || row.createdAt, ts),
  };
}

function ensureDefaultDeviceTypes(rows = []) {
  const normalized = Array.isArray(rows) ? rows.map(normalizeDeviceTypeRow) : [];
  if (!normalized.some((item) => item.id === DEFAULT_DEVICE_TYPE.id || item.name === DEFAULT_DEVICE_TYPE.name)) {
    const ts = nowIso();
    normalized.push({ ...DEFAULT_DEVICE_TYPE, createdAt: ts, updatedAt: ts });
  }
  return normalized;
}

function resolveDeviceType(deviceTypes = [], deviceTypeId = "", typeName = "") {
  const rows = ensureDefaultDeviceTypes(deviceTypes);
  const id = cleanString(deviceTypeId);
  const name = cleanString(typeName);
  return (
    rows.find((item) => item.id === id) ||
    rows.find((item) => item.name === name) ||
    rows.find((item) => item.id === DEFAULT_DEVICE_TYPE.id) ||
    rows[0]
  );
}

function normalizeDeviceResolutionFields(device = {}, deviceTypes = []) {
  const resolved = resolveDeviceType(
    deviceTypes,
    device.deviceTypeId,
    device.deviceTypeName || device.type || device.model
  );
  const width = normalizePositiveInt(device.width, resolved.defaultWidth || DEFAULT_DEVICE_RESOLUTION.width);
  const height = normalizePositiveInt(device.height, resolved.defaultHeight || DEFAULT_DEVICE_RESOLUTION.height);
  return {
    deviceTypeId: resolved.id,
    deviceTypeName: resolved.name,
    width,
    height,
  };
}

function applyDeviceTypePatchToDevice(device = {}, patch = {}, deviceTypes = []) {
  const next = { ...device, ...patch };
  const typeChanged = Object.prototype.hasOwnProperty.call(patch, "deviceTypeId");
  const widthProvided = Object.prototype.hasOwnProperty.call(patch, "width");
  const heightProvided = Object.prototype.hasOwnProperty.call(patch, "height");
  const resolved = resolveDeviceType(
    deviceTypes,
    next.deviceTypeId,
    next.deviceTypeName || next.type || next.model
  );
  next.deviceTypeId = resolved.id;
  next.deviceTypeName = resolved.name;
  next.type = resolved.name;
  next.width = normalizePositiveInt(
    widthProvided ? patch.width : typeChanged ? resolved.defaultWidth : next.width,
    resolved.defaultWidth || DEFAULT_DEVICE_RESOLUTION.width
  );
  next.height = normalizePositiveInt(
    heightProvided ? patch.height : typeChanged ? resolved.defaultHeight : next.height,
    resolved.defaultHeight || DEFAULT_DEVICE_RESOLUTION.height
  );
  return next;
}

module.exports = {
  DEFAULT_DEVICE_TYPE,
  DEFAULT_DEVICE_RESOLUTION,
  normalizePositiveInt,
  normalizeDeviceTypeRow,
  ensureDefaultDeviceTypes,
  resolveDeviceType,
  normalizeDeviceResolutionFields,
  applyDeviceTypePatchToDevice,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd backend
node scripts/test_device_type_service.js
```

Expected: PASS with `device_type.service tests passed`.

- [ ] **Step 5: Add test script**

Modify `backend/package.json` scripts:

```json
"test:device-types": "node scripts/test_device_type_service.js"
```

Run:

```bash
cd backend
npm run test:device-types
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/device_type.service.js backend/scripts/test_device_type_service.js backend/package.json
git commit -m "feat: add device type normalization helpers"
```

---

### Task 2: Store Shape and Persistence

**Files:**
- Modify: `backend/src/db/store.js`
- Modify: `backend/scripts/test_device_type_service.js`

- [ ] **Step 1: Extend failing test for store-facing normalization**

Append to `backend/scripts/test_device_type_service.js` before the final `console.log`:

```js
function testNormalizeCollectionRowsForStore() {
  const rows = ensureDefaultDeviceTypes([{ name: "legacy-type", width: 400, height: 300 }]);
  const device = normalizeDeviceResolutionFields({ type: "legacy-type" }, rows);
  assert.strictEqual(device.deviceTypeName, "legacy-type");
  assert.strictEqual(device.width, 400);
  assert.strictEqual(device.height, 300);
}

testNormalizeCollectionRowsForStore();
```

- [ ] **Step 2: Run test to verify it still passes before store edit**

Run:

```bash
cd backend
npm run test:device-types
```

Expected: PASS. This confirms pure helpers are ready for store integration.

- [ ] **Step 3: Modify store imports and default state**

In `backend/src/db/store.js`, add near other service imports:

```js
const {
  DEFAULT_DEVICE_TYPE,
  ensureDefaultDeviceTypes,
  normalizeDeviceResolutionFields,
} = require("../services/device_type.service");
```

In both `getDefaultData()` and `createEmptyState()`, add:

```js
deviceTypes: [{ ...DEFAULT_DEVICE_TYPE, createdAt: now, updatedAt: now }],
firmwareFlashSessions: [],
firmwareFlashTempFiles: [],
```

- [ ] **Step 4: Normalize new collections and devices**

Inside `normalizeStoreShape(state)`, after `state.devices` initialization, add:

```js
state.deviceTypes = ensureDefaultDeviceTypes(state.deviceTypes);
state.firmwareFlashSessions = Array.isArray(state.firmwareFlashSessions) ? state.firmwareFlashSessions : [];
state.firmwareFlashTempFiles = Array.isArray(state.firmwareFlashTempFiles) ? state.firmwareFlashTempFiles : [];
```

Inside `state.devices.forEach((device) => { ... })`, after `device.type = device.type || "ink-screen";`, add:

```js
Object.assign(device, normalizeDeviceResolutionFields(device, state.deviceTypes));
```

- [ ] **Step 5: Persist new collections**

In `AUX_COLLECTION_SPECS`, add:

```js
createPayloadOnlySpec("deviceTypes", "device_types", "dtype"),
createPayloadOnlySpec("firmwareFlashSessions", "firmware_flash_sessions", "fflash"),
createPayloadOnlySpec("firmwareFlashTempFiles", "firmware_flash_temp_files", "fftmp"),
```

Place `deviceTypes` before page/template payload-only specs so it loads before future consumers inspect devices.

- [ ] **Step 6: Keep device metadata readable**

In the devices `toRecord` metadata object in `backend/src/db/store.js`, add:

```js
deviceTypeId: row.deviceTypeId || "",
deviceTypeName: row.deviceTypeName || "",
width: Number(row.width || 0),
height: Number(row.height || 0),
```

- [ ] **Step 7: Verify syntax and helper tests**

Run:

```bash
cd backend
node -c src/db/store.js
npm run test:device-types
```

Expected: both commands pass.

- [ ] **Step 8: Commit**

```bash
git add backend/src/db/store.js backend/scripts/test_device_type_service.js
git commit -m "feat: persist device types and resolutions"
```

---

### Task 3: Device Type Routes

**Files:**
- Create: `backend/src/routes/device_type.routes.js`
- Modify: `backend/src/app.js`

- [ ] **Step 1: Write route behavior checks as service-level assertions**

Add this block to `backend/scripts/test_device_type_service.js`:

```js
function testDeleteGuardLogic() {
  const typeId = "dtype_a";
  const devices = [{ id: "dev_1", deviceTypeId: typeId }, { id: "dev_2", deviceTypeId: "dtype_b" }];
  const count = devices.filter((device) => device.deviceTypeId === typeId).length;
  assert.strictEqual(count, 1);
}

testDeleteGuardLogic();
```

Run:

```bash
cd backend
npm run test:device-types
```

Expected: PASS. This locks the association count rule before adding the route.

- [ ] **Step 2: Create route file**

Create `backend/src/routes/device_type.routes.js`:

```js
const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { logOperation } = require("../utils/logging");
const {
  normalizeDeviceTypeRow,
  normalizePositiveInt,
  applyDeviceTypePatchToDevice,
} = require("../services/device_type.service");

const router = express.Router();

router.get(
  "/",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(db.deviceTypes || [], "ok");
  })
);

router.post(
  "/",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const name = String(payload.name || "").trim();
    if (!name) throw new HttpError(400, "设备种类名称不能为空");
    const width = normalizePositiveInt(payload.defaultWidth, 0);
    const height = normalizePositiveInt(payload.defaultHeight, 0);
    if (width <= 0 || height <= 0) throw new HttpError(400, "默认分辨率必须为正整数");

    const db = await readDB();
    if ((db.deviceTypes || []).some((item) => item.name === name)) {
      throw new HttpError(409, "设备种类名称已存在");
    }

    const now = new Date().toISOString();
    const row = normalizeDeviceTypeRow({
      name,
      defaultWidth: width,
      defaultHeight: height,
      description: payload.description || "",
      createdAt: now,
      updatedAt: now,
    });

    await updateDB((draft) => {
      draft.deviceTypes.push(row);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "device_type.create",
      targetType: "device_type",
      targetId: row.id,
      detail: { name: row.name },
    });

    res.success(row, "设备种类已创建");
  })
);

router.post(
  "/:typeId",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { typeId } = req.params;
    const payload = req.body || {};
    let updated = null;

    await updateDB((draft) => {
      const row = draft.deviceTypes.find((item) => item.id === typeId);
      if (!row) throw new HttpError(404, "设备种类不存在");
      const nextName = payload.name !== undefined ? String(payload.name || "").trim() : row.name;
      if (!nextName) throw new HttpError(400, "设备种类名称不能为空");
      const duplicate = draft.deviceTypes.find((item) => item.id !== typeId && item.name === nextName);
      if (duplicate) throw new HttpError(409, "设备种类名称已存在");

      row.name = nextName;
      if (payload.defaultWidth !== undefined) row.defaultWidth = normalizePositiveInt(payload.defaultWidth, row.defaultWidth);
      if (payload.defaultHeight !== undefined) row.defaultHeight = normalizePositiveInt(payload.defaultHeight, row.defaultHeight);
      if (payload.description !== undefined) row.description = String(payload.description || "");
      row.updatedAt = new Date().toISOString();

      draft.devices.forEach((device) => {
        if (device.deviceTypeId === row.id) {
          const patched = applyDeviceTypePatchToDevice(
            device,
            { deviceTypeId: row.id, width: device.width, height: device.height },
            draft.deviceTypes
          );
          Object.assign(device, patched, { updatedAt: new Date().toISOString() });
        }
      });

      updated = row;
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "device_type.update",
      targetType: "device_type",
      targetId: typeId,
      detail: payload,
    });

    res.success(updated, "设备种类已更新");
  })
);

router.post(
  "/:typeId/delete",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    const { typeId } = req.params;
    const db = await readDB();
    const existing = (db.deviceTypes || []).find((item) => item.id === typeId);
    if (!existing) throw new HttpError(404, "设备种类不存在");
    const linkedCount = (db.devices || []).filter((device) => device.deviceTypeId === typeId).length;
    if (linkedCount > 0) {
      throw new HttpError(400, `设备种类已关联 ${linkedCount} 台设备，请先迁移设备`);
    }

    await updateDB((draft) => {
      draft.deviceTypes = draft.deviceTypes.filter((item) => item.id !== typeId);
    });

    await logOperation({
      actorId: req.auth.userId,
      actorRole: "admin",
      action: "device_type.delete",
      targetType: "device_type",
      targetId: typeId,
      detail: { name: existing.name },
    });

    res.success({ id: typeId }, "设备种类已删除");
  })
);

module.exports = router;
```

- [ ] **Step 3: Mount route**

In `backend/src/app.js`, add:

```js
const deviceTypeRoutes = require("./routes/device_type.routes");
```

Mount after `/api/devices`:

```js
app.use("/api/device-types", authRequired, deviceTypeRoutes);
```

- [ ] **Step 4: Verify syntax**

Run:

```bash
cd backend
node -c src/routes/device_type.routes.js
node -c src/app.js
npm run test:device-types
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/device_type.routes.js backend/src/app.js backend/scripts/test_device_type_service.js
git commit -m "feat: add device type management api"
```

---

### Task 4: Device Routes and Hardware Auto-Register Fields

**Files:**
- Modify: `backend/src/routes/device.routes.js`
- Modify: `backend/src/routes/hardware.routes.js`
- Modify: `backend/scripts/test_device_type_service.js`

- [ ] **Step 1: Add failing helper assertion for explicit width override**

Add to `backend/scripts/test_device_type_service.js`:

```js
function testExplicitResolutionOverrideDuringRegister() {
  const rows = ensureDefaultDeviceTypes([{ id: "dtype_big", name: "big", defaultWidth: 1800, defaultHeight: 1200 }]);
  const normalized = normalizeDeviceResolutionFields({ deviceTypeId: "dtype_big", width: 900, height: 600 }, rows);
  assert.strictEqual(normalized.deviceTypeName, "big");
  assert.strictEqual(normalized.width, 900);
  assert.strictEqual(normalized.height, 600);
}

testExplicitResolutionOverrideDuringRegister();
```

Run:

```bash
cd backend
npm run test:device-types
```

Expected: PASS.

- [ ] **Step 2: Import helper in device routes**

In `backend/src/routes/device.routes.js`, add:

```js
const { applyDeviceTypePatchToDevice } = require("../services/device_type.service");
```

- [ ] **Step 3: Extend admin register payload**

In `POST /register`, destructure:

```js
const {
  mac: rawMac,
  ownerId,
  type = "ink-screen",
  remark = "",
  displayName = "",
  deviceTypeId = "",
  width,
  height,
} = req.body || {};
```

Before `const device = { ... }`, compute:

```js
const resolutionPatch = applyDeviceTypePatchToDevice(
  { type, deviceTypeId, width, height },
  { deviceTypeId: deviceTypeId || "", width, height },
  db.deviceTypes || []
);
```

Inside the new device object, add:

```js
type: resolutionPatch.type || type,
deviceTypeId: resolutionPatch.deviceTypeId,
deviceTypeName: resolutionPatch.deviceTypeName,
width: resolutionPatch.width,
height: resolutionPatch.height,
```

Remove the earlier duplicate `type` assignment if it remains in the object.

- [ ] **Step 4: Extend update allow-list and patch normalization**

In `POST /:deviceId`, extend admin `allowedFields` with:

```js
"deviceTypeId", "width", "height"
```

After displayName normalization and before ownerId handling, add:

```js
if (req.auth.role === "admin" && (patch.deviceTypeId !== undefined || patch.width !== undefined || patch.height !== undefined)) {
  const merged = applyDeviceTypePatchToDevice(current, patch, db.deviceTypes || []);
  patch.deviceTypeId = merged.deviceTypeId;
  patch.deviceTypeName = merged.deviceTypeName;
  patch.type = merged.type;
  patch.width = merged.width;
  patch.height = merged.height;
}
```

- [ ] **Step 5: Include fields in device keyword search**

In `GET /api/devices` keyword merge string, append:

```js
${item.deviceTypeName || ""} ${item.width || ""}x${item.height || ""}
```

Do the same inside batch delete `deleteAll` keyword merge.

- [ ] **Step 6: Import helper in hardware routes**

In `backend/src/routes/hardware.routes.js`, add:

```js
const { applyDeviceTypePatchToDevice } = require("../services/device_type.service");
```

- [ ] **Step 7: Extend auto-register internals**

Update `applyAutoRegisterOnDraft` signature:

```js
function applyAutoRegisterOnDraft({
  draft,
  mac,
  type = "ink-screen",
  remark = "",
  simulated = false,
  deviceTypeId = "",
  width,
  height,
  nowIso,
  expiresAt,
}) {
```

Before creating `device`, compute:

```js
const resolutionPatch = applyDeviceTypePatchToDevice(
  { type, deviceTypeId, width, height },
  { deviceTypeId: deviceTypeId || "", width, height },
  draft.deviceTypes || []
);
```

Inside new device object, add:

```js
type: resolutionPatch.type || type,
deviceTypeId: resolutionPatch.deviceTypeId,
deviceTypeName: resolutionPatch.deviceTypeName,
width: resolutionPatch.width,
height: resolutionPatch.height,
```

- [ ] **Step 8: Accept fields on public auto-register**

In `runAutoRegisterFlow`, accept `deviceTypeId`, `width`, `height` and pass them through to `applyAutoRegisterOnDraft`.

In `POST /auto-register`, destructure and pass:

```js
const { mac: rawMac, type = "ink-screen", remark = "", simulated = false, deviceTypeId = "", width, height } = req.body || {};
```

- [ ] **Step 9: Verify syntax and helper tests**

Run:

```bash
cd backend
node -c src/routes/device.routes.js
node -c src/routes/hardware.routes.js
npm run test:device-types
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add backend/src/routes/device.routes.js backend/src/routes/hardware.routes.js backend/scripts/test_device_type_service.js
git commit -m "feat: add device resolution fields to devices"
```

---

### Task 5: Firmware Flash Pure Service

**Files:**
- Create: `backend/src/services/firmware_flash.service.js`
- Create: `backend/scripts/test_firmware_flash_service.js`
- Modify: `backend/package.json`

- [ ] **Step 1: Write failing flash service test**

Create `backend/scripts/test_firmware_flash_service.js`:

```js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseFlashArgsText,
  normalizeFlashFiles,
  scanProjectBuild,
  buildLaunchpadManifestToml,
  buildLaunchUrl,
} = require("../src/services/firmware_flash.service");

function makeTempBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-build-"));
  fs.writeFileSync(path.join(dir, "flash_project_args"), [
    "--flash_mode dio --flash_freq 80m --flash_size 16MB",
    "0x0 bootloader/bootloader.bin",
    "0x10000 idfchonggouepd.bin",
    "0x8000 partition_table/partition-table.bin",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "bootloader.bin"), Buffer.from("boot"));
  fs.writeFileSync(path.join(dir, "firmware.bin"), Buffer.from("app"));
  fs.writeFileSync(path.join(dir, "partitions.bin"), Buffer.from("part"));
  return dir;
}

function testParseFlashArgsText() {
  const parsed = parseFlashArgsText("--flash_mode dio --flash_freq 80m --flash_size 16MB\n0x10000 firmware.bin\n");
  assert.strictEqual(parsed.flashMode, "dio");
  assert.strictEqual(parsed.flashFreq, "80m");
  assert.strictEqual(parsed.flashSize, "16MB");
  assert.deepStrictEqual(parsed.files, [{ offset: "0x10000", file: "firmware.bin" }]);
}

function testNormalizeFlashFilesWithFallback() {
  const buildDir = makeTempBuild();
  const files = normalizeFlashFiles(buildDir, [
    { offset: "0x0", file: "bootloader/bootloader.bin" },
    { offset: "0x10000", file: "idfchonggouepd.bin" },
    { offset: "0x8000", file: "partition_table/partition-table.bin" },
  ]);
  assert.strictEqual(files.length, 3);
  assert.strictEqual(path.basename(files[0].absolutePath), "bootloader.bin");
  assert.strictEqual(path.basename(files[1].absolutePath), "firmware.bin");
  assert.strictEqual(path.basename(files[2].absolutePath), "partitions.bin");
}

function testScanProjectBuild() {
  const buildDir = makeTempBuild();
  const scan = scanProjectBuild({ buildDir, projectName: "idfchonggouepd", envName: "test_env" });
  assert.strictEqual(scan.projectName, "idfchonggouepd");
  assert.strictEqual(scan.envName, "test_env");
  assert.strictEqual(scan.chip, "esp32s3");
  assert.strictEqual(scan.files.length, 3);
  assert.strictEqual(scan.flashMode, "dio");
}

function testBuildLaunchpadManifestToml() {
  const manifest = buildLaunchpadManifestToml({
    name: "Ink Screen",
    chip: "esp32s3",
    files: [
      { offset: "0x0", url: "http://localhost/api/file/bootloader.bin" },
      { offset: "0x10000", url: "http://localhost/api/file/app.bin" },
    ],
  });
  assert.ok(manifest.includes('chip = "esp32s3"'));
  assert.ok(manifest.includes('address = "0x10000"'));
  assert.ok(manifest.includes("http://localhost/api/file/app.bin"));
}

function testBuildLaunchUrl() {
  const launchUrl = buildLaunchUrl("https://example.test/api/manifest.toml");
  assert.ok(launchUrl.startsWith("https://espressif.github.io/esp-launchpad/"));
  assert.ok(launchUrl.includes(encodeURIComponent("https://example.test/api/manifest.toml")));
}

testParseFlashArgsText();
testNormalizeFlashFilesWithFallback();
testScanProjectBuild();
testBuildLaunchpadManifestToml();
testBuildLaunchUrl();

console.log("firmware_flash.service tests passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd backend
node scripts/test_firmware_flash_service.js
```

Expected: FAIL with `Cannot find module '../src/services/firmware_flash.service'`.

- [ ] **Step 3: Implement service module**

Create `backend/src/services/firmware_flash.service.js` with these exported functions:

```js
const fs = require("fs");
const path = require("path");

const DEFAULT_PROJECT_BUILD = Object.freeze({
  projectName: "idfchonggouepd",
  envName: "4d_systems_esp32s3_gen4_r8n16",
  buildDir: "D:\\idfchonggouepd\\.pio\\build\\4d_systems_esp32s3_gen4_r8n16",
  chip: "esp32s3",
  flashMode: "dio",
  flashFreq: "80m",
  flashSize: "16MB",
});

function clean(value) {
  return String(value || "").trim();
}

function parseFlashArgsText(text = "") {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0] || "";
  const flashMode = first.match(/--flash_mode\s+(\S+)/)?.[1] || DEFAULT_PROJECT_BUILD.flashMode;
  const flashFreq = first.match(/--flash_freq\s+(\S+)/)?.[1] || DEFAULT_PROJECT_BUILD.flashFreq;
  const flashSize = first.match(/--flash_size\s+(\S+)/)?.[1] || DEFAULT_PROJECT_BUILD.flashSize;
  const files = lines
    .slice(first.startsWith("--") ? 1 : 0)
    .map((line) => line.split(/\s+/))
    .filter((parts) => /^0x[0-9a-f]+$/i.test(parts[0] || "") && parts[1])
    .map((parts) => ({ offset: parts[0], file: parts[1] }));
  return { flashMode, flashFreq, flashSize, files };
}

function parseFlasherJson(buildDir) {
  const filePath = path.join(buildDir, "flasher_args.json");
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const flashSettings = parsed.flash_settings || {};
  const files = Object.entries(parsed.flash_files || {}).map(([offset, file]) => ({ offset, file }));
  return {
    flashMode: clean(flashSettings.flash_mode) || DEFAULT_PROJECT_BUILD.flashMode,
    flashFreq: clean(flashSettings.flash_freq) || DEFAULT_PROJECT_BUILD.flashFreq,
    flashSize: clean(flashSettings.flash_size) || DEFAULT_PROJECT_BUILD.flashSize,
    chip: clean(parsed.extra_esptool_args?.chip) || DEFAULT_PROJECT_BUILD.chip,
    files,
  };
}

function fallbackFileCandidates(file) {
  const base = path.basename(clean(file));
  const candidates = [clean(file), base];
  if (base === "idfchonggouepd.bin") candidates.push("firmware.bin");
  if (base === "partition-table.bin") candidates.push("partitions.bin");
  if (base === "bootloader.bin") candidates.push("bootloader.bin");
  return [...new Set(candidates.filter(Boolean))];
}

function resolveBuildFile(buildDir, file) {
  for (const candidate of fallbackFileCandidates(file)) {
    const abs = path.resolve(buildDir, candidate);
    if (abs.startsWith(path.resolve(buildDir)) && fs.existsSync(abs)) return abs;
  }
  return "";
}

function normalizeFlashFiles(buildDir, files = []) {
  return files.map((item) => {
    const absolutePath = resolveBuildFile(buildDir, item.file);
    return {
      offset: clean(item.offset),
      file: clean(item.file),
      absolutePath,
      fileName: absolutePath ? path.basename(absolutePath) : path.basename(clean(item.file)),
      size: absolutePath ? fs.statSync(absolutePath).size : 0,
    };
  });
}

function scanProjectBuild(options = {}) {
  const buildDir = path.resolve(clean(options.buildDir) || DEFAULT_PROJECT_BUILD.buildDir);
  if (!fs.existsSync(buildDir)) {
    const error = new Error(`项目构建产物目录不存在: ${buildDir}`);
    error.status = 404;
    throw error;
  }
  const jsonConfig = parseFlasherJson(buildDir);
  let parsed = jsonConfig;
  if (!parsed) {
    const argsFile = ["flash_project_args", "flash_args"].map((name) => path.join(buildDir, name)).find((file) => fs.existsSync(file));
    if (!argsFile) {
      const error = new Error("未找到 flasher_args.json、flash_project_args 或 flash_args");
      error.status = 400;
      throw error;
    }
    parsed = parseFlashArgsText(fs.readFileSync(argsFile, "utf8"));
  }
  const files = normalizeFlashFiles(buildDir, parsed.files || []);
  const missing = files.filter((item) => !item.absolutePath);
  if (missing.length) {
    const error = new Error(`刷机文件不存在: ${missing.map((item) => item.file).join(", ")}`);
    error.status = 400;
    throw error;
  }
  return {
    sourceType: "project-build",
    projectName: clean(options.projectName) || DEFAULT_PROJECT_BUILD.projectName,
    envName: clean(options.envName) || DEFAULT_PROJECT_BUILD.envName,
    buildDir,
    chip: clean(parsed.chip) || clean(options.chip) || DEFAULT_PROJECT_BUILD.chip,
    flashMode: clean(parsed.flashMode) || DEFAULT_PROJECT_BUILD.flashMode,
    flashFreq: clean(parsed.flashFreq) || DEFAULT_PROJECT_BUILD.flashFreq,
    flashSize: clean(parsed.flashSize) || DEFAULT_PROJECT_BUILD.flashSize,
    files,
  };
}

function tomlEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildLaunchpadManifestToml({ name = "Ink Screen Firmware", chip = "esp32s3", files = [] } = {}) {
  const lines = [
    'name = "' + tomlEscape(name) + '"',
    'chip = "' + tomlEscape(chip) + '"',
    "",
  ];
  files.forEach((file) => {
    lines.push("[[flash_files]]");
    lines.push('address = "' + tomlEscape(file.offset) + '"');
    lines.push('url = "' + tomlEscape(file.url) + '"');
    lines.push("");
  });
  return lines.join("\n");
}

function buildLaunchUrl(manifestUrl) {
  return `https://espressif.github.io/esp-launchpad/?flashConfigURL=${encodeURIComponent(manifestUrl)}`;
}

module.exports = {
  DEFAULT_PROJECT_BUILD,
  parseFlashArgsText,
  normalizeFlashFiles,
  scanProjectBuild,
  buildLaunchpadManifestToml,
  buildLaunchUrl,
};
```

- [ ] **Step 4: Add test script and run**

Modify `backend/package.json` scripts:

```json
"test:firmware-flash": "node scripts/test_firmware_flash_service.js"
```

Run:

```bash
cd backend
npm run test:firmware-flash
```

Expected: PASS with `firmware_flash.service tests passed`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/firmware_flash.service.js backend/scripts/test_firmware_flash_service.js backend/package.json
git commit -m "feat: add firmware flash manifest helpers"
```

---

### Task 6: Firmware Flash API Routes

**Files:**
- Create: `backend/src/routes/firmware_flash.routes.js`
- Modify: `backend/src/app.js`
- Modify: `backend/src/db/store.js`

- [ ] **Step 1: Add session collections to store if not present**

Confirm Task 2 added:

```js
firmwareFlashSessions: [],
firmwareFlashTempFiles: [],
```

and payload-only specs for both collections. If they are missing, add them now and run:

```bash
cd backend
node -c src/db/store.js
```

Expected: syntax passes.

- [ ] **Step 2: Create route file**

Create `backend/src/routes/firmware_flash.routes.js`:

```js
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const createId = require("../utils/id");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDB } = require("../db/store");
const { ensureDeviceAccess } = require("../utils/access");
const { getGridBucket, ObjectId } = require("../utils/mongo");
const { logOperation } = require("../utils/logging");
const {
  DEFAULT_PROJECT_BUILD,
  scanProjectBuild,
  buildLaunchpadManifestToml,
  buildLaunchUrl,
} = require("../services/firmware_flash.service");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 120 * 1024 * 1024 } });

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function toAbsoluteUrl(req, pathValue) {
  const configured = String(process.env.PUBLIC_ORIGIN || "").trim();
  const origin = configured || `${req.protocol}://${req.get("host")}`;
  return `${origin}${pathValue}`;
}

async function getFlashBucket() {
  return getGridBucket("firmware_flash_temp_files");
}

function assertStatus(status) {
  if (!["pending", "flashing", "success", "failed"].includes(String(status || ""))) {
    throw new HttpError(400, "刷机状态不合法");
  }
}

router.get(
  "/sources",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(
      {
        library: db.firmwares || [],
        projectBuilds: [DEFAULT_PROJECT_BUILD],
        url: { enabled: true, defaultOffset: "0x10000" },
        oneTimeUpload: { enabled: req.auth.role === "admin", maxSize: 120 * 1024 * 1024 },
      },
      "ok"
    );
  })
);

router.post(
  "/project-build/scan",
  allowRoles("admin"),
  asyncHandler(async (req, res) => {
    try {
      const scan = scanProjectBuild(req.body || {});
      res.success(scan, "项目构建产物扫描成功");
    } catch (error) {
      throw new HttpError(error.status || 500, error.message || "项目构建产物扫描失败");
    }
  })
);

router.post(
  "/one-time-upload",
  allowRoles("admin"),
  upload.array("files", 8),
  asyncHandler(async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) throw new HttpError(400, "请上传刷机文件");
    const roles = Array.isArray(req.body.role) ? req.body.role : [req.body.role];
    const offsets = Array.isArray(req.body.offset) ? req.body.offset : [req.body.offset];
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const sourceRef = createId("ffsrc");
    const bucket = await getFlashBucket();
    const rows = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const role = String(roles[index] || (files.length === 1 ? "app" : "custom")).trim() || "custom";
      const offset = String(offsets[index] || (files.length === 1 ? "0x10000" : "")).trim();
      if (!/^0x[0-9a-f]+$/i.test(offset)) throw new HttpError(400, `第 ${index + 1} 个刷机文件缺少合法 offset`);
      const uploadStream = bucket.openUploadStream(`${sourceRef}_${file.originalname}`, {
        contentType: file.mimetype,
        metadata: { sourceRef, role, offset, originalName: file.originalname },
      });
      const gridId = await new Promise((resolve, reject) => {
        uploadStream.on("error", reject);
        uploadStream.on("finish", () => resolve(String(uploadStream.id)));
        uploadStream.end(file.buffer);
      });
      rows.push({
        id: createId("fftmp"),
        sourceRef,
        sessionId: "",
        originalName: file.originalname || `file-${index + 1}.bin`,
        gridId,
        mime: file.mimetype || "application/octet-stream",
        size: file.size,
        sha256: sha256Hex(file.buffer),
        offset,
        role,
        createdAt: nowIso,
        expiresAt,
      });
    }

    await updateDB((draft) => {
      draft.firmwareFlashTempFiles.unshift(...rows);
    });

    res.success({ sourceRef, files: rows, expiresAt }, "一次性刷机文件已上传");
  })
);

router.post(
  "/prepare",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const { deviceId, sourceType, sourceRef = "", url = "" } = req.body || {};
    if (!deviceId) throw new HttpError(400, "deviceId不能为空");
    if (!sourceType) throw new HttpError(400, "sourceType不能为空");
    const db = await readDB();
    ensureDeviceAccess(db, req.auth, deviceId);

    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const sessionId = createId("fflash");
    const manifestPath = `/api/firmware/flash/sessions/${sessionId}/manifest.toml`;

    let fileRefs = [];
    if (sourceType === "project-build") {
      const scan = scanProjectBuild(req.body.projectBuild || {});
      fileRefs = scan.files.map((file) => ({ kind: "project", offset: file.offset, absolutePath: file.absolutePath, fileName: file.fileName }));
    } else if (sourceType === "one-time-upload") {
      fileRefs = (db.firmwareFlashTempFiles || [])
        .filter((file) => file.sourceRef === sourceRef && new Date(file.expiresAt).getTime() > Date.now())
        .map((file) => ({ kind: "temp", offset: file.offset, fileId: file.id, fileName: file.originalName }));
      if (!fileRefs.length) throw new HttpError(404, "一次性上传文件不存在或已过期");
    } else if (sourceType === "library") {
      const fw = (db.firmwares || []).find((item) => item.id === sourceRef);
      if (!fw) throw new HttpError(404, "固件不存在");
      fileRefs = [{ kind: "library", offset: "0x10000", firmwareId: fw.id, fileName: fw.fileName || `${fw.id}.bin` }];
    } else if (sourceType === "url") {
      const cleanUrl = String(url || "").trim();
      if (!/^https?:\/\//i.test(cleanUrl)) throw new HttpError(400, "固件 URL 必须是 http 或 https");
      fileRefs = [{ kind: "url", offset: String(req.body.offset || "0x10000"), url: cleanUrl, fileName: path.basename(cleanUrl.split("?")[0]) || "firmware.bin" }];
    } else {
      throw new HttpError(400, "sourceType不合法");
    }

    const session = {
      id: sessionId,
      deviceId,
      sourceType,
      sourceRef: String(sourceRef || url || ""),
      manifestUrl: manifestPath,
      fileRefs,
      status: "pending",
      message: "待开始",
      createdBy: { role: req.auth.role, id: req.auth.userId || req.auth.deviceId || "" },
      createdAt: nowIso,
      updatedAt: nowIso,
      finishedAt: "",
      expiresAt,
    };

    await updateDB((draft) => {
      draft.firmwareFlashSessions.unshift(session);
    });

    const manifestUrl = toAbsoluteUrl(req, manifestPath);
    const launchUrl = buildLaunchUrl(manifestUrl);
    res.success({ sessionId, manifestUrl, launchUrl }, "刷机会话已准备");
  })
);

router.get(
  "/sessions/:sessionId/manifest.toml",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const session = (db.firmwareFlashSessions || []).find((item) => item.id === req.params.sessionId);
    if (!session) throw new HttpError(404, "刷机会话不存在");
    ensureDeviceAccess(db, req.auth, session.deviceId);
    const files = (session.fileRefs || []).map((file, index) => ({
      offset: file.offset,
      url: file.kind === "url" ? file.url : toAbsoluteUrl(req, `/api/firmware/flash/sessions/${session.id}/files/${index}`),
    }));
    const toml = buildLaunchpadManifestToml({ name: "Ink Screen Firmware", chip: "esp32s3", files });
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(toml);
  })
);

router.get(
  "/sessions/:sessionId/files/:index",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const session = (db.firmwareFlashSessions || []).find((item) => item.id === req.params.sessionId);
    if (!session) throw new HttpError(404, "刷机会话不存在");
    ensureDeviceAccess(db, req.auth, session.deviceId);
    const file = (session.fileRefs || [])[Number(req.params.index)];
    if (!file) throw new HttpError(404, "刷机文件不存在");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.fileName || "firmware.bin")}"`);
    if (file.kind === "project") return res.sendFile(file.absolutePath);
    if (file.kind === "library") return res.redirect(302, `/api/firmware/${file.firmwareId}/download`);
    if (file.kind === "temp") {
      const temp = (db.firmwareFlashTempFiles || []).find((item) => item.id === file.fileId);
      if (!temp) throw new HttpError(404, "临时文件不存在");
      const bucket = await getFlashBucket();
      return bucket.openDownloadStream(new ObjectId(String(temp.gridId))).pipe(res);
    }
    throw new HttpError(400, "刷机文件类型不支持下载");
  })
);

router.post(
  "/sessions/:sessionId/status",
  allowRoles("admin", "user"),
  asyncHandler(async (req, res) => {
    const status = String(req.body?.status || "").trim();
    assertStatus(status);
    const message = String(req.body?.message || "").trim();
    let updated = null;
    await updateDB((draft) => {
      const session = draft.firmwareFlashSessions.find((item) => item.id === req.params.sessionId);
      if (!session) throw new HttpError(404, "刷机会话不存在");
      session.status = status;
      session.message = message || status;
      session.updatedAt = new Date().toISOString();
      if (status === "success" || status === "failed") session.finishedAt = session.updatedAt;
      updated = session;
    });
    await logOperation({
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: "firmware.flash_status",
      targetType: "firmware_flash_session",
      targetId: req.params.sessionId,
      detail: { status, message },
    });
    res.success(updated, "刷机状态已更新");
  })
);

module.exports = router;
```

- [ ] **Step 3: Mount route before legacy firmware routes**

In `backend/src/app.js`, add:

```js
const firmwareFlashRoutes = require("./routes/firmware_flash.routes");
```

Mount before `app.use("/api/firmware", authRequired, firmwareRoutes);`:

```js
app.use("/api/firmware/flash", authRequired, firmwareFlashRoutes);
```

- [ ] **Step 4: Verify syntax and service tests**

Run:

```bash
cd backend
node -c src/routes/firmware_flash.routes.js
node -c src/app.js
npm run test:firmware-flash
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/firmware_flash.routes.js backend/src/app.js backend/src/db/store.js
git commit -m "feat: add firmware flash api"
```

---

### Task 7: Frontend Shared Resolution Composable

**Files:**
- Create: `frontend-vue/src/composables/useDeviceResolution.ts`
- Modify: `frontend-vue/src/stores/devices.ts`

- [ ] **Step 1: Write composable file with exported pure helpers first**

Create `frontend-vue/src/composables/useDeviceResolution.ts`:

```ts
import { computed, type Ref } from "vue";

export type DeviceResolution = {
  width: number;
  height: number;
};

export const DEFAULT_DEVICE_RESOLUTION: DeviceResolution = Object.freeze({ width: 2560, height: 1600 });

export function normalizeDeviceResolution(input: unknown): DeviceResolution {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const width = Math.floor(Number(value.width || 0));
  const height = Math.floor(Number(value.height || 0));
  return {
    width: width > 0 ? width : DEFAULT_DEVICE_RESOLUTION.width,
    height: height > 0 ? height : DEFAULT_DEVICE_RESOLUTION.height,
  };
}

export function getAspectRatio(resolution: DeviceResolution): number {
  const safe = normalizeDeviceResolution(resolution);
  return safe.width / safe.height;
}

export function getPreviewScale(options: {
  sourceWidth: number;
  sourceHeight: number;
  maxWidth: number;
  maxHeight?: number;
  allowUpscale?: boolean;
}): number {
  const sourceWidth = Math.max(1, Math.floor(Number(options.sourceWidth || 1)));
  const sourceHeight = Math.max(1, Math.floor(Number(options.sourceHeight || 1)));
  const maxWidth = Math.max(1, Math.floor(Number(options.maxWidth || sourceWidth)));
  const maxHeight = options.maxHeight ? Math.max(1, Math.floor(Number(options.maxHeight))) : Number.POSITIVE_INFINITY;
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return options.allowUpscale ? scale : Math.min(1, scale);
}

export function useDeviceResolution<T extends { id: string; width?: number; height?: number }>(
  devicesRef: Ref<T[]>,
  selectedDeviceIdRef: Ref<string>
) {
  const selectedDevice = computed(() => devicesRef.value.find((item) => item.id === selectedDeviceIdRef.value) || null);
  const resolution = computed(() => normalizeDeviceResolution(selectedDevice.value || {}));
  const aspectRatio = computed(() => getAspectRatio(resolution.value));
  return { selectedDevice, resolution, aspectRatio };
}
```

- [ ] **Step 2: Extend device store type**

In `frontend-vue/src/stores/devices.ts`, add to `DeviceInfo`:

```ts
  deviceTypeId?: string;
  deviceTypeName?: string;
  width?: number;
  height?: number;
```

Update local keyword merge to include:

```ts
${item.deviceTypeName || ""} ${item.width || ""}x${item.height || ""}
```

- [ ] **Step 3: Verify frontend build**

Run:

```bash
cd frontend-vue
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend-vue/src/composables/useDeviceResolution.ts frontend-vue/src/stores/devices.ts
git commit -m "feat: add shared device resolution composable"
```

---

### Task 8: Device Type Frontend UI and Device Fields

**Files:**
- Create: `frontend-vue/src/services/deviceTypes.ts`
- Modify: `frontend-vue/src/components/DeviceLassoPicker.vue`
- Modify: `frontend-vue/src/views/DashboardCore.vue`

- [ ] **Step 1: Create device type service**

Create `frontend-vue/src/services/deviceTypes.ts`:

```ts
import { apiRequest } from "./api";

export type DeviceTypeRow = {
  id: string;
  name: string;
  defaultWidth: number;
  defaultHeight: number;
  description: string;
  createdAt?: string;
  updatedAt?: string;
};

export type DeviceTypePayload = {
  name: string;
  defaultWidth: number;
  defaultHeight: number;
  description: string;
};

export function fetchDeviceTypes(token: string) {
  return apiRequest<DeviceTypeRow[]>("/api/device-types", { token });
}

export function createDeviceType(token: string, payload: DeviceTypePayload) {
  return apiRequest<DeviceTypeRow>("/api/device-types", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export function updateDeviceType(token: string, id: string, payload: Partial<DeviceTypePayload>) {
  return apiRequest<DeviceTypeRow>(`/api/device-types/${encodeURIComponent(id)}`, {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export function deleteDeviceType(token: string, id: string) {
  return apiRequest<{ id: string }>(`/api/device-types/${encodeURIComponent(id)}/delete`, {
    method: "POST",
    token,
    body: JSON.stringify({}),
  });
}
```

- [ ] **Step 2: Display fields in DeviceLassoPicker**

In `frontend-vue/src/components/DeviceLassoPicker.vue`, after type/status meta, add:

```vue
<div class="meta">设备种类: {{ item.deviceTypeName || item.type || "-" }}</div>
<div class="meta">分辨率: {{ item.width || 2560 }} x {{ item.height || 1600 }}</div>
```

In `filteredDevices` keyword string, append:

```ts
${item.deviceTypeName || ""} ${item.width || ""}x${item.height || ""}
```

- [ ] **Step 3: Add Dashboard imports and state**

In `frontend-vue/src/views/DashboardCore.vue`, import:

```ts
import {
  fetchDeviceTypes,
  createDeviceType,
  updateDeviceType,
  deleteDeviceType,
  type DeviceTypeRow,
} from "../services/deviceTypes";
```

Add state near device forms:

```ts
const deviceTypes = ref<DeviceTypeRow[]>([]);
const deviceTypeForm = reactive({ id: "", name: "", defaultWidth: 2560, defaultHeight: 1600, description: "" });
const deviceTypeEditing = computed(() => Boolean(deviceTypeForm.id));
const deviceTypeDeviceCounts = computed(() => {
  const counts = new Map<string, number>();
  deviceStore.devices.forEach((device) => {
    const id = String(device.deviceTypeId || "");
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  });
  return counts;
});
```

Extend `deviceEditForm`:

```ts
const deviceEditForm = reactive({ displayName: "", remark: "", status: "enabled", ownerId: "", deviceTypeId: "", width: 2560, height: 1600 });
```

- [ ] **Step 4: Add functions**

Add these functions in `DashboardCore.vue`:

```ts
async function loadDeviceTypes() {
  if (!auth.token) return;
  deviceTypes.value = await fetchDeviceTypes(auth.token);
}

function pickDeviceType(row: DeviceTypeRow) {
  deviceTypeForm.id = row.id;
  deviceTypeForm.name = row.name || "";
  deviceTypeForm.defaultWidth = Number(row.defaultWidth || 2560);
  deviceTypeForm.defaultHeight = Number(row.defaultHeight || 1600);
  deviceTypeForm.description = row.description || "";
}

function resetDeviceTypeForm() {
  deviceTypeForm.id = "";
  deviceTypeForm.name = "";
  deviceTypeForm.defaultWidth = 2560;
  deviceTypeForm.defaultHeight = 1600;
  deviceTypeForm.description = "";
}

async function saveDeviceType() {
  if (!deviceTypeForm.name.trim()) return ElMessage.error("请填写设备种类名称");
  const payload = {
    name: deviceTypeForm.name.trim(),
    defaultWidth: Number(deviceTypeForm.defaultWidth || 2560),
    defaultHeight: Number(deviceTypeForm.defaultHeight || 1600),
    description: deviceTypeForm.description.trim(),
  };
  if (deviceTypeForm.id) {
    await updateDeviceType(auth.token, deviceTypeForm.id, payload);
    ElMessage.success("设备种类已更新");
  } else {
    await createDeviceType(auth.token, payload);
    ElMessage.success("设备种类已创建");
  }
  resetDeviceTypeForm();
  await loadDeviceTypes();
  await refreshDevices();
}

async function removeDeviceType(row: DeviceTypeRow) {
  await deleteDeviceType(auth.token, row.id);
  ElMessage.success("设备种类已删除");
  await loadDeviceTypes();
}

function onDeviceEditTypeChanged(typeId: string) {
  const row = deviceTypes.value.find((item) => item.id === typeId);
  if (!row) return;
  deviceEditForm.width = Number(row.defaultWidth || 2560);
  deviceEditForm.height = Number(row.defaultHeight || 1600);
}
```

- [ ] **Step 5: Fill device edit form fields**

In `onSingleDeviceChanged()`, add:

```ts
deviceEditForm.deviceTypeId = row.deviceTypeId || "";
deviceEditForm.width = Number(row.width || 2560);
deviceEditForm.height = Number(row.height || 1600);
```

In `updateCurrentDevice()`, inside admin body add:

```ts
body.deviceTypeId = deviceEditForm.deviceTypeId;
body.width = Number(deviceEditForm.width || 2560);
body.height = Number(deviceEditForm.height || 1600);
```

- [ ] **Step 6: Add device edit controls**

In the “设备与PIN” form after owner field, add:

```vue
<el-form-item v-if="isAdmin" label="设备种类">
  <el-select v-model="deviceEditForm.deviceTypeId" filterable style="width:100%" @change="onDeviceEditTypeChanged">
    <el-option v-for="t in deviceTypes" :key="t.id" :label="t.name" :value="t.id" />
  </el-select>
</el-form-item>
<el-form-item v-if="isAdmin" label="分辨率">
  <div class="row-actions">
    <el-input-number v-model="deviceEditForm.width" :min="1" :max="8192" />
    <span>x</span>
    <el-input-number v-model="deviceEditForm.height" :min="1" :max="8192" />
  </div>
</el-form-item>
```

- [ ] **Step 7: Add device type panel**

Add sidebar menu item in `menuItems`:

```ts
{ index: "deviceTypes", label: "设备种类", adminOnly: true },
```

In the template, add section:

```vue
<section v-if="activePanel === 'deviceTypes' && isAdmin" class="section-wrap">
  <h3>设备种类</h3>
  <el-row :gutter="12">
    <el-col :md="10" :xs="24">
      <el-card>
        <template #header>{{ deviceTypeEditing ? "修改设备种类" : "新增设备种类" }}</template>
        <el-form :model="deviceTypeForm" label-width="110px" size="small">
          <el-form-item label="名称"><el-input v-model="deviceTypeForm.name" /></el-form-item>
          <el-form-item label="默认宽度"><el-input-number v-model="deviceTypeForm.defaultWidth" :min="1" :max="8192" /></el-form-item>
          <el-form-item label="默认高度"><el-input-number v-model="deviceTypeForm.defaultHeight" :min="1" :max="8192" /></el-form-item>
          <el-form-item label="描述"><el-input v-model="deviceTypeForm.description" type="textarea" :rows="3" /></el-form-item>
        </el-form>
        <div class="row-actions">
          <el-button type="primary" @click="saveDeviceType">{{ deviceTypeEditing ? "保存修改" : "新增设备种类" }}</el-button>
          <el-button @click="resetDeviceTypeForm">清空</el-button>
        </div>
      </el-card>
    </el-col>
    <el-col :md="14" :xs="24">
      <el-card>
        <template #header>设备种类列表</template>
        <el-table :data="deviceTypes" height="420" size="small" @row-click="pickDeviceType">
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column label="默认分辨率" width="140">
            <template #default="scope">{{ scope.row.defaultWidth }} x {{ scope.row.defaultHeight }}</template>
          </el-table-column>
          <el-table-column label="关联设备" width="100">
            <template #default="scope">{{ deviceTypeDeviceCounts.get(scope.row.id) || 0 }}</template>
          </el-table-column>
          <el-table-column prop="description" label="描述" min-width="180" />
          <el-table-column label="操作" width="100">
            <template #default="scope">
              <el-button link type="danger" @click.stop="removeDeviceType(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </el-col>
  </el-row>
</section>
```

- [ ] **Step 8: Load device types with devices**

In `onPanelSelect`, load device types for `deviceTypes` and `devicePin` panels:

```ts
} else if (index === "deviceTypes") {
  loadDeviceTypes();
}
```

In `refreshDevices()`, after fetching devices:

```ts
await loadDeviceTypes();
```

- [ ] **Step 9: Verify frontend build**

Run:

```bash
cd frontend-vue
npm run build
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add frontend-vue/src/services/deviceTypes.ts frontend-vue/src/components/DeviceLassoPicker.vue frontend-vue/src/views/DashboardCore.vue
git commit -m "feat: add device type management ui"
```

---

### Task 9: Resolution-Aware PageStudio and Dashboard Previews

**Files:**
- Modify: `frontend-vue/src/views/PageStudio.vue`
- Modify: `frontend-vue/src/views/DashboardCore.vue`

- [ ] **Step 1: Import shared helpers**

In both files, import:

```ts
import { getPreviewScale, normalizeDeviceResolution } from "../composables/useDeviceResolution";
```

- [ ] **Step 2: PageStudio device type**

In `PageStudio.vue`, extend `DeviceRow`:

```ts
  deviceTypeName?: string;
  width?: number;
  height?: number;
```

Add:

```ts
const selectedDevice = computed(() => devices.value.find((item) => item.id === deviceId.value) || null);
const selectedResolution = computed(() => normalizeDeviceResolution(selectedDevice.value || {}));
const previewStageStyle = computed(() => {
  const scale = getPreviewScale({
    sourceWidth: selectedResolution.value.width,
    sourceHeight: selectedResolution.value.height,
    maxWidth: 960,
  });
  return {
    width: `${Math.round(selectedResolution.value.width * scale)}px`,
    height: `${Math.round(selectedResolution.value.height * scale)}px`,
  };
});
```

- [ ] **Step 3: Apply PageStudio preview stage**

Change both preview canvases:

```vue
<div class="preview-canvas" :style="previewStageStyle">
```

Change `.preview-img` CSS:

```css
.preview-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
```

Change `.preview-canvas` CSS:

```css
.preview-canvas {
  position: relative;
  max-width: 100%;
}
```

- [ ] **Step 4: Update PageStudio overlay math**

In `timeOverlayPreviewStyle`, replace `sw/sh` calculation with:

```ts
const resolution = selectedResolution.value;
const sw = resolution.width;
const sh = resolution.height;
```

Keep percentage-based `left/top/width/height` so the overlay scales with the stage.

- [ ] **Step 5: Dashboard selected remote resolution**

In `DashboardCore.vue`, add:

```ts
const selectedRemotePreviewDeviceId = computed(() => singleDeviceId.value || deviceStore.selectedIds[0] || "");
const selectedRemotePreviewDevice = computed(() => deviceStore.devices.find((item) => item.id === selectedRemotePreviewDeviceId.value) || null);
```

Replace fixed `remotePreviewResolution`:

```ts
const remotePreviewResolution = computed(() => {
  const resolution = normalizeDeviceResolution(selectedRemotePreviewDevice.value || {});
  return { w: resolution.width, h: resolution.height };
});
```

- [ ] **Step 6: Dashboard homepage preview resolution**

Update `homepagePreviewSourceSize`:

```ts
const homepageTargetDevice = computed(() => deviceStore.devices.find((item) => item.id === batchTargetDeviceIds.homepage[0] || item.id === homepageDeviceId.value) || null);

const homepagePreviewSourceSize = computed(() => {
  const deviceResolution = normalizeDeviceResolution(homepageTargetDevice.value || {});
  const image = homepageRenderMeta || {};
  const screen = homepageConfigModel?.screen || {};
  const sw = Math.max(1, toPreviewNum(deviceResolution.width, toPreviewNum(image.image_width, toPreviewNum(screen.width, 2560))));
  const sh = Math.max(1, toPreviewNum(deviceResolution.height, toPreviewNum(image.image_height, toPreviewNum(screen.height, 1600))));
  return { sw, sh };
});
```

If `homepageDeviceId` is not available in the current file, use `batchTargetDeviceIds.homepage[0]` and fallback to `singleDeviceId`.

- [ ] **Step 7: Verify build**

Run:

```bash
cd frontend-vue
npm run build
```

Expected: PASS and no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add frontend-vue/src/views/PageStudio.vue frontend-vue/src/views/DashboardCore.vue
git commit -m "feat: scale previews by device resolution"
```

---

### Task 10: Firmware Flash Frontend Service and UI

**Files:**
- Create: `frontend-vue/src/services/firmwareFlash.ts`
- Modify: `frontend-vue/src/views/DashboardCore.vue`

- [ ] **Step 1: Create frontend flash service**

Create `frontend-vue/src/services/firmwareFlash.ts`:

```ts
import { apiRequest } from "./api";

export type FirmwareFlashStatus = "pending" | "flashing" | "success" | "failed";
export type FirmwareFlashSourceType = "library" | "project-build" | "url" | "one-time-upload";

export type FirmwareFlashPreparePayload = {
  deviceId: string;
  sourceType: FirmwareFlashSourceType;
  sourceRef?: string;
  url?: string;
  offset?: string;
  projectBuild?: Record<string, unknown>;
};

export type FirmwareFlashPrepareResult = {
  sessionId: string;
  manifestUrl: string;
  launchUrl: string;
};

export function fetchFirmwareFlashSources(token: string) {
  return apiRequest<Record<string, unknown>>("/api/firmware/flash/sources", { token });
}

export function scanProjectBuild(token: string) {
  return apiRequest<Record<string, unknown>>("/api/firmware/flash/project-build/scan", {
    method: "POST",
    token,
    body: JSON.stringify({}),
  });
}

export function uploadOneTimeFlashFiles(token: string, formData: FormData) {
  return apiRequest<{ sourceRef: string; files: unknown[]; expiresAt: string }>("/api/firmware/flash/one-time-upload", {
    method: "POST",
    token,
    body: formData,
    timeoutMs: 120000,
  });
}

export function prepareFirmwareFlash(token: string, payload: FirmwareFlashPreparePayload) {
  return apiRequest<FirmwareFlashPrepareResult>("/api/firmware/flash/prepare", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export function updateFirmwareFlashStatus(token: string, sessionId: string, status: FirmwareFlashStatus, message: string) {
  return apiRequest<Record<string, unknown>>(`/api/firmware/flash/sessions/${encodeURIComponent(sessionId)}/status`, {
    method: "POST",
    token,
    body: JSON.stringify({ status, message }),
  });
}
```

- [ ] **Step 2: Import service in DashboardCore**

In `DashboardCore.vue`, import:

```ts
import {
  fetchFirmwareFlashSources,
  scanProjectBuild,
  uploadOneTimeFlashFiles,
  prepareFirmwareFlash,
  updateFirmwareFlashStatus,
  type FirmwareFlashSourceType,
  type FirmwareFlashStatus,
} from "../services/firmwareFlash";
```

- [ ] **Step 3: Add state**

Near firmware state:

```ts
const flashSources = ref<Record<string, unknown>>({});
const flashStatus = ref<FirmwareFlashStatus>("pending");
const flashMessage = ref("待开始");
const flashPreparing = ref(false);
const flashUploading = ref(false);
const flashProjectScanText = ref("");
const flashLaunchUrl = ref("");
const flashManifestUrl = ref("");
const flashSessionId = ref("");
const flashOneTimeFiles = ref<File[]>([]);
const flashOneTimeSourceRef = ref("");
const flashForm = reactive<{
  deviceId: string;
  sourceType: FirmwareFlashSourceType;
  firmwareId: string;
  url: string;
  offset: string;
}>({
  deviceId: "",
  sourceType: "project-build",
  firmwareId: "",
  url: "",
  offset: "0x10000",
});
```

- [ ] **Step 4: Add functions**

Add:

```ts
function setFlashStatus(status: FirmwareFlashStatus, message: string) {
  flashStatus.value = status;
  flashMessage.value = message;
}

async function loadFlashSources() {
  flashSources.value = await fetchFirmwareFlashSources(auth.token);
}

async function runProjectBuildScan() {
  const data = await scanProjectBuild(auth.token);
  flashProjectScanText.value = JSON.stringify(data, null, 2);
  ElMessage.success("项目构建产物扫描成功");
}

function onFlashOneTimeFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  flashOneTimeFiles.value = Array.from(input.files || []);
}

async function uploadFlashOneTimeFiles() {
  if (!flashOneTimeFiles.value.length) return ElMessage.error("请选择一次性刷机文件");
  flashUploading.value = true;
  try {
    const fd = new FormData();
    flashOneTimeFiles.value.forEach((file, index) => {
      fd.append("files", file);
      fd.append("role", flashOneTimeFiles.value.length === 1 ? "app" : index === 0 ? "bootloader" : index === 1 ? "partition-table" : "app");
      fd.append("offset", flashOneTimeFiles.value.length === 1 ? "0x10000" : index === 0 ? "0x0" : index === 1 ? "0x8000" : "0x10000");
    });
    const data = await uploadOneTimeFlashFiles(auth.token, fd);
    flashOneTimeSourceRef.value = data.sourceRef;
    ElMessage.success("一次性刷机文件已上传");
  } finally {
    flashUploading.value = false;
  }
}

async function prepareFlashLaunch() {
  if (!flashForm.deviceId) return ElMessage.error("请选择目标设备");
  flashPreparing.value = true;
  try {
    setFlashStatus("pending", "待开始");
    const payload: any = {
      deviceId: flashForm.deviceId,
      sourceType: flashForm.sourceType,
    };
    if (flashForm.sourceType === "library") payload.sourceRef = flashForm.firmwareId;
    if (flashForm.sourceType === "project-build") payload.projectBuild = {};
    if (flashForm.sourceType === "url") {
      payload.url = flashForm.url.trim();
      payload.offset = flashForm.offset || "0x10000";
    }
    if (flashForm.sourceType === "one-time-upload") payload.sourceRef = flashOneTimeSourceRef.value;
    const data = await prepareFirmwareFlash(auth.token, payload);
    flashSessionId.value = data.sessionId;
    flashManifestUrl.value = data.manifestUrl;
    flashLaunchUrl.value = data.launchUrl;
    setFlashStatus("pending", "已准备，等待启动刷机");
  } catch (error) {
    setFlashStatus("failed", (error as Error).message || "刷机准备失败");
    throw error;
  } finally {
    flashPreparing.value = false;
  }
}

async function openFlashLaunchpad() {
  if (!flashLaunchUrl.value || !flashSessionId.value) return ElMessage.error("请先准备刷机");
  if (!("serial" in navigator)) {
    setFlashStatus("failed", "当前浏览器不支持 Web Serial，请使用 Chromium 系浏览器");
    await updateFirmwareFlashStatus(auth.token, flashSessionId.value, "failed", flashMessage.value);
    return;
  }
  setFlashStatus("flashing", "刷入中");
  await updateFirmwareFlashStatus(auth.token, flashSessionId.value, "flashing", "用户已打开 ESP Launchpad");
  const win = window.open(flashLaunchUrl.value, "_blank", "noopener,noreferrer");
  if (!win) ElMessage.warning("浏览器阻止了弹窗，请点击下方链接打开 ESP Launchpad");
}

async function markFlashSuccess() {
  if (!flashSessionId.value) return;
  setFlashStatus("success", "刷入成功");
  await updateFirmwareFlashStatus(auth.token, flashSessionId.value, "success", "用户确认刷入成功");
}

async function markFlashFailed() {
  if (!flashSessionId.value) return;
  setFlashStatus("failed", "刷入失败");
  await updateFirmwareFlashStatus(auth.token, flashSessionId.value, "failed", "用户标记刷入失败");
}
```

- [ ] **Step 5: Add template card in firmware section**

After existing upload firmware row and before “升级任务”, add:

```vue
<el-card>
  <template #header>IDF 在线刷入（ESP Launchpad）</template>
  <el-form :model="flashForm" label-width="110px" size="small">
    <el-form-item label="目标设备">
      <el-select v-model="flashForm.deviceId" filterable style="width:100%">
        <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
      </el-select>
    </el-form-item>
    <el-form-item label="固件来源">
      <el-radio-group v-model="flashForm.sourceType">
        <el-radio-button value="project-build">项目构建产物</el-radio-button>
        <el-radio-button value="library">固件库</el-radio-button>
        <el-radio-button value="url">固件URL</el-radio-button>
        <el-radio-button value="one-time-upload">一次性上传</el-radio-button>
      </el-radio-group>
    </el-form-item>
    <el-form-item v-if="flashForm.sourceType === 'library'" label="固件版本">
      <el-select v-model="flashForm.firmwareId" filterable style="width:100%">
        <el-option v-for="fw in firmwareRows" :key="fw.id" :label="`${fw.version} / ${fw.deviceType || '-'} / ${fw.fileName || '-'}`" :value="fw.id" />
      </el-select>
    </el-form-item>
    <el-form-item v-if="flashForm.sourceType === 'project-build'" label="构建产物">
      <div class="stack-vertical" style="width:100%">
        <div>D:\idfchonggouepd\.pio\build\4d_systems_esp32s3_gen4_r8n16</div>
        <el-button @click="runProjectBuildScan">重新扫描</el-button>
        <el-input v-if="flashProjectScanText" v-model="flashProjectScanText" type="textarea" :rows="5" readonly />
      </div>
    </el-form-item>
    <el-form-item v-if="flashForm.sourceType === 'url'" label="固件URL">
      <div class="row-actions" style="width:100%">
        <el-input v-model="flashForm.url" placeholder="https://example.com/firmware.bin" style="flex:1" />
        <el-input v-model="flashForm.offset" style="width:120px" />
      </div>
    </el-form-item>
    <el-form-item v-if="flashForm.sourceType === 'one-time-upload'" label="一次性文件">
      <div class="stack-vertical" style="width:100%">
        <input type="file" multiple accept=".bin,.zip,.toml,application/octet-stream" @change="onFlashOneTimeFileChange" />
        <el-button :loading="flashUploading" @click="uploadFlashOneTimeFiles">上传临时刷机文件</el-button>
        <el-tag v-if="flashOneTimeSourceRef">sourceRef: {{ flashOneTimeSourceRef }}</el-tag>
      </div>
    </el-form-item>
  </el-form>
  <div class="row-actions">
    <el-tag :type="flashStatus === 'success' ? 'success' : flashStatus === 'failed' ? 'danger' : flashStatus === 'flashing' ? 'warning' : 'info'">
      {{ flashStatus === "pending" ? "待开始" : flashStatus === "flashing" ? "刷入中" : flashStatus === "success" ? "成功" : "失败" }}
    </el-tag>
    <span>{{ flashMessage }}</span>
  </div>
  <div class="row-actions" style="margin-top:8px">
    <el-button type="primary" :loading="flashPreparing" @click="prepareFlashLaunch">准备刷机</el-button>
    <el-button type="warning" @click="openFlashLaunchpad">启动 ESP Launchpad</el-button>
    <el-button @click="markFlashSuccess">我已完成刷机</el-button>
    <el-button @click="markFlashFailed">标记失败</el-button>
    <el-link v-if="flashLaunchUrl" :href="flashLaunchUrl" target="_blank">打开刷机页面</el-link>
  </div>
  <div v-if="flashManifestUrl" style="font-size:12px;color:#64748b;margin-top:6px">manifest: {{ flashManifestUrl }}</div>
</el-card>
```

- [ ] **Step 6: Load sources when opening firmware panel**

In `onPanelSelect`, inside firmware branch:

```ts
loadFlashSources();
```

In `refreshDevices()`, if `flashForm.deviceId` is empty and devices exist, set:

```ts
if (!flashForm.deviceId && deviceStore.devices.length) flashForm.deviceId = deviceStore.devices[0].id;
```

- [ ] **Step 7: Verify build**

Run:

```bash
cd frontend-vue
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend-vue/src/services/firmwareFlash.ts frontend-vue/src/views/DashboardCore.vue
git commit -m "feat: add esp launchpad flashing ui"
```

---

### Task 11: End-to-End Verification and Documentation

**Files:**
- Modify: `README.md`
- Optional generated build files under `frontend/vue-app/` if the project expects committed built assets.

- [ ] **Step 1: Run backend tests**

Run:

```bash
cd backend
npm run test:device-types
npm run test:firmware-flash
node -c src/app.js
node -c src/routes/device.routes.js
node -c src/routes/hardware.routes.js
node -c src/routes/device_type.routes.js
node -c src/routes/firmware_flash.routes.js
```

Expected: all commands pass.

- [ ] **Step 2: Run frontend build**

Run:

```bash
cd frontend-vue
npm run build
```

Expected: Vite build completes and writes assets to `frontend/vue-app`.

- [ ] **Step 3: Manual backend smoke**

Start backend in a local terminal:

```bash
cd backend
npm run start
```

Expected: server starts on configured port, commonly `8890`.

Use the browser management UI:

- Login as admin.
- Open “设备种类”.
- Create `test-panel` with `800 x 480`.
- Open “设备与PIN”, pick a device, choose `test-panel`, confirm width and height fill to `800 x 480`, then change to `900 x 540` and save.
- Open device lasso view and confirm the device card displays `test-panel` and `900 x 540`.
- Open “固件管理”, choose project build source, run scan, prepare flashing. Confirm manifest URL and Launchpad URL appear.
- Choose one-time upload, upload a single `.bin`, prepare flashing. Confirm status is `待开始`.
- Click “启动 ESP Launchpad” only on a Chromium browser with Web Serial support.

- [ ] **Step 4: Update README**

Add a short section to `README.md` under “主要接口分组” or “常见问题”:

```md
### IDF 在线刷机
- 管理端“固件管理”提供 IDF 在线刷入入口，浏览器通过 ESP Launchpad/Web Serial 连接 ESP32 设备。
- 固件来源支持固件库、项目构建产物、固件 URL、一次性上传。
- Web Serial 需要 Chromium 系浏览器，并要求 HTTPS 或 localhost 环境。
- 后端只提供 manifest 和固件文件，不直接操作 USB 串口。
```

- [ ] **Step 5: Review changed files**

Run:

```bash
git status --short
git diff --stat
```

Expected: only files intentionally changed by this implementation are shown, plus built frontend assets if build output is committed in this repo.

- [ ] **Step 6: Commit final verification/doc update**

```bash
git add README.md frontend/vue-app frontend-vue backend
git commit -m "docs: document launchpad flashing workflow"
```

If built frontend assets are not meant to be committed, stage only source and README files.

---

## Self-Review

Spec coverage:

- ESP Launchpad/Web Serial architecture: Tasks 5, 6, 10.
- Firmware library, project build, URL, one-time upload sources: Tasks 5, 6, 10.
- Flash statuses pending/flashing/success/failed: Tasks 6 and 10.
- Device type data model and CRUD: Tasks 1, 2, 3, 8.
- Device fields `deviceTypeId/deviceTypeName/width/height`: Tasks 2, 4, 8.
- Delete device type association guard: Task 3.
- Resolution-aware PageStudio, homepage preview, image preview: Tasks 7 and 9.
- Fallback resolution `2560 x 1600`: Tasks 1 and 7.
- Existing OTA API preserved: Tasks 5 and 6 add separate routes and do not remove existing firmware routes.

Type consistency:

- Backend uses `deviceTypes`, `firmwareFlashSessions`, `firmwareFlashTempFiles`.
- Device fields are `deviceTypeId`, `deviceTypeName`, `width`, `height`.
- Frontend service source types match backend: `library`, `project-build`, `url`, `one-time-upload`.
- Status names match backend and UI: `pending`, `flashing`, `success`, `failed`.

Verification commands:

- Backend: `npm run test:device-types`, `npm run test:firmware-flash`, `node -c` route checks.
- Frontend: `npm run build`.
