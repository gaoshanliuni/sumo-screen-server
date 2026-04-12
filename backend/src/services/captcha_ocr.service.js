const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../config");

function trimString(v) {
  return String(v ?? "").trim();
}

function stripDataUrlPrefix(input) {
  const raw = trimString(input);
  if (!raw) return "";
  const match = raw.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  if (match?.[1]) return trimString(match[1]);
  return raw;
}

function sanitizeCaptchaText(text = "", expectedLength = Number(config.xiqueCaptchaExpectedLength || 4)) {
  const cleaned = trimString(text).replace(/\s+/g, "").replace(/[^0-9A-Za-z]/g, "");
  if (!cleaned) return { text: "", valid: false, reason: "empty" };
  if (expectedLength > 0 && cleaned.length !== expectedLength) {
    return { text: cleaned, valid: false, reason: `length_${cleaned.length}` };
  }
  return { text: cleaned, valid: true, reason: "ok" };
}

function splitCommandLine(raw) {
  const line = trimString(raw);
  if (!line) return [];
  const out = [];
  const re = /[^\s"]+|"([^"]*)"/g;
  let match = re.exec(line);
  while (match) {
    out.push(match[1] !== undefined ? match[1] : match[0]);
    match = re.exec(line);
  }
  return out.filter(Boolean);
}

function normalizeInterpreter(raw) {
  const parts = splitCommandLine(raw);
  if (!parts.length) return null;
  return { cmd: parts[0], preArgs: parts.slice(1) };
}

function getScriptPath() {
  return trimString(config.xiqueOcrScriptPath) || path.join(__dirname, "../../tools/ocr/recognize_captcha.py");
}

function getRequirementsPath() {
  return trimString(config.xiqueOcrRequirementsPath) || path.join(__dirname, "../../tools/ocr/requirements.txt");
}

function getInterpreterCandidates() {
  const configured = normalizeInterpreter(config.xiqueOcrPythonBin || "python");
  const defaults = process.platform === "win32"
    ? [
        normalizeInterpreter("python"),
        normalizeInterpreter("py -3"),
        normalizeInterpreter("python3"),
      ]
    : [
        normalizeInterpreter("python3"),
        normalizeInterpreter("python"),
      ];
  const merged = [configured, ...defaults].filter(Boolean);
  const seen = new Set();
  return merged.filter((item) => {
    const key = `${item.cmd} ${item.preArgs.join(" ")}`.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runPythonJson(interpreter, args = [], payload = {}, timeoutMs = Number(config.xiqueOcrTimeoutMs || 6000)) {
  return new Promise((resolve, reject) => {
    const child = spawn(interpreter.cmd, [...(interpreter.preArgs || []), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch (_) {
        // ignore
      }
      reject(new Error("ocr_timeout"));
    }, Math.max(1000, Number(timeoutMs || 6000)));

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (Number(code || 0) !== 0) {
        return reject(new Error(`ocr_process_exit_${code}:${trimString(stderr).slice(0, 160)}`));
      }
      try {
        resolve(JSON.parse(trimString(stdout) || "{}"));
      } catch (_) {
        reject(new Error(`ocr_invalid_output:${trimString(stdout).slice(0, 200)}`));
      }
    });

    child.stdin.write(JSON.stringify(payload || {}));
    child.stdin.end();
  });
}

function installRequirements(interpreter) {
  return new Promise((resolve) => {
    const requirements = getRequirementsPath();
    if (!fs.existsSync(requirements)) return resolve({ ok: false, reason: "requirements_missing" });
    const args = [
      ...(interpreter.preArgs || []),
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--user",
      "-r",
      requirements,
    ];
    const child = spawn(interpreter.cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", (error) => {
      resolve({ ok: false, reason: trimString(error?.message || "pip_spawn_failed") });
    });
    child.on("close", (code) => {
      if (Number(code || 0) !== 0) {
        return resolve({ ok: false, reason: `pip_exit_${code}:${trimString(stderr).slice(0, 180)}` });
      }
      return resolve({ ok: true, reason: "installed" });
    });
  });
}

const runtime = {
  checked: false,
  ready: false,
  interpreter: null,
  lastError: "",
  installing: false,
  triedInstall: false,
};

async function probeInterpreter(interpreter) {
  const script = getScriptPath();
  if (!fs.existsSync(script)) {
    return { ok: false, reason: "ocr_script_missing" };
  }
  try {
    const probe = await runPythonJson(interpreter, [script, "--probe"], { probe: true }, 4000);
    if (probe?.ok) return { ok: true, reason: "probe_ok" };
    return { ok: false, reason: trimString(probe?.error || "probe_failed") };
  } catch (error) {
    return { ok: false, reason: trimString(error?.message || "probe_failed") };
  }
}

async function ensureOcrRuntimeReady() {
  if (runtime.checked && runtime.ready && runtime.interpreter) {
    return { ready: true, interpreter: runtime.interpreter, reason: "cached" };
  }
  const candidates = getInterpreterCandidates();
  for (const item of candidates) {
    const probe = await probeInterpreter(item);
    if (probe.ok) {
      runtime.checked = true;
      runtime.ready = true;
      runtime.interpreter = item;
      runtime.lastError = "";
      return { ready: true, interpreter: item, reason: "probe_ok" };
    }

    const canAutoSetup = Boolean(config.xiqueOcrAutoSetup) && /missing_ddddocr/i.test(String(probe.reason || ""));
    if (canAutoSetup && !runtime.triedInstall && !runtime.installing) {
      runtime.installing = true;
      const installed = await installRequirements(item);
      runtime.installing = false;
      runtime.triedInstall = true;
      if (installed.ok) {
        const reprobe = await probeInterpreter(item);
        if (reprobe.ok) {
          runtime.checked = true;
          runtime.ready = true;
          runtime.interpreter = item;
          runtime.lastError = "";
          return { ready: true, interpreter: item, reason: "auto_installed" };
        }
        runtime.lastError = trimString(reprobe.reason || "probe_after_install_failed");
      } else {
        runtime.lastError = trimString(installed.reason || "pip_install_failed");
      }
    } else {
      runtime.lastError = trimString(probe.reason || "probe_failed");
    }
  }

  runtime.checked = true;
  runtime.ready = false;
  return { ready: false, reason: runtime.lastError || "ocr_runtime_unavailable" };
}

async function recognizeCaptchaFromDataUrl(captchaImage, options = {}) {
  if (!config.xiqueOcrEnabled) {
    return { enabled: false, ok: false, text: "", reason: "ocr_disabled" };
  }
  const imageBase64 = stripDataUrlPrefix(captchaImage);
  if (!imageBase64) {
    return { enabled: true, ok: false, text: "", reason: "captcha_image_empty" };
  }

  const ready = await ensureOcrRuntimeReady();
  if (!ready.ready || !ready.interpreter) {
    return { enabled: true, ok: false, text: "", reason: ready.reason || "ocr_runtime_unavailable" };
  }

  const expectedLength = Math.max(0, Number(options.expectedLength || config.xiqueCaptchaExpectedLength || 4));
  try {
    const script = getScriptPath();
    const result = await runPythonJson(ready.interpreter, [script], { imageBase64 });
    const sanitized = sanitizeCaptchaText(result?.text || "", expectedLength);
    return {
      enabled: true,
      ok: sanitized.valid,
      text: sanitized.text,
      reason: sanitized.reason,
      raw: { confidence: Number(result?.confidence || 0) },
    };
  } catch (error) {
    return { enabled: true, ok: false, text: "", reason: trimString(error?.message || "ocr_failed") };
  }
}

async function warmupOcrRuntime() {
  const state = await ensureOcrRuntimeReady();
  return {
    ready: Boolean(state.ready),
    reason: trimString(state.reason || ""),
    interpreter: runtime.interpreter
      ? `${runtime.interpreter.cmd} ${(runtime.interpreter.preArgs || []).join(" ")}`.trim()
      : "",
  };
}

module.exports = {
  recognizeCaptchaFromDataUrl,
  sanitizeCaptchaText,
  warmupOcrRuntime,
};

