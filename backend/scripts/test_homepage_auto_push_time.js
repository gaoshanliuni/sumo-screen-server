/* eslint-disable no-console */
const assert = require("assert");
const {
  computeNextAutoRenderRunAt,
  normalizeAutoRenderPushConfig,
} = require("../src/services/homepage_auto_push_time.service");

const TZ = "Asia/Shanghai";

function runCase(name, fn) {
  try {
    fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[failed] ${name}: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

runCase("disabled -> empty", () => {
  const next = computeNextAutoRenderRunAt(
    {
      enabled: false,
      daily_start_time: "07:30",
      interval_minutes: 30,
    },
    new Date("2026-04-12T08:00:00+08:00"),
    TZ
  );
  assert.strictEqual(next, "");
});

runCase("before start -> same day start", () => {
  const next = computeNextAutoRenderRunAt(
    {
      enabled: true,
      daily_start_time: "07:30",
      interval_minutes: 30,
    },
    new Date("2026-04-12T06:00:00+08:00"),
    TZ
  );
  assert.strictEqual(next, "2026-04-11T23:30:00.000Z");
});

runCase("after start -> next interval slot", () => {
  const next = computeNextAutoRenderRunAt(
    {
      enabled: true,
      daily_start_time: "07:30",
      interval_minutes: 30,
    },
    new Date("2026-04-12T08:05:00+08:00"),
    TZ
  );
  assert.strictEqual(next, "2026-04-12T00:30:00.000Z");
});

runCase("day boundary -> next day start", () => {
  const next = computeNextAutoRenderRunAt(
    {
      enabled: true,
      daily_start_time: "07:30",
      interval_minutes: 360,
    },
    new Date("2026-04-12T23:10:00+08:00"),
    TZ
  );
  assert.strictEqual(next, "2026-04-12T23:30:00.000Z");
});

runCase("normalize config keeps valid values", () => {
  const normalized = normalizeAutoRenderPushConfig(
    {
      enabled: 1,
      dailyStartTime: "7:05",
      intervalMinutes: "120",
      last_result: "success",
    },
    {
      now: new Date("2026-04-12T10:15:00+08:00"),
      timeZone: TZ,
      recomputeNext: true,
    }
  );
  assert.strictEqual(normalized.enabled, true);
  assert.strictEqual(normalized.daily_start_time, "07:05");
  assert.strictEqual(normalized.interval_minutes, 120);
  assert.ok(String(normalized.next_run_at || "").length > 10);
});

if (!process.exitCode) {
  console.log("homepage auto-push time tests passed.");
}
