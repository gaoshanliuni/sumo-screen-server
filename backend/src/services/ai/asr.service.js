const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const config = require("../../config");

const RUNTIME_DIR = path.resolve(__dirname, "../../../runtime/ai_voice");

function runCommand(command, args = [], timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("ASR timeout"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `ASR exited with ${code}`));
    });
  });
}

async function recognizeVoice({ file, transcript = "" } = {}) {
  return createAsrService().recognizeVoice({ file, transcript });
}

async function transcribe({ file, transcript = "" } = {}) {
  return createAsrService().transcribe({ file, transcript });
}

function resolveAzureSettings(overrides = {}) {
  return {
    key: String(overrides.key ?? config.asr.azureSpeechKey ?? "").trim(),
    region: String(overrides.region ?? config.asr.azureSpeechRegion ?? "").trim(),
    endpoint: String(overrides.endpoint ?? config.asr.azureSpeechEndpoint ?? "").trim(),
    language: String(overrides.language ?? config.asr.azureSpeechLanguage ?? "zh-CN").trim() || "zh-CN",
    timeoutMs: Number(overrides.timeoutMs || config.asr.timeoutMs || process.env.ASR_TIMEOUT_MS || 30000),
  };
}

function firstNonBlank(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function resolveFasterWhisperSettings(overrides = {}, env = process.env) {
  return {
    command: firstNonBlank(overrides.command, env.FASTER_WHISPER_COMMAND, config.asr.fasterWhisperCommand),
    argsTemplate: firstNonBlank(overrides.argsTemplate, env.FASTER_WHISPER_ARGS, config.asr.fasterWhisperArgs),
    model: firstNonBlank(overrides.model, env.FASTER_WHISPER_MODEL, config.asr.fasterWhisperModel, "small") || "small",
    language: firstNonBlank(overrides.language, env.FASTER_WHISPER_LANGUAGE, config.asr.fasterWhisperLanguage, "zh") || "zh",
    outputFormat: firstNonBlank(overrides.outputFormat, env.FASTER_WHISPER_OUTPUT_FORMAT, config.asr.fasterWhisperOutputFormat, "json") || "json",
    timeoutMs: Number(overrides.timeoutMs || env.ASR_TIMEOUT_MS || config.asr.timeoutMs || 30000),
  };
}

function buildAzureSpeechUrl(settings) {
  const endpoint = String(settings.endpoint || "").trim().replace(/\/+$/, "");
  const baseUrl = endpoint || `https://${settings.region}.stt.speech.microsoft.com`;
  const params = new URLSearchParams({
    language: settings.language || "zh-CN",
    format: "detailed",
  });
  return `${baseUrl}/speech/recognition/conversation/cognitiveservices/v1?${params.toString()}`;
}

function extractAzureTranscript(data = {}) {
  if (typeof data.DisplayText === "string" && data.DisplayText.trim()) return data.DisplayText.trim();
  if (Array.isArray(data.NBest) && data.NBest.length) {
    const best = data.NBest.find((item) => String(item.Display || item.Lexical || "").trim()) || data.NBest[0];
    return String(best.Display || best.Lexical || "").trim();
  }
  return "";
}

function normalizeProvider(value = "") {
  const text = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  return text || "azure_speech";
}

function resolveAzureSettingsFromEnv(overrides = {}, env = process.env) {
  return {
    key: firstNonBlank(overrides.key, env.AZURE_SPEECH_KEY, env.AZURE_SPEECH_API_KEY, config.asr.azureSpeechKey),
    region: firstNonBlank(overrides.region, env.AZURE_SPEECH_REGION, config.asr.azureSpeechRegion),
    endpoint: firstNonBlank(overrides.endpoint, env.AZURE_SPEECH_ENDPOINT, config.asr.azureSpeechEndpoint),
    language: firstNonBlank(overrides.language, env.AZURE_SPEECH_LANGUAGE, config.asr.azureSpeechLanguage, "zh-CN") || "zh-CN",
  };
}

function getAsrRuntimeStatus(options = {}) {
  const env = options.env || process.env;
  const rawProvider = options.provider || env.ASR_PROVIDER || config.asr.provider || "azure_speech";
  const provider = normalizeProvider(rawProvider);
  const azureSettings = resolveAzureSettingsFromEnv(options.azure || {}, env);
  const fasterWhisperSettings = resolveFasterWhisperSettings(options.fasterWhisper || {}, env);
  const command = firstNonBlank(env.ASR_COMMAND);

  if (provider === "azure_speech") {
    const configured = Boolean(azureSettings.key && (azureSettings.region || azureSettings.endpoint));
    return {
      configured,
      provider,
      mode: "cloud",
      language: azureSettings.language,
      message: configured ? "Azure Speech 已配置" : "Azure Speech 未配置，请设置 AZURE_SPEECH_KEY 和 AZURE_SPEECH_REGION/AZURE_SPEECH_ENDPOINT",
    };
  }

  if (provider === "faster_whisper") {
    const configured = Boolean(fasterWhisperSettings.command);
    return {
      configured,
      provider,
      mode: "local",
      command: fasterWhisperSettings.command,
      argsTemplate: fasterWhisperSettings.argsTemplate,
      model: fasterWhisperSettings.model,
      language: fasterWhisperSettings.language,
      outputFormat: fasterWhisperSettings.outputFormat,
      message: configured ? "本地 faster-whisper 已配置" : "faster-whisper 未配置，请设置 FASTER_WHISPER_COMMAND 或启用 ASR_AUTO_SETUP",
    };
  }

  if (provider === "command") {
    const configured = Boolean(command);
    return {
      configured,
      provider,
      mode: "custom",
      command,
      message: configured ? "自定义 ASR_COMMAND 已配置" : "自定义 ASR_COMMAND 未配置",
    };
  }

  return {
    configured: false,
    provider,
    mode: "unknown",
    message: `不支持的 ASR_PROVIDER: ${rawProvider}`,
  };
}

function splitCommandArgs(template = "", variables = {}) {
  return String(template || "")
    .replace(/\{file\}/g, variables.file || "")
    .replace(/\{model\}/g, variables.model || "")
    .replace(/\{language\}/g, variables.language || "")
    .replace(/\{outputDir\}/g, variables.outputDir || "")
    .replace(/\{outputFormat\}/g, variables.outputFormat || "")
    .match(/(?:"([^"]*)"|'([^']*)'|[^\s"]+)/g)
    ?.map((item) => item.replace(/^["']|["']$/g, ""))
    .filter(Boolean) || [];
}

function buildFasterWhisperArgs(settings, filePath, outputDir) {
  const variables = {
    file: filePath,
    model: settings.model,
    language: settings.language,
    outputDir,
    outputFormat: settings.outputFormat,
  };
  if (settings.argsTemplate) return splitCommandArgs(settings.argsTemplate, variables);
  return [
    filePath,
    "--model",
    settings.model,
    "--language",
    settings.language,
    "--output_format",
    settings.outputFormat,
    "--output_dir",
    outputDir,
  ];
}

function transcriptFromText(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.text === "string") return parsed.text.trim();
    if (Array.isArray(parsed.segments)) {
      return parsed.segments.map((item) => String(item.text || "").trim()).filter(Boolean).join("");
    }
  } catch (_) {
    // Custom wrappers may print plain transcript text.
  }
  return text;
}

