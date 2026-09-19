/* eslint-disable no-console */
const assert = require("assert");
const { createAsrService } = require("../src/services/ai/asr.service");

async function main() {
  const calls = [];
  const service = createAsrService({
    azure: { key: "", region: "", endpoint: "" },
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      return "  你好，墨水屏  ";
    },
    env: {
      ASR_PROVIDER: "faster-whisper",
      FASTER_WHISPER_COMMAND: "fw.cmd",
      FASTER_WHISPER_MODEL: "small",
      FASTER_WHISPER_LANGUAGE: "zh",
    },
  });
  const result = await service.recognizeVoice({
    file: {
      originalname: "voice.wav",
      mimetype: "audio/wav",
      buffer: Buffer.from("RIFFdemo"),
    },
  });
  assert.strictEqual(result.text, "你好，墨水屏");
  assert.strictEqual(result.provider, "faster-whisper");
  assert.strictEqual(calls[0].command, "fw.cmd");
  assert.ok(calls[0].args.some((item) => String(item).includes("--model")));
  console.log("[ok] ASR faster-whisper command provider contract passed");
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
