/* eslint-disable no-console */
const assert = require("assert");

const {
  buildDeviceVariableContext,
  upsertBaseVariableOnDevice,
  deleteBaseVariableOnDevice,
  buildApiVariableRows,
} = require("../src/services/device_variable.service");
const {
  buildCommonDataModel,
  interpolateForTemplate,
} = require("../src/services/page_profile.service");

function runCase(name, fn) {
  try {
    fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[failed] ${name}: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

runCase("base device variables keep Chinese names and template aliases", () => {
  const device = { id: "dev_1", deviceVariables: { base: [{ name: "姓名", value: "张三" }] } };
  const context = buildDeviceVariableContext({ apiTemplates: [] }, device);

  assert.strictEqual(context.deviceVariables["姓名"], "张三");
  assert.strictEqual(context.device_variables.base["姓名"], "张三");
  assert.strictEqual(context.deviceVariableList[0].path, "deviceVariables.姓名");
});

runCase("upsert and delete base variable mutate only the target name", () => {
  const device = { id: "dev_1", deviceVariables: { base: [{ name: "姓名", value: "张三" }] } };

  upsertBaseVariableOnDevice(device, { name: "职位", value: "产品经理" }, "2026-05-12T00:00:00.000Z");
  upsertBaseVariableOnDevice(device, { name: "姓名", value: "李四" }, "2026-05-12T00:01:00.000Z");
  assert.deepStrictEqual(
    device.deviceVariables.base.map((item) => [item.name, item.value]),
    [
      ["姓名", "李四"],
      ["职位", "产品经理"],
    ]
  );

  deleteBaseVariableOnDevice(device, "职位", "2026-05-12T00:02:00.000Z");
  assert.deepStrictEqual(device.deviceVariables.base.map((item) => item.name), ["姓名"]);
});

runCase("api variables flatten current thirdApiCache values", () => {
  const device = {
    id: "dev_1",
    thirdApiCache: {
      weather: {
        template: { slug: "weather", name: "天气" },
        formatted: { temperature: "26", nested: { text: "晴" } },
        updatedAt: "2026-05-12T00:00:00.000Z",
      },
    },
  };
  const rows = buildApiVariableRows({ apiTemplates: [{ slug: "weather", name: "天气" }] }, device);

  assert.ok(rows.some((item) => item.path === "api.formatted_by_slug.weather.temperature" && item.value === "26"));
  assert.ok(rows.some((item) => item.path === "api.formatted_by_slug.weather.nested.text" && item.value === "晴"));
});

runCase("homepage data model resolves device variable placeholders", () => {
  const db = { todos: [], schedules: [], apiTemplates: [] };
  const device = { id: "dev_1", mac: "AA:BB:CC:DD:EE:FF", deviceVariables: { base: [{ name: "姓名", value: "张三" }] } };
  const model = buildCommonDataModel(db, device, {});

  assert.strictEqual(model.deviceVariables["姓名"], "张三");
  assert.strictEqual(interpolateForTemplate("姓名：{{deviceVariables.姓名}}", model), "姓名：张三");
});

runCase("homepage data model resolves dotted device variable names as nested paths", () => {
  const db = { todos: [], schedules: [], apiTemplates: [] };
  const device = {
    id: "dev_1",
    mac: "AA:BB:CC:DD:EE:FF",
    deviceVariables: { base: [{ name: "weather.temperature", value: "26" }] },
  };
  const model = buildCommonDataModel(db, device, {});

  assert.strictEqual(model.deviceVariables["weather.temperature"], "26");
  assert.strictEqual(interpolateForTemplate("温度：{{deviceVariables.weather.temperature}}", model), "温度：26");
});

runCase("device variable payload keeps base and api suggestions separated", () => {
  const { buildDeviceVariablePayload } = require("../src/services/device_variable.service");
  const db = { apiTemplates: [{ slug: "weather", name: "天气" }] };
  const device = {
    id: "dev_1",
    deviceVariables: { base: [{ name: "姓名", value: "张三" }] },
    thirdApiCache: {
      weather: {
        template: { slug: "weather", name: "天气" },
        formatted: { temperature: "26" },
        updatedAt: "2026-05-12T00:00:00.000Z",
      },
    },
  };
  const payload = buildDeviceVariablePayload(db, device);

  assert.deepStrictEqual(payload.suggestions.names, ["姓名"]);
  assert.deepStrictEqual(payload.suggestions.values, ["张三"]);
  assert.ok(payload.apiSuggestions.names.includes("weather.temperature"));
  assert.ok(payload.apiSuggestions.values.includes("26"));
});

if (!process.exitCode) {
  console.log("device variable tests passed.");
}