async function readTranscriptFile(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((item) => item.isFile() && /\.(json|txt|srt|vtt)$/i.test(item.name))
    .map((item) => path.join(outputDir, item.name));
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8").catch(() => "");
    const text = transcriptFromText(content);
    if (text) return text;
  }
  return "";
}

function createAsrService(options = {}) {
  const httpPost = options.httpPost || axios.post;
  const env = options.env || process.env;
  const commandRunner = options.commandRunner || runCommand;
  const azureSettings = resolveAzureSettings(options.azure || {});
  const rawProvider = options.provider || env.ASR_PROVIDER || config.asr.provider || "azure_speech";
  const provider = normalizeProvider(rawProvider);
  const fasterWhisperProviderName = String(rawProvider || "").trim().toLowerCase() === "faster-whisper" ? "faster-whisper" : "faster_whisper";
  const fasterWhisperSettings = resolveFasterWhisperSettings(options.fasterWhisper || {}, env);

  async function recognizeWithCommand(file) {
    const command = String(env.ASR_COMMAND || "").trim();
    if (!command) {
      return {
        text: "",
        provider: "not_configured",
        message: "语音识别未配置，请配置 faster-whisper、Microsoft Azure Speech 或 ASR_COMMAND",
      };
    }
    await fs.mkdir(RUNTIME_DIR, { recursive: true });
    const ext = path.extname(file.originalname || "") || ".audio";
    const target = path.join(RUNTIME_DIR, `voice_${Date.now()}${ext}`);
    await fs.writeFile(target, file.buffer);
    const text = await commandRunner(command, [target], Number(env.ASR_TIMEOUT_MS || azureSettings.timeoutMs || 30000));
    return { text, provider: "command" };
  }

  async function recognizeWithFasterWhisper(file) {
    const command = fasterWhisperSettings.command;
    if (!command) {
      return {
        ok: false,
        text: "",
        provider: fasterWhisperProviderName,
        code: "ASR_FASTER_WHISPER_NOT_CONFIGURED",
        message: "faster-whisper 未配置，请设置 FASTER_WHISPER_COMMAND，或将 ASR_PROVIDER 改为 azure_speech/command。",
      };
    }
    await fs.mkdir(RUNTIME_DIR, { recursive: true });
    const jobId = `fw_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const ext = path.extname(file.originalname || "") || ".audio";
    const target = path.join(RUNTIME_DIR, `${jobId}${ext}`);
    const outputDir = path.join(RUNTIME_DIR, jobId);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(target, file.buffer);
    try {
      const args = buildFasterWhisperArgs(fasterWhisperSettings, target, outputDir);
      const stdout = await commandRunner(command, args, fasterWhisperSettings.timeoutMs);
      const text = transcriptFromText(stdout) || await readTranscriptFile(outputDir);
      return {
        ok: Boolean(text),
        text,
        provider: fasterWhisperProviderName,
        model: fasterWhisperSettings.model,
        language: fasterWhisperSettings.language,
        message: text ? "ok" : "faster-whisper 未输出转写文本",
      };
    } catch (error) {
      return {
        ok: false,
        text: "",
        provider: fasterWhisperProviderName,
        code: error?.code || "ASR_FASTER_WHISPER_FAILED",
        message: error?.message || String(error || "faster-whisper 转写失败"),
      };
    } finally {
      fs.rm(target, { force: true }).catch(() => {});
      fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function recognizeWithAzure(file) {
    if (!azureSettings.key || (!azureSettings.region && !azureSettings.endpoint)) {
      return null;
    }
    const contentType = String(file.mimetype || "audio/wav").trim() || "audio/wav";
    const resp = await httpPost(buildAzureSpeechUrl(azureSettings), file.buffer, {
      timeout: azureSettings.timeoutMs,
      headers: {
        "Ocp-Apim-Subscription-Key": azureSettings.key,
        "Content-Type": contentType,
        Accept: "application/json",
      },
      maxBodyLength: Infinity,
    });
    return {
      text: extractAzureTranscript(resp.data || {}),
      provider: "azure_speech",
      rawStatus: String(resp.data?.RecognitionStatus || ""),
    };
  }

  async function recognizeVoiceFromProvider({ file, transcript = "" } = {}) {
    const manual = String(transcript || "").trim();
    if (manual) return { ok: true, text: manual, provider: "manual" };

    if (!file || !file.buffer || !file.buffer.length) {
      return { ok: false, text: "", provider: "none", code: "ASR_NO_AUDIO", message: "未收到语音文件" };
    }

    const fasterWhisperFirst = provider === "faster_whisper" || Boolean(fasterWhisperSettings.command);
    if (fasterWhisperFirst) {
      const fasterWhisperResult = await recognizeWithFasterWhisper(file);
      if (provider === "faster_whisper" || fasterWhisperResult.ok) return fasterWhisperResult;
    }
    const azureResult = await recognizeWithAzure(file);
    if (azureResult) return { ok: Boolean(azureResult.text), ...azureResult };
    const fasterWhisperResult = await recognizeWithFasterWhisper(file);
    if (fasterWhisperResult.ok) return fasterWhisperResult;
    const commandResult = await recognizeWithCommand(file);
    return { ok: Boolean(commandResult.text), ...commandResult };
  }

  return {
    transcribe: recognizeVoiceFromProvider,
    recognizeVoice: recognizeVoiceFromProvider,
  };
}

module.exports = {
  recognizeVoice,
  transcribe,
  createAsrService,
  getAsrRuntimeStatus,
  buildAzureSpeechUrl,
  buildFasterWhisperArgs,
};
