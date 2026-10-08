const assert = require("assert");

process.env.AZURE_SPEECH_KEY = "azure-key";
process.env.AZURE_SPEECH_REGION = "eastasia";
process.env.AZURE_SPEECH_LANGUAGE = "zh-CN";
delete process.env.ASR_COMMAND;

const { createAsrService } = require("../src/services/ai/asr.service");

async function run(name, fn) {
  try {
    await fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[failed] ${name}: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}

async function main() {
  await run("manual transcript stays highest priority", async () => {
    const service = createAsrService({
      httpPost: async () => {
        throw new Error("should not call Azure");
      },
    });
    const result = await service.recognizeVoice({
      transcript: "打开会议室屏幕",
      file: { buffer: Buffer.from("fake"), mimetype: "audio/wav", originalname: "a.wav" },
    });
    assert.strictEqual(result.text, "打开会议室屏幕");
    assert.strictEqual(result.provider, "manual");
  });

  await run("Azure Speech REST provider recognizes uploaded audio", async () => {
    let called = null;
    const service = createAsrService({
      httpPost: async (url, body, options) => {
        called = { url, body, options };
        return { data: { RecognitionStatus: "Success", DisplayText: "刷新 E6 相框。" } };
      },
    });
    const result = await service.recognizeVoice({
      file: { buffer: Buffer.from("RIFFdemo"), mimetype: "audio/wav", originalname: "voice.wav" },
    });
    assert.strictEqual(result.text, "刷新 E6 相框。");
    assert.strictEqual(result.provider, "azure_speech");
    assert.ok(called.url.includes("eastasia.stt.speech.microsoft.com"));
    assert.ok(called.url.includes("language=zh-CN"));
    assert.strictEqual(called.options.headers["Ocp-Apim-Subscription-Key"], "azure-key");
    assert.strictEqual(called.options.headers["Content-Type"], "audio/wav");
    assert.ok(Buffer.isBuffer(called.body));
  });

  await run("missing Azure config falls back to not_configured without ASR_COMMAND", async () => {
    const service = createAsrService({
      azure: { key: "", region: "", language: "zh-CN" },
    });
    const result = await service.recognizeVoice({
      file: { buffer: Buffer.from("demo"), mimetype: "audio/wav", originalname: "voice.wav" },
    });
    assert.strictEqual(result.text, "");
    assert.strictEqual(result.provider, "not_configured");
    assert.ok(result.message.includes("Azure Speech") && result.message.includes("ASR_COMMAND"));
  });

  if (process.exitCode) {
    throw new Error("ASR Azure self-test failed");
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
