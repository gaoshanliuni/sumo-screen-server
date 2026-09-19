const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.STORE_TEST_MEMORY_ONLY = "1";

const HttpError = require("../src/utils/httpError");
const store = require("../src/db/store");

async function testPartialReadIsolation() {
  const full = await store.readDB();
  assert.ok(Array.isArray(full.apiTemplates), "default store must contain an unrelated large collection");

  const view = await store.readDBView(["devices", "devices"]);
  assert.deepEqual(Object.keys(view).sort(), ["devices", "meta"]);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "apiTemplates"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "users"), false);

  view.meta.contractMutation = true;
  view.devices.push({ id: "view-only-device" });
  const freshView = await store.readDBView("devices");
  assert.equal(freshView.meta.contractMutation, undefined, "meta clone must be isolated");
  assert.equal(
    freshView.devices.some((row) => row.id === "view-only-device"),
    false,
    "collection clone must be isolated"
  );

  await assert.rejects(
    () => store.readDBView(["devices", 123]),
    (error) => error instanceof TypeError
  );
}

function createFakeMysqlRuntime() {
  const queries = [];
  let rollbacks = 0;
  let commits = 0;
  let poolEnds = 0;
  let failPattern = null;
  const meta = {
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 2,
    migrations: {
      "2026-06-25-weather-template-refresh-60m": "2026-01-01T00:00:00.000Z",
      "2026-06-25-play-collection-2m-to-10m": "2026-01-01T00:00:00.000Z",
    },
  };
  const connection = {
    async beginTransaction() {},
    async query(sql) {
      const normalized = String(sql).trim().replace(/\s+/g, " ");
      queries.push(normalized);
      if (failPattern?.test(normalized)) {
        failPattern = null;
        const error = new Error("simulated local persistence failure");
        error.code = "ECONNRESET";
        throw error;
      }
      if (/^SELECT \* FROM store_meta/i.test(normalized)) {
        return [[{
          version: 2,
          payload_json: JSON.stringify(meta),
          created_at: "2026-01-01 00:00:00",
          updated_at: "2026-01-01 00:00:00",
        }], []];
      }
      if (/^SELECT \* FROM `api_templates`/i.test(normalized)) {
        const createdAt = "2026-01-01T00:00:00.000Z";
        const rows = ["amap_geocode", "xique_schedule", "todo"].map((slug, index) => {
          const payload = {
            id: `tpl-contract-${index}`,
            slug,
            name: slug,
            method: "GET",
            url: "",
            createdAt,
            updatedAt: createdAt,
          };
          return {
            id: payload.id,
            owner_id: "",
            slug,
            name: slug,
            method: "GET",
            url: "",
            template_json: "{}",
            is_active: 1,
            payload_json: JSON.stringify(payload),
            created_at: "2026-01-01 00:00:00",
            updated_at: "2026-01-01 00:00:00",
            sort_index: index,
          };
        });
        return [rows, []];
      }
      return [[], []];
    },
    async commit() {
      commits += 1;
    },
    async rollback() {
      rollbacks += 1;
    },
    release() {},
  };
  const pool = {
    async getConnection() {
      return connection;
    },
    async end() {
      poolEnds += 1;
    },
  };
  return {
    pool,
    queries,
    get commits() { return commits; },
    get rollbacks() { return rollbacks; },
    get poolEnds() { return poolEnds; },
    failNextMatching(pattern) {
      failPattern = pattern;
    },
  };
}

