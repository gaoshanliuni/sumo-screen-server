/* eslint-disable no-console */
const assert = require("assert");

const { createAsrService } = require("../src/services/ai/asr.service");

const wavFile = {
  originalname: "voice.wav",
  mimetype: "audio/wav",
  buffer: Buffer.from("RIFF....WAVEfmt ", "utf8"),
};

async function main() {
  const missing = createAsrService({
    provider: "faster_whisper",
    fasterWhisper: { command: "" },
  });
  assert.strictEqual(typeof missing.transcribe, "function");
  const missingResult = await missing.transcribe({ file: wavFile });
  assert.strictEqual(missingResult.ok, false);
  assert.strictEqual(missingResult.provider, "faster_whisper");
  assert.strictEqual(missingResult.code, "ASR_FASTER_WHISPER_NOT_CONFIGURED");
  assert.ok(missingResult.message.includes("FASTER_WHISPER_COMMAND"));

  let capturedCommand = "";
  let capturedArgs = [];
  const service = createAsrService({
    provider: "faster_whisper",
    fasterWhisper: {
      command: "faster-whisper",
      model: "small",
      language: "zh",
      outputFormat: "json",
    },
    commandRunner: async (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return JSON.stringify({ text: "你好，墨水屏" });
    },
  });
  const result = await service.transcribe({ file: wavFile });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.provider, "faster_whisper");
  assert.strictEqual(result.text, "你好，墨水屏");
  assert.strictEqual(capturedCommand, "faster-whisper");
  assert.ok(capturedArgs.includes("--model"));
  assert.ok(capturedArgs.includes("small"));
  assert.ok(capturedArgs.includes("--language"));
  assert.ok(capturedArgs.includes("zh"));

  const manual = await service.transcribe({ transcript: "手动文本" });
  assert.strictEqual(manual.ok, true);
  assert.strictEqual(manual.provider, "manual");
  assert.strictEqual(manual.text, "手动文本");

  console.log("[ok] faster-whisper ASR contract passed");
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
