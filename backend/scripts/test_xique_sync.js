const assert = require("assert");
const {
  getSchedulerDecision,
  importXiqueCoursesToDraft,
  getCurrentSemesterKey,
  createXiqueClient,
} = require("../src/services/xique_sync.service");

const tests = [];

function run(name, fn) {
  tests.push({ name, fn });
}

run("quiet hours are blocked", () => {
  const decision = getSchedulerDecision(new Date("2026-04-09T02:00:00+08:00"), { enabled: true, nextRunAt: "" });
  assert.strictEqual(decision.shouldRun, false);
  assert.strictEqual(decision.reason, "quiet_hours");
});

run("active window runs when due", () => {
  const decision = getSchedulerDecision(new Date("2026-04-09T07:00:00+08:00"), {
    enabled: true,
    nextRunAt: "2026-04-09T06:30:00+08:00",
  });
  assert.strictEqual(decision.shouldRun, true);
  assert.strictEqual(decision.reason, "due");
});

run("needCaptchaReverify blocks scheduler", () => {
  const decision = getSchedulerDecision(new Date("2026-04-09T07:00:00+08:00"), {
    enabled: true,
    needCaptchaReverify: true,
    nextRunAt: "",
  });
  assert.strictEqual(decision.shouldRun, false);
  assert.strictEqual(decision.reason, "needCaptchaReverify");
});

run("xique import keeps manual rows and deduplicates xique rows", () => {
  const termKey = getCurrentSemesterKey(new Date("2026-04-09T00:00:00+08:00"));
  const draft = {
    schedules: [
      {
        id: "manual-1",
        deviceId: "dev1",
        source: "manual",
        sourceKey: "",
        termKey: "",
        title: "手工记录",
        content: "",
        courseName: "手工记录",
        note: "",
        weekday: 1,
        orderIndex: 1,
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
      },
      {
        id: "xique-old-1",
        deviceId: "dev1",
        source: "xique",
        sourceKey: "math:1:1-2:A101",
        termKey,
        title: "数学旧版",
        content: "",
        courseName: "数学旧版",
        note: "",
        weekday: 1,
        orderIndex: 1,
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
      },
    ],
    scheduleSyncConfigs: [],
    xiqueSessionVault: [],
    syncLogs: [],
  };
  const cfg = { deviceId: "dev1", currentTermKey: termKey };

  const payload1 = {
    termKey,
    courses: [
      { courseId: "math", courseName: "数学", teacherName: "张老师", location: "A101", weekday: 1, startPeriod: 1, endPeriod: 2 },
      { courseId: "eng", courseName: "英语", teacherName: "李老师", location: "B201", weekday: 2, startPeriod: 3, endPeriod: 4 },
    ],
  };
  const result1 = importXiqueCoursesToDraft(draft, cfg, payload1, { deviceId: "dev1" });
  assert.strictEqual(result1.added, 1, "result1.added");
  assert.strictEqual(result1.updated, 1, "result1.updated");
  assert.strictEqual(result1.overwritten, 0, "result1.overwritten");

  const payload2 = {
    termKey,
    courses: [
      { courseId: "math", courseName: "数学", teacherName: "张老师", location: "A101", weekday: 1, startPeriod: 1, endPeriod: 2 },
    ],
  };
  const result2 = importXiqueCoursesToDraft(draft, cfg, payload2, { deviceId: "dev1" });
  assert.strictEqual(result2.added, 0, "result2.added");
  assert.strictEqual(result2.overwritten >= 1, true, "result2.overwritten");
  assert.strictEqual(draft.schedules.some((row) => row.id === "manual-1"), true, "manual row preserved after overwrite");

  const xiqueRows = draft.schedules.filter((row) => row.deviceId === "dev1" && row.source === "xique" && row.termKey === termKey);
  assert.strictEqual(xiqueRows.length, 1, "xique rows deduplicated");
});

run("session is reusable after first login", async () => {
  const cfg = { intervalMinutes: 60, currentTermKey: "2026-S1", requireCaptcha: false };
  const vault = {};
  const client = await createXiqueClient(cfg, vault, {});
  const first = await client.prepareLogin();
  assert.strictEqual(first.captchaRequired, false);
  assert.strictEqual(Boolean(first.session?.sessionId), true);

  const second = await client.prepareLogin();
  assert.strictEqual(Boolean(second.session?.sessionId), true);
  assert.strictEqual(second.session.sessionId, first.session.sessionId, "session should be reused");
});

run("captcha flow rejects invalid answer", async () => {
  const cfg = { intervalMinutes: 60, currentTermKey: "2026-S1", requireCaptcha: true };
  const vault = {};
  const client = await createXiqueClient(cfg, vault, { forceCaptcha: true });
  const challenge = await client.prepareLogin();
  assert.strictEqual(challenge.captchaRequired, true);
  let threw = false;
  try {
    await client.completeLogin({ captchaSession: challenge.captchaSession, captchaAnswer: "0000" });
  } catch (error) {
    threw = true;
    assert.ok(String(error.message).includes("captcha"));
  }
  assert.strictEqual(threw, true, "invalid captcha should fail");
});

(async () => {
  for (const test of tests) {
    try {
      await test.fn();
      console.log(`PASS ${test.name}`);
    } catch (error) {
      console.error(`FAIL ${test.name}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (process.exitCode) {
    throw new Error("xique self-test failed");
  }
  console.log("All xique self-tests passed");
})();
