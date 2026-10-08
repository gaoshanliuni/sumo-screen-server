/* eslint-disable no-console */
const assert = require("assert");

const {
  normalizeBackendBaseUrl,
  buildBackendUrlCommandPayload,
} = require("../src/services/remote_control.service");

function runCase(name, fn) {
  try {
    fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[failed] ${name}: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

runCase("normalizes http and https backend base urls for NVS", () => {
  assert.strictEqual(normalizeBackendBaseUrl(" http://192.168.9.106:8890/ "), "http://192.168.9.106:8890");
  assert.strictEqual(normalizeBackendBaseUrl("https://epd.gaoshanliuni.top:19999///"), "https://epd.gaoshanliuni.top:19999");
});

runCase("rejects unsupported backend base urls", () => {
  assert.throws(() => normalizeBackendBaseUrl("ftp://example.com"), /http\(s\)/);
  assert.throws(() => normalizeBackendBaseUrl("https://"), /格式不正确/);
  assert.throws(() => normalizeBackendBaseUrl(""), /不能为空/);
  assert.throws(() => normalizeBackendBaseUrl(`https://${"a".repeat(140)}.com`), /过长/);
});

runCase("builds hardware update backend url payload", () => {
  const payload = buildBackendUrlCommandPayload({
    commandId: "cmd_1",
    backendBaseUrl: "https://epd.gaoshanliuni.top:19999/",
    requestedAt: "2026-05-12T00:00:00.000Z",
  });

  assert.deepStrictEqual(payload, {
    commandId: "cmd_1",
    backendBaseUrl: "https://epd.gaoshanliuni.top:19999",
    requestedAt: "2026-05-12T00:00:00.000Z",
  });
});

if (!process.exitCode) {
  console.log("remote control tests passed.");
}
