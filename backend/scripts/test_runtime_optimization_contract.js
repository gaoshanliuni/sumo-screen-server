const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");
const storePath = require.resolve(path.join(backendRoot, "src/db/store.js"));

let snapshot = {};
let transactionDraft = {};
let updateCalls = 0;
let closeStoreCalls = 0;
let optimisticPersistStatus = {
  durable: true,
  pending: false,
  hasPendingSnapshot: false,
  inFlight: false,
  lastOutcome: "idle",
  lastAttemptAt: "",
  lastSuccessAt: "",
  lastFailureAt: "",
  lastError: null,
};

async function updateDB(mutator) {
  updateCalls += 1;
  return mutator(transactionDraft);
}

async function readDBView(keys) {
  const view = { meta: snapshot.meta || {} };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) view[key] = snapshot[key];
  }
  return view;
}

require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: {
    initStore: async () => undefined,
    closeStore: async () => { closeStoreCalls += 1; },
    readDB: async () => snapshot,
    readDBCached: async () => snapshot,
    readDBView,
    updateDB,
    updateDBOptimistic: updateDB,
    getOptimisticPersistStatus: () => optimisticPersistStatus,
    patchDeviceThirdApiCache: async () => undefined,
  },
};

function request(server, pathname) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: address.port, path: pathname },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body = null;
          try {
            body = JSON.parse(raw);
          } catch (_) {
            body = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on("error", reject);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function testHomepageNoopAndFreshDraftRecheck() {
  const service = require(path.join(backendRoot, "src/services/homepage_auto_push.service.js"));
  const now = new Date("2026-08-15T00:00:00.000Z");
  const initialRow = {
    id: "home-1",
    ownerId: "user-1",
    deviceId: "device-1",
    config: {
      auto_render_push: {
        enabled: true,
        interval_enabled: true,
        window_start_time: "07:30",
        window_end_time: "23:59",
        fixed_times: [],
        daily_start_time: "07:30",
        interval_minutes: 60,
        next_run_at: "2026-08-15T01:00:00.000Z",
        last_run_at: "",
        last_result: "idle",
        last_error: "",
        last_reason: "",
      },
    },
  };
  const stable = service.prepareHomepageAutoConfigRow(initialRow, now).nextConfig;
  snapshot = { homepageConfigs: [{ ...initialRow, config: stable }] };
  transactionDraft = JSON.parse(JSON.stringify(snapshot));
  updateCalls = 0;
  const noop = await service.ensureNextRunAtForEnabledRows(now);
  assert.deepStrictEqual(noop, { changed: 0, updateAttempted: false });
  assert.strictEqual(updateCalls, 0, "stable scheduler ticks must not enter updateDB");

  const invalidSnapshotRow = JSON.parse(JSON.stringify(initialRow));
  invalidSnapshotRow.config.auto_render_push.next_run_at = "invalid";
  snapshot = { homepageConfigs: [invalidSnapshotRow] };
  transactionDraft = { homepageConfigs: [{ ...initialRow, config: stable }] };
  updateCalls = 0;
  const refreshed = await service.ensureNextRunAtForEnabledRows(now);
  assert.strictEqual(updateCalls, 1, "a stale snapshot should enter the update transaction once");
  assert.deepStrictEqual(
    refreshed,
    { changed: 0, updateAttempted: true },
    "fresh draft must be rechecked inside updateDB"
  );
  assert.strictEqual(
    transactionDraft.homepageConfigs[0].config.auto_render_push.next_run_at,
    "2026-08-15T01:00:00.000Z",
    "fresh concurrent configuration must not be overwritten by the stale snapshot"
  );

  snapshot = { homepageConfigs: [JSON.parse(JSON.stringify(invalidSnapshotRow))] };
  transactionDraft = JSON.parse(JSON.stringify(snapshot));
  updateCalls = 0;
  const initialized = await service.ensureNextRunAtForEnabledRows(now);
  assert.deepStrictEqual(initialized, { changed: 1, updateAttempted: true });
  assert.strictEqual(updateCalls, 1);
  assert.ok(
    Number.isFinite(Date.parse(transactionDraft.homepageConfigs[0].config.auto_render_push.next_run_at)),
    "invalid next_run_at should be replaced with a valid future timestamp"
  );
  assert.strictEqual(
    transactionDraft.homepageConfigs[0].updatedBy,
    undefined,
    "normalization-only updates retain the existing updatedAt/updatedBy behavior"
  );
}

async function exerciseSchedulerLifecycle({ start, stop, runtime, globalKey }) {
  stop();
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const state = start({
    intervalMs: 60000,
    runImmediately: false,
    runTick: async () => {
      calls += 1;
      return pending;
    },
  });
  assert.strictEqual(state.timer.hasRef(), false, `${globalKey} timer must be unref'ed`);
  const first = state.tick();
  await Promise.resolve();
  assert.strictEqual(runtime().running, true);
  const second = await state.tick();
  assert.deepStrictEqual(second, { skipped: true, reason: "previous_tick_running" });
  assert.strictEqual(calls, 1, "overlapping tick must not execute the worker twice");
  release({ ok: true });
  await first;
  assert.strictEqual(runtime().running, false);
  assert.strictEqual(runtime().skippedTicks, 1);
  stop();
  assert.strictEqual(runtime().started, false);
  assert.strictEqual(global[globalKey], undefined);
}

async function testSchedulerLifecycle() {
  const taskPlan = require(path.join(backendRoot, "src/services/task_plan.service.js"));
  await exerciseSchedulerLifecycle({
    start: taskPlan.startTaskPlanScheduler,
    stop: taskPlan.stopTaskPlanScheduler,
    runtime: taskPlan.getTaskPlanSchedulerRuntime,
    globalKey: "__taskPlanScheduler",
  });

  const xique = require(path.join(backendRoot, "src/services/xique_sync.service.js"));
  await exerciseSchedulerLifecycle({
    start: xique.startXiqueScheduler,
    stop: xique.stopXiqueScheduler,
    runtime: xique.getXiqueSchedulerRuntime,
    globalKey: "__xiqueSchedulerStarted",
  });
}

function testDashboardAggregation() {
  const { buildDashboardOverview } = require(path.join(backendRoot, "src/routes/dashboard.routes.js"));
  const db = {
    devices: [
      { id: "d1", ownerId: "u1", bindState: "bound", firmwareVersion: "1.0" },
      { id: "d2", ownerId: "u2", bindState: "unbound", firmwareVersion: "2.0", status: "blocked" },
    ],
    todos: [{ id: "t1", deviceId: "d1" }, { id: "t2", deviceId: "d2" }],
    schedules: [{ id: "s1", deviceId: "d1" }, { id: "s2", deviceId: "d2" }],
    firmwares: [{ id: "f1" }, { id: "f2" }],
    clusters: [{ id: "c1", deviceIds: ["d1"] }, { id: "c2", deviceIds: ["d2"] }],
    users: [{ id: "u1", role: "user" }, { id: "u2", role: "user" }],
    apiLogs: [{ templateSlug: "weather", success: true }],
  };
  const presence = (id) => ({ online: id === "d1" });
  const user = buildDashboardOverview(db, { role: "user", userId: "u1" }, presence);
  assert.strictEqual(user.deviceTotal, 1);
  assert.strictEqual(user.deviceOnline, 1);
  assert.strictEqual(user.todoCount, 1);
  assert.strictEqual(user.scheduleCount, 1);
  assert.strictEqual(user.firmwareCount, 2);
  assert.strictEqual(user.clusterTotal, 1);
  assert.deepStrictEqual(user.apiStats, {});
  assert.strictEqual(user.userTotal, undefined);

  const admin = buildDashboardOverview(db, { role: "admin", userId: "admin" }, presence);
  assert.strictEqual(admin.deviceTotal, 2);
  assert.strictEqual(admin.deviceBound, 1);
  assert.strictEqual(admin.blockedDevices, 1);
  assert.strictEqual(admin.userTotal, 2);
  assert.strictEqual(admin.apiStats.weather.success, 1);

  const source = fs.readFileSync(
    path.join(backendRoot, "src/routes/dashboard.routes.js"),
    "utf8"
  );
  assert.match(source, /readDBView\(\[/, "dashboard overview must use a partial store view");
  ["devices", "todos", "schedules", "firmwares", "clusters", "apiLogs", "users"].forEach((key) => {
    assert.ok(source.includes(`"${key}"`), `dashboard view must request ${key}`);
  });
}

async function testPortHealthAndCacheContracts() {
  const serverModule = require(path.join(backendRoot, "src/server.js"));
  assert.deepStrictEqual(serverModule.buildPortCandidates({ PORT: "8890" }), [8890]);
  assert.deepStrictEqual(serverModule.buildPortCandidates({ PORT: "9123" }), [9123]);
  assert.strictEqual(serverModule.buildPortCandidates({ PORT_FALLBACK_ENABLED: "0" }).length, 1);
  assert.ok(serverModule.buildPortCandidates({ PORT_FALLBACK_ENABLED: "1" }).length > 1);
  assert.throws(
    () => serverModule.validateProductionConfig({ NODE_ENV: "production" }),
    /Production configuration invalid/
  );
  assert.deepStrictEqual(
    serverModule.validateProductionConfig({
      NODE_ENV: "production",
      JWT_SECRET: "unit-test-secret",
      DB_HOST: "127.0.0.1",
      DB_USER: "unit",
      DB_PASSWORD: "unit-password",
      DB_NAME: "unit-db",
    }),
    { valid: true, issues: [] }
  );

  const app = require(path.join(backendRoot, "src/app.js"));
  const fakeResponse = { headers: {}, setHeader(key, value) { this.headers[key] = value; } };
  app.setStaticCacheHeaders(fakeResponse, "index-AbCd1234.js");
  assert.strictEqual(fakeResponse.headers["Cache-Control"], "public, max-age=31536000, immutable");
  const htmlResponse = { headers: {}, setHeader(key, value) { this.headers[key] = value; } };
  app.setStaticCacheHeaders(htmlResponse, "index.html");
  assert.strictEqual(htmlResponse.headers["Cache-Control"], "no-cache");

  app.locals.runtime.storeReady = false;
  const server = http.createServer(app);
  await listen(server);
  try {
    const health = await request(server, "/api/health");
    assert.strictEqual(health.status, 200);
    assert.ok(health.body.data.time);
    assert.ok(health.body.data.runtime);
    const live = await request(server, "/api/health/live");
    assert.strictEqual(live.status, 200);
    const notReady = await request(server, "/api/health/ready");
    assert.strictEqual(notReady.status, 503);
    app.locals.runtime.storeReady = true;
    const ready = await request(server, "/api/health/ready");
    assert.strictEqual(ready.status, 200);
    optimisticPersistStatus = {
      ...optimisticPersistStatus,
      durable: false,
      pending: true,
      hasPendingSnapshot: true,
      lastOutcome: "failed",
      lastFailureAt: new Date().toISOString(),
      lastError: { code: "STORE_INFRASTRUCTURE_ERROR", message: "contract failure" },
    };
    const degraded = await request(server, "/api/health/ready");
    assert.strictEqual(degraded.status, 503);
    assert.strictEqual(degraded.body.msg, "store_persistence_degraded");
    assert.strictEqual(degraded.body.data.runtime.storePersistence.degraded, true);
    optimisticPersistStatus = {
      ...optimisticPersistStatus,
      durable: true,
      pending: false,
      hasPendingSnapshot: false,
      lastOutcome: "persisted",
      lastError: null,
    };
    const assetsDir = path.resolve(backendRoot, "../frontend/vue-app/assets");
    const hashedAsset = fs
      .readdirSync(assetsDir)
      .find((name) => /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/i.test(name));
    assert.ok(hashedAsset, "expected at least one hashed frontend asset");
    const asset = await request(server, `/vue-app/assets/${encodeURIComponent(hashedAsset)}`);
    assert.strictEqual(asset.status, 200);
    assert.strictEqual(asset.headers["cache-control"], "public, max-age=31536000, immutable");
    const html = await request(server, "/vue-app/index.html");
    assert.strictEqual(html.status, 200);
    assert.strictEqual(html.headers["cache-control"], "no-cache");
  } finally {
    await close(server);
  }

  const shutdownServer = http.createServer((_req, res) => res.end("ok"));
  await listen(shutdownServer);
  let shutdownExitCode = null;
  const shutdown = serverModule.createShutdownHandler({
    server: shutdownServer,
    wss: null,
    exit: (code) => {
      shutdownExitCode = code;
    },
  });
  const firstShutdown = shutdown("contract-test", 0);
  assert.strictEqual(shutdown("contract-test-duplicate", 1), firstShutdown);
  await firstShutdown;
  assert.strictEqual(shutdownServer.listening, false);
  assert.strictEqual(shutdownExitCode, 0);
  assert.strictEqual(closeStoreCalls, 1, "graceful shutdown must close the store exactly once");
}

async function main() {
  await testHomepageNoopAndFreshDraftRecheck();
  await testSchedulerLifecycle();
  testDashboardAggregation();
  await testPortHealthAndCacheContracts();
  console.log("runtime optimization contract tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
