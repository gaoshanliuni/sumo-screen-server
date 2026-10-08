/* eslint-disable no-console */
const assert = require("assert");

const {
  normalizeTaskPlan,
  computeNextRunAt,
  hasHigherPriorityActiveRun,
  buildTaskRunRecord,
} = require("../src/services/task_plan.service");

function runCase(name, fn) {
  try {
    fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[failed] ${name}: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

runCase("normalizes a weekly task plan with stable step defaults", () => {
  const plan = normalizeTaskPlan({
    name: "早会切主页",
    priority: 20,
    targetDeviceIds: ["dev_1"],
    scheduleMode: "weekly",
    scheduleSpec: { weekdays: [1, 3, 1], times: ["09:00"] },
    steps: [{ actionType: "remote.switch_view", params: { view: "home" } }],
  }, "2026-05-12T08:00:00.000Z");

  assert.strictEqual(plan.name, "早会切主页");
  assert.strictEqual(plan.priority, 20);
  assert.deepStrictEqual(plan.scheduleSpec.weekdays, [1, 3]);
  assert.strictEqual(plan.steps[0].enabled, true);
  assert.strictEqual(plan.steps[0].orderIndex, 1);
});

runCase("computes next weekly run inside the configured weekday set", () => {
  const plan = normalizeTaskPlan({
    scheduleMode: "weekly",
    scheduleSpec: { weekdays: [1, 3], times: ["09:30"] },
  }, "2026-05-12T08:00:00.000Z");
  const next = computeNextRunAt(plan, new Date("2026-05-12T08:00:00.000Z"));

  assert.strictEqual(next, "2026-05-13T09:30:00.000Z");
});

runCase("detects higher priority running task on overlapping target", () => {
  const activeRuns = [
    { status: "running", priority: 50, targetSnapshot: ["dev_1"] },
    { status: "success", priority: 100, targetSnapshot: ["dev_2"] },
  ];

  assert.strictEqual(hasHigherPriorityActiveRun(activeRuns, { priority: 20, targetSnapshot: ["dev_1"] }), true);
  assert.strictEqual(hasHigherPriorityActiveRun(activeRuns, { priority: 80, targetSnapshot: ["dev_1"] }), false);
});

runCase("manual task run uses highest priority and manual override reason", () => {
  const plan = normalizeTaskPlan({ id: "task_1", priority: 10, targetDeviceIds: ["dev_1"] });
  const run = buildTaskRunRecord(plan, {
    triggerType: "manual",
    targetSnapshot: ["dev_1"],
    now: "2026-05-12T08:00:00.000Z",
  });

  assert.strictEqual(run.priority, 10000);
  assert.strictEqual(run.triggerType, "manual");
  assert.strictEqual(run.reason, "manual_override");
});

if (!process.exitCode) {
  console.log("task plan tests passed.");
}
