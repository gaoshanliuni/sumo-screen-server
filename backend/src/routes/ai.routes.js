const express = require("express");
const multer = require("multer");
const asyncHandler = require("../utils/asyncHandler");
const HttpError = require("../utils/httpError");
const { allowRoles } = require("../middleware/auth");
const { readDB, updateDBOptimistic } = require("../db/store");
const { chat, streamChat, confirmAction } = require("../services/ai/ai_gateway.service");
const { recognizeVoice, transcribe, getAsrRuntimeStatus } = require("../services/ai/asr.service");
const { createAiConfigService } = require("../services/ai/ai_config.service");
const { getTaskService } = require("../tasks/queue");

const router = express.Router();
router.use(allowRoles("admin", "user"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.ASR_UPLOAD_MAX_MB || 5) * 1024 * 1024 },
});
const aiConfigService = createAiConfigService();

router.get(
  "/config/me",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    res.success(aiConfigService.getMyConfig(db, req.auth), "ok");
  })
);

router.get(
  "/asr/status",
  asyncHandler(async (req, res) => {
    res.success(getAsrRuntimeStatus(), "ok");
  })
);

router.put(
  "/config/me",
  asyncHandler(async (req, res) => {
    const output = await updateDBOptimistic((draft) => {
      const saved = aiConfigService.saveMyConfig(draft, req.auth, req.body || {});
      return {
        config: saved,
        effective: aiConfigService.getMyConfig(draft, req.auth).effective,
      };
    });
    res.success(output, "AI配置已保存");
  })
);

router.post(
  "/chat",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const message = String(body.message || "").trim();
    if (!message) throw new HttpError(400, "message不能为空");
    const result = await chat({
      actor: req.auth,
      sessionId: body.sessionId || "",
      message,
      mode: body.mode || "auto",
      thinkingEnabled: body.thinkingEnabled,
      deviceId: body.deviceId || "",
      pageContext: body.pageContext || {},
    });
    res.success(result, "ok");
  })
);

function writeSse(res, event, data = {}) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

router.post("/chat/stream", async (req, res, next) => {
  try {
    const body = req.body || {};
    const message = String(body.message || "").trim();
    if (!message) throw new HttpError(400, "message不能为空");
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    await streamChat({
      actor: req.auth,
      sessionId: body.sessionId || "",
      message,
      mode: body.mode || "auto",
      thinkingEnabled: body.thinkingEnabled,
      deviceId: body.deviceId || "",
      pageContext: body.pageContext || {},
      onEvent: async (event) => {
        writeSse(res, event.type || "message", event);
        if (event.type === "text_delta") {
          writeSse(res, "delta", event);
        }
      },
    });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      writeSse(res, "error", { message: error?.message || "AI流式输出失败" });
      res.end();
      return;
    }
    next(error);
  }
});

router.post(
  "/confirm",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = await confirmAction({
      actor: req.auth,
      sessionId: body.sessionId || "",
      confirmToken: body.confirmToken || "",
      approved: body.approved === true,
    });
    res.success(result, result.status === "success" ? "执行完成" : "ok");
  })
);

router.post(
  "/transcribe",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const asr = await transcribe({
      file: req.file,
      transcript: req.body?.transcript || "",
    });
    if (asr.ok === false) {
      return res.fail(asr.message || "语音转写失败", asr.code === "ASR_NO_AUDIO" ? 400 : 503, asr);
    }
    return res.success(
      {
        transcript: asr.text || "",
        asr,
      },
      asr.text ? "ok" : asr.message || "语音识别未得到文字"
    );
  })
);

router.post(
  "/voice",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const asr = await recognizeVoice({
      file: req.file,
      transcript: req.body?.transcript || "",
    });
    if (!asr.text) {
      return res.success(
        {
          transcript: "",
          asr,
          chat: null,
        },
        asr.message || "语音识别未得到文字"
      );
    }
    const result = await chat({
      actor: req.auth,
      sessionId: req.body?.sessionId || "",
      message: asr.text,
      thinkingEnabled: req.body?.thinkingEnabled,
      pageContext: { source: "miniapp", page: "ai", input: "voice" },
    });
    res.success(
      {
        transcript: asr.text,
        asr,
        chat: result,
      },
      "ok"
    );
  })
);

router.get(
  "/sessions/:sessionId",
  asyncHandler(async (req, res) => {
    const db = await readDB();
    const sessionId = String(req.params.sessionId || "");
    const messages = (db.aiMessages || []).filter((item) => String(item.sessionId || "") === sessionId);
    res.success({ sessionId, messages }, "ok");
  })
);

router.get(
  "/tasks/:taskId",
  asyncHandler(async (req, res) => {
    const task = await getTaskService().get(req.params.taskId);
    if (!task) throw new HttpError(404, "任务不存在");
    res.success(task, "ok");
  })
);

router.post(
  "/tasks/:taskId/cancel",
  asyncHandler(async (req, res) => {
    const task = await getTaskService().cancel(req.params.taskId, "user_cancelled");
    if (!task) throw new HttpError(404, "任务不存在");
    res.success(task, "任务已取消");
  })
);

module.exports = router;
