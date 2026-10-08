/* eslint-disable no-console */
const assert = require("assert");

process.env.REALTIME_HISTORY_LIMIT = "20";
process.env.REALTIME_HISTORY_TTL_MS = "60000";
process.env.REALTIME_PRESENCE_RETENTION_MS = "60000";

const {
  publishDeviceEvent,
  getDeviceHistory,
  getDevicePresence,
  markDeviceOnline,
  markDeviceOffline,
  pruneRealtimeState,
  getRealtimeRuntime,
  stopRealtimeSweeper,
} = require("../src/utils/realtime.hub");

function main() {
  const before = getRealtimeRuntime();
  getDevicePresence("unknown-device");
  assert.strictEqual(
    getRealtimeRuntime().presenceDevices,
    before.presenceDevices,
    "read-only presence lookup must not allocate a tracked device"
  );

  for (let index = 0; index < 35; index += 1) {
    publishDeviceEvent({ type: "test.event", deviceId: "dev-retention", payload: { index } });
  }
  assert.strictEqual(getDeviceHistory("dev-retention").length, 20, "history must respect per-device limit");

  markDeviceOnline("dev-retention", "ws");
  markDeviceOffline("dev-retention", "ws");
  assert.strictEqual(getDevicePresence("dev-retention").online, false);

  const future = Date.now() + 2 * 60 * 1000;
  const result = pruneRealtimeState(future);
  assert.ok(result.removedHistoryEvents >= 20, "expired history events should be removed");
  assert.strictEqual(getDeviceHistory("dev-retention").length, 0);
  assert.strictEqual(getRealtimeRuntime().presenceDevices, 0, "stale offline presence should be removed");

  stopRealtimeSweeper();
  console.log("[ok] realtime history and presence retention verified");
}

try {
  main();
} catch (error) {
  stopRealtimeSweeper();
  console.error(`[fail] ${error?.stack || error}`);
  process.exit(1);
}