async function testDbPathErrorClassificationAndDirtyWrites() {
  const initial = await store.readDB();
  delete process.env.STORE_TEST_MEMORY_ONLY;
  const fake = createFakeMysqlRuntime();
  store.__testing.configureRuntime({ state: initial, pool: fake.pool, fromDB: true });

  for (const expected of [new HttpError(409, "contract conflict"), new Error("contract failure")]) {
    let calls = 0;
    await assert.rejects(
      () => store.updateDB(() => {
        calls += 1;
        throw expected;
      }),
      (actual) => actual === expected
    );
    assert.equal(calls, 1, `${expected.name} mutator must execute exactly once`);
  }
  assert.equal(fake.rollbacks, 2, "application errors must roll back their transaction");
  assert.equal(fake.commits, 0);

  fake.queries.length = 0;
  await store.updateDB((draft) => {
    draft.devices.push({ id: "dirty-device", deviceId: "dirty-device" });
  });
  const clearedTables = fake.queries
    .filter((sql) => /^DELETE FROM /i.test(sql))
    .map((sql) => sql.match(/^DELETE FROM (`[^`]+`)/i)?.[1]);
  assert.deepEqual(clearedTables, ["`devices`"], "only the changed collection may be replaced");
  assert.equal(fake.commits, 1);

  let persistenceFallbackCalls = 0;
  fake.failNextMatching(/^DELETE FROM `users`/i);
  const fallbackResult = await store.updateDB((draft) => {
    persistenceFallbackCalls += 1;
    draft.users.push({ id: "fallback-user", username: "fallback-user" });
    return "fallback-result";
  });
  assert.equal(fallbackResult, "fallback-result");
  assert.equal(persistenceFallbackCalls, 1, "post-mutation infrastructure fallback must not rerun the mutator");
  assert.equal((await store.readDBView("users")).users.filter((row) => row.id === "fallback-user").length, 1);

  await store.closeStore();
  assert.equal(fake.poolEnds, 1, "closeStore must release the MySQL pool");

  process.env.STORE_TEST_MEMORY_ONLY = "1";
  store.__testing.configureRuntime({ state: await store.readDB(), pool: null, fromDB: false });
}

function testDirtyCollectionDetection() {
  const before = {
    users: [{ id: "u1", nickname: "before" }],
    devices: [{ id: "d1", status: "enabled" }],
  };
  const fingerprints = store.__testing.captureCollectionFingerprints(before);
  const after = JSON.parse(JSON.stringify(before));
  after.devices[0].status = "disabled";
  after.nonPersistentRuntimeValue = { changed: true };
  assert.deepEqual(store.__testing.detectChangedCollectionKeys(fingerprints, after), ["devices"]);
  assert.deepEqual(store.__testing.detectChangedCollectionKeys(fingerprints, before), []);
}

async function testOptimisticPersistenceObservability() {
  const before = store.getOptimisticPersistStatus();
  assert.equal(before.durable, true);

  await store.updateDBOptimistic((draft) => {
    draft.devices.push({ id: "optimistic-contract-device", deviceId: "optimistic-contract-device" });
  });

  const queued = store.getOptimisticPersistStatus();
  assert.equal(queued.hasPendingSnapshot, true);
  assert.ok(queued.pendingDirtyKeys.includes("devices"));
  assert.ok(queued.latestVersion > before.latestVersion);

  const flushed = await store.flushPendingOptimisticPersist();
  assert.equal(flushed.lastOutcome, "skipped");
  assert.equal(flushed.hasPendingSnapshot, true, "failed/skipped durability must retain the latest snapshot");
  assert.equal(flushed.lastError.code, "STORE_INFRASTRUCTURE_ERROR");

  await assert.rejects(
    () => store.flushPendingOptimisticPersist({ throwOnError: true }),
    (error) => error.code === "OPTIMISTIC_PERSIST_FAILED" && error.status?.hasPendingSnapshot === true
  );
}

function testSourceContracts() {
  const sourcePath = path.join(__dirname, "../src/db/store.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const updateStart = source.indexOf("async function updateDB(mutator)");
  const exportStart = source.indexOf("module.exports =", updateStart);
  const updateSource = source.slice(updateStart, exportStart);
  assert.match(updateSource, /saveStateChangesToTables\(conn, draft, dirtyKeys\)/);
  assert.doesNotMatch(updateSource, /saveStateToTables\(conn, draft\)/);

  const persistStart = source.indexOf("async function persistSnapshot");
  const scheduleStart = source.indexOf("function serializeOptimisticPersistError", persistStart);
  const persistSource = source.slice(persistStart, scheduleStart);
  assert.match(persistSource, /saveStateChangesToTables\(conn, clone\(snapshot\), dirtyKeys\)/);
  assert.doesNotMatch(persistSource, /ensureSchema\(conn\)/);
  assert.match(source, /async function closeStore\(\)/);
  assert.match(source, /await flushPendingOptimisticPersist\(\{ throwOnError: true \}\)/);
  assert.match(source, /await resetPool\(\)/);
}

async function main() {
  await testPartialReadIsolation();
  await testDbPathErrorClassificationAndDirtyWrites();
  testDirtyCollectionDetection();
  await testOptimisticPersistenceObservability();
  testSourceContracts();
  console.log("store hardening contract tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
