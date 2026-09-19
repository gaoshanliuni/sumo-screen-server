/* eslint-disable no-console */
const assert = require("assert");
const {
  parseScheduleSlots,
  isCourseActiveInWeek,
  importXiqueCoursesToDraft,
  normalizeWeeksArray,
} = require("../src/services/xique_sync.service");

function testParseSimpleWeeks() {
  const slots = parseScheduleSlots("1-4周 二[7-8] 二教0110(160)");
  assert(slots.length >= 1, "expected at least one parsed slot");
  const target = slots[0];
  assert.strictEqual(target.weekday, 2);
  assert.strictEqual(target.startPeriod, 7);
  assert.strictEqual(target.endPeriod, 8);
  assert.deepStrictEqual(normalizeWeeksArray(target.weeks), [1, 2, 3, 4]);
}

function testParseComplexWeeks() {
  const slots = parseScheduleSlots("1-4,7-14周 四[3-4] ,7周 二[7-8] ,8周 二[7-8]");
  const thu = slots.find((item) => item.weekday === 4);
  const tue7 = slots.find((item) => item.weekday === 2 && normalizeWeeksArray(item.weeks).join(",") === "7");
  const tue8 = slots.find((item) => item.weekday === 2 && normalizeWeeksArray(item.weeks).join(",") === "8");
  assert(thu, "expected Thursday slot");
  assert(tue7, "expected Tuesday week 7 slot");
  assert(tue8, "expected Tuesday week 8 slot");
  assert(thu.weeks.includes(7) && thu.weeks.includes(14), "Thursday weeks should include 7-14");
  assert(!isCourseActiveInWeek([1, 2, 3, 4], 5), "week 5 should be inactive for 1-4");
  assert(isCourseActiveInWeek([7], 7), "week 7 should be active for [7]");
}

function testOverwriteSync() {
  const draft = {
    schedules: [
      {
        id: "old_xique_a",
        deviceId: "dev_1",
        source: "xique",
        termKey: "2026-S1",
        sourceKey: "old:a",
        title: "旧课程A",
      },
      {
        id: "old_xique_b",
        deviceId: "dev_1",
        source: "xique",
        termKey: "2026-S1",
        sourceKey: "old:b",
        title: "旧课程B",
      },
      {
        id: "manual_1",
        deviceId: "dev_1",
        source: "manual",
        termKey: "2026-S1",
        sourceKey: "manual:1",
        title: "手工日程",
      },
    ],
    scheduleSyncConfigs: [],
    xiqueSessionVault: [],
    syncLogs: [],
  };

  const configRow = {
    deviceId: "dev_1",
    currentTermKey: "2026-S1",
    termStartDate: "2026-02-24",
  };
  const payload = {
    termKey: "2026-S1",
    courses: [
      {
        courseId: "new-course",
        courseName: "新课程",
        weekday: 2,
        startPeriod: 7,
        endPeriod: 8,
        weeks: [7],
        sourceKey: "new-course:2:7-8:7",
      },
    ],
  };

  const result = importXiqueCoursesToDraft(draft, configRow, payload, { deviceId: "dev_1" });
  assert.strictEqual(result.imported, 1);
  const xiqueRows = draft.schedules.filter(
    (row) => row.deviceId === "dev_1" && row.source === "xique" && row.termKey === "2026-S1"
  );
  assert.strictEqual(xiqueRows.length, 1, "old xique rows should be replaced");
  assert.strictEqual(
    draft.schedules.filter((row) => row.source === "manual").length,
    1,
    "manual schedules should be kept"
  );
}

function main() {
  testParseSimpleWeeks();
  testParseComplexWeeks();
  testOverwriteSync();
  console.log("xique week filter tests passed");
}

main();
