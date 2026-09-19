/* eslint-disable no-console */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const startShPath = path.join(root, "start.sh");
const requirementsPath = path.join(root, "tools", "asr", "requirements.txt");
const cliPath = path.join(root, "tools", "asr", "faster_whisper_cli.py");

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function assertContains(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message || `expected content to include ${needle}`);
}

async function main() {
  const startSh = read(startShPath);
  assertContains(startSh, "ASR_AUTO_SETUP", "Linux start.sh must expose ASR_AUTO_SETUP");
  assertContains(startSh, "ensure_asr_requirements", "Linux start.sh must install ASR requirements when enabled");
  assertContains(startSh, "tools/asr/requirements.txt", "Linux start.sh must install ASR Python requirements from tools/asr");
  assertContains(startSh, "FASTER_WHISPER_COMMAND", "Linux start.sh must export local faster-whisper command");
  assertContains(startSh, "FASTER_WHISPER_ARGS", "Linux start.sh must export local faster-whisper args");
  assertContains(startSh, "ASR_PROVIDER", "Linux start.sh must set ASR provider for production voice commands");
  assertContains(startSh, "ASR_SETUP_MODE", "Linux start.sh must expose ASR_SETUP_MODE");
  assertContains(startSh, "ensure_asr_requirements_background", "Linux start.sh must support non-blocking ASR setup");
  assert.ok(
    /ensure_asr_requirements_background[\s\S]+ensure_local_browser[\s\S]+export_runtime_env/.test(startSh),
    "ASR requirements setup should be scheduled before runtime env is exported"
  );
  assert.ok(
    /ASR python dependencies will install in background; backend startup will not wait/.test(startSh),
    "ASR setup must not block backend startup by default"
  );

  assert.ok(fs.existsSync(requirementsPath), "tools/asr/requirements.txt must exist");
  const requirements = read(requirementsPath);
  assert.match(requirements, /(^|\n)faster-whisper([=<>~! ]|$)/, "ASR requirements must include faster-whisper");

  assert.ok(fs.existsSync(cliPath), "tools/asr/faster_whisper_cli.py must exist");
  const python = process.platform === "win32" ? "python" : "python3";
  const help = spawnSync(python, [cliPath, "--help"], { encoding: "utf8" });
  assert.strictEqual(help.status, 0, `ASR CLI --help should work without model dependencies: ${help.stderr || help.stdout}`);
  assert.match(help.stdout, /--model/, "ASR CLI help should expose --model");

  const { getAsrRuntimeStatus } = require("../src/services/ai/asr.service");
  assert.strictEqual(typeof getAsrRuntimeStatus, "function", "ASR service must expose runtime status diagnostics");

  const localStatus = getAsrRuntimeStatus({
    env: {
      ASR_PROVIDER: "faster_whisper",
      FASTER_WHISPER_COMMAND: "/app/backend/.venv/bin/python",
      FASTER_WHISPER_ARGS: "/app/backend/tools/asr/faster_whisper_cli.py {file} --model {model}",
      FASTER_WHISPER_MODEL: "small",
      FASTER_WHISPER_LANGUAGE: "zh",
    },
  });
  assert.strictEqual(localStatus.configured, true);
  assert.strictEqual(localStatus.provider, "faster_whisper");
  assert.strictEqual(localStatus.mode, "local");
  assert.strictEqual(localStatus.model, "small");

  const azureStatus = getAsrRuntimeStatus({
    env: {
      ASR_PROVIDER: "azure_speech",
      AZURE_SPEECH_KEY: "key",
      AZURE_SPEECH_REGION: "eastasia",
    },
  });
  assert.strictEqual(azureStatus.configured, true);
  assert.strictEqual(azureStatus.provider, "azure_speech");
  assert.strictEqual(azureStatus.mode, "cloud");

  const missingStatus = getAsrRuntimeStatus({
    provider: "faster_whisper",
    env: {
      ASR_PROVIDER: "faster_whisper",
    },
    fasterWhisper: {
      command: "",
    },
  });
  assert.strictEqual(missingStatus.configured, false);
  assert.match(missingStatus.message, /FASTER_WHISPER_COMMAND/);

  console.log("[ok] Linux ASR runtime contract passed");
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
