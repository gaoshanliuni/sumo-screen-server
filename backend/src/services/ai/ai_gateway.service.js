const createId = require("../../utils/id");
const { listDevicesFromState, findDeviceByKeyword } = require("../../repositories/device.repository");
const { executeTool } = require("../../tools/executor");
const { ensureAiAllowed } = require("./permission_guard.service");
const { createMemoryCache } = require("../../cache/cache.service");
const { createSessionId, appendAiEvent } = require("./ai_session.service");
const { chatWithDeepSeek, chatWithDeepSeekStream, isDeepSeekConfigured, splitThinkingFromContent } = require("./deepseek_client.service");
const { resolveEffectiveAiConfig } = require("./ai_config.service");

function extractDeviceKeyword(message = "") {
  let text = String(message || "");
  text = text.replace(/刷新|切换|显示|下发|那块屏|设备|屏幕|墨水屏|电子屏|请|帮我|一下|当前/g, " ");
  text = text.replace(/[，。,.!?！？]/g, " ");
  return text.trim().replace(/\s+/g, " ");
}

function inferIntent(message = "") {
  const text = String(message || "");
  if (/刷新|重新获取|更新页面/.test(text)) return "refresh";
  if (/切换.*(主页|桌牌|天气|todo|待办|页面)|切页/.test(text)) return "switch_view";
  if (/离线/.test(text)) return "list_offline";
  if (/在线/.test(text)) return "list_online";
  if (/设备|列表|状态|有哪些/.test(text)) return "list_devices";
  return "chat";
}

function inferView(message = "") {
  const text = String(message || "");
  if (/天气/.test(text)) return "weather";
  if (/桌牌|名牌/.test(text)) return "badge";
  if (/todo|待办/i.test(text)) return "todo";
  return "home";
}

function formatDeviceListReply(page, label = "设备") {
  if (!page.total) return `当前没有匹配的${label}。`;
  const rows = page.rows.map((item, index) => {
    const name = item.displayName || item.remark || item.id;
    return `${index + 1}. ${name}（${item.online ? "在线" : "离线"}）`;
  });
  return `当前有 ${page.total} 台${label}：\n${rows.join("\n")}`;
}

async function emitText(onEvent, text = "", eventType = "text_delta") {
  const value = String(text || "");
  if (!value) return;
  const chunkSize = 48;
  for (let index = 0; index < value.length; index += chunkSize) {
    await onEvent({ type: eventType, text: value.slice(index, index + chunkSize) });
  }
}

function createAiGateway(options = {}) {
  const readState = options.readState;
  const updateState = options.updateState;
  const cache = options.cache || createMemoryCache();
  const injectedDeepSeekStream = options.deepSeekStream || null;
  const checkDeepSeekConfigured = options.isDeepSeekConfigured || isDeepSeekConfigured;

  async function storeConfirm(token, payload) {
    await cache.set(`ai:confirm:${token}`, payload, Number(process.env.AI_CONFIRM_TTL_SECONDS || 600));
  }

  async function loadConfirm(token) {
    return await cache.get(`ai:confirm:${token}`);
  }

  async function chat({ actor, sessionId = "", message = "", pageContext = {}, thinkingEnabled } = {}) {
    ensureAiAllowed(actor);
    const safeSessionId = sessionId || createSessionId();
    const state = await readState();
    const intent = inferIntent(message);

    if (typeof updateState === "function") {
      await updateState((draft) => {
        appendAiEvent(draft, { sessionId: safeSessionId, role: "user", content: String(message || ""), pageContext });
      });
    }

    if (intent === "list_offline" || intent === "list_online" || intent === "list_devices") {
      const params = {
        page: 1,
        pageSize: 20,
        status: intent === "list_offline" ? "offline" : intent === "list_online" ? "online" : "all",
      };
      const result = await executeTool({
        state,
        actor,
        name: "ink_device_list",
        params,
      });
      const reply = result.ok
        ? formatDeviceListReply(result.data, intent === "list_offline" ? "离线设备" : intent === "list_online" ? "在线设备" : "设备")
        : result.message;
      if (typeof updateState === "function") {
        await updateState((draft) => {
          appendAiEvent(draft, { sessionId: safeSessionId, role: "assistant", content: reply });
        });
      }
      return {
        sessionId: safeSessionId,
        reply,
        needConfirm: false,
        toolCalls: [
          {
            tool: "ink_device_list",
            status: result.ok ? "success" : "failed",
            resultSummary: result.ok ? `查询到 ${result.data.total} 台设备` : result.message,
          },
        ],
      };
    }

    if (intent === "refresh" || intent === "switch_view") {
      const keyword = extractDeviceKeyword(message);
      const device = findDeviceByKeyword(state, actor, keyword) || listDevicesFromState(state, { auth: actor, page: 1, pageSize: 1 }).rows[0];
      if (!device) {
        return {
          sessionId: safeSessionId,
          reply: "没有找到可操作的设备，请先说明设备名称或确认设备已绑定。",
          needConfirm: false,
          toolCalls: [],
        };
      }
      const action =
        intent === "refresh"
          ? {
              tool: "ink_remote_refresh_page",
              title: "刷新设备页面",
              riskLevel: "device_action",
              params: { deviceId: device.id, pageType: "homepage" },
            }
          : {
              tool: "ink_remote_switch_view",
              title: "切换设备页面",
              riskLevel: "device_action",
              params: { deviceId: device.id, view: inferView(message) },
            };
      const confirmToken = createId("confirm");
      await storeConfirm(confirmToken, {
        sessionId: safeSessionId,
        actor,
        plannedActions: [action],
        createdAt: new Date().toISOString(),
      });
      const reply = `我可以对「${device.displayName || device.remark || device.id}」执行「${action.title}」。这个操作会影响真实设备，需要你确认。`;
      if (typeof updateState === "function") {
        await updateState((draft) => {
          appendAiEvent(draft, { sessionId: safeSessionId, role: "assistant", content: reply, needConfirm: true });
        });
      }
      return {
        sessionId: safeSessionId,
        reply,
        needConfirm: true,
        confirmToken,
        plannedActions: [action],
      };
    }

    const effectiveAiConfig = {
      ...resolveEffectiveAiConfig(state, actor),
      ...(thinkingEnabled === undefined ? {} : { thinkingEnabled: thinkingEnabled === true }),
    };
    if (checkDeepSeekConfigured(effectiveAiConfig)) {
      try {
        const reply = await chatWithDeepSeek([
          {
            role: "system",
            content:
              "你是墨水屏管理系统的 AI 助手。查询、修改和设备操作必须通过后端工具；真实设备操作需要用户确认。回答要简洁，适合小程序聊天界面。",
          },
          { role: "user", content: String(message || "") },
        ], effectiveAiConfig);
        return {
          sessionId: safeSessionId,
          reply: reply || "我已理解，请补充设备或动作。",
          needConfirm: false,
          toolCalls: [],
        };
      } catch (error) {
        return {
          sessionId: safeSessionId,
          reply: `DeepSeek 调用失败：${error?.message || "请检查 AI 配置"}`,
          needConfirm: false,
          toolCalls: [],
        };
      }
    }

    return {
      sessionId: safeSessionId,
      reply: "我可以帮你查询设备、生成操作计划、刷新或切换设备页面。请补充设备名称和具体动作。",
      needConfirm: false,
      toolCalls: [],
    };
  }

  async function runDeepSeekStream(messages, effectiveAiConfig, onEvent) {
    let content = "";
    let thinking = "";
    if (typeof injectedDeepSeekStream === "function") {
      for await (const event of injectedDeepSeekStream(messages, effectiveAiConfig)) {
        if (event.type === "thinking_delta" || event.type === "thinking") {
          const text = event.content || event.text || "";
          thinking += text;
          await onEvent({ type: "thinking_delta", content: text, text });
        } else if (event.type === "text_delta" || event.type === "delta") {
          const text = event.content || event.text || "";
          content += text;
          await onEvent({ type: "text_delta", content: text, text });
        }
      }
      return { content, thinking };
    }

    const final = await chatWithDeepSeekStream(messages, effectiveAiConfig, async (event) => {
      if (event.type === "thinking") {
        const text = event.text || "";
        thinking += text;
        await onEvent({ type: "thinking_delta", content: text, text });
      } else if (event.type === "delta") {
        const text = event.text || "";
        content += text;
        await onEvent({ type: "text_delta", content: text, text });
      }
    });
    return {
      content: final.content || content,
      thinking: final.thinking || thinking,
    };
  }

  async function streamChat({ actor, sessionId = "", message = "", pageContext = {}, thinkingEnabled, onEvent = async () => {} } = {}) {
    ensureAiAllowed(actor);
    const safeSessionId = sessionId || createSessionId();
    const safeMessage = String(message || "");
    await onEvent({ type: "typing", typing: true, sessionId: safeSessionId });
    await onEvent({ type: "session", sessionId: safeSessionId });

    const state = await readState();
    const intent = inferIntent(safeMessage);

    if (intent === "chat") {
      const effectiveAiConfig = {
        ...resolveEffectiveAiConfig(state, actor),
        ...(thinkingEnabled === undefined ? {} : { thinkingEnabled: thinkingEnabled === true }),
      };
      if (checkDeepSeekConfigured(effectiveAiConfig)) {
        if (typeof updateState === "function") {
          await updateState((draft) => {
            appendAiEvent(draft, { sessionId: safeSessionId, role: "user", content: safeMessage, pageContext });
          });
        }
        let final = { content: "", thinking: "" };
        try {
          final = await runDeepSeekStream(
            [
              {
                role: "system",
                content:
                  "你是墨水屏管理系统的 AI 助手。查询、修改和设备操作必须通过后端工具；真实设备操作需要用户确认。回答要简洁，适合小程序聊天界面。",
              },
              { role: "user", content: safeMessage },
            ],
            effectiveAiConfig,
            onEvent
          );
        } catch (error) {
          final = { content: `DeepSeek 调用失败：${error?.message || "请检查 AI 配置"}`, thinking: "" };
          await emitText(onEvent, final.content);
        }
        const reply = final.content || "我已理解，请补充设备或动作。";
        if (typeof updateState === "function") {
          await updateState((draft) => {
            appendAiEvent(draft, { sessionId: safeSessionId, role: "assistant", content: reply, thinking: final.thinking || "" });
          });
        }
        await onEvent({ type: "done", sessionId: safeSessionId, reply, thinking: final.thinking || "", needConfirm: false, toolCalls: [] });
        return { sessionId: safeSessionId, reply, thinking: final.thinking || "", needConfirm: false, toolCalls: [] };
      }
    }

    const result = await chat({ actor, sessionId: safeSessionId, message: safeMessage, pageContext, thinkingEnabled });
    const split = splitThinkingFromContent(result.reply || "");
    if (split.thinking) {
      await emitText(onEvent, split.thinking, "thinking_delta");
    }
    await emitText(onEvent, split.content || result.reply || "");
    await onEvent({
      type: "done",
      sessionId: result.sessionId || safeSessionId,
      reply: split.content || result.reply || "",
      thinking: thinkingEnabled === true ? split.thinking : "",
      needConfirm: Boolean(result.needConfirm),
      confirmToken: result.confirmToken || "",
      plannedActions: result.plannedActions || [],
      toolCalls: result.toolCalls || [],
    });
    return result;
  }

  async function* chatStream(params = {}) {
    const queue = [];
    let finished = false;
    let failure = null;
    let wake = null;
    const notify = () => {
      if (wake) {
        wake();
        wake = null;
      }
    };

    streamChat({
      ...params,
      onEvent: async (event) => {
        queue.push(event);
        notify();
      },
    })
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        finished = true;
        notify();
      });

    while (!finished || queue.length) {
      if (queue.length) {
        yield queue.shift();
      } else {
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    }
    if (failure) throw failure;
  }

  async function confirm({ actor, sessionId = "", confirmToken = "", approved = false } = {}) {
    ensureAiAllowed(actor);
    const payload = await loadConfirm(confirmToken);
    if (!payload || (sessionId && payload.sessionId !== sessionId)) {
      return { status: "expired", message: "确认已过期，请重新发起操作" };
    }
    if (!approved) {
      await cache.del(`ai:confirm:${confirmToken}`);
      return { status: "cancelled", message: "已取消执行" };
    }

    const state = await readState();
    const results = [];
    for (const action of payload.plannedActions || []) {
      const result = await executeTool({
        state,
        actor,
        name: action.tool,
        params: action.params,
        confirm: true,
        dryRun: false,
        updateState,
        reason: "ai_confirm",
      });
      results.push(result);
    }
    await cache.del(`ai:confirm:${confirmToken}`);
    return {
      status: results.every((item) => item.ok) ? "success" : "failed",
      results,
      message: results.every((item) => item.ok) ? "执行完成" : "部分操作执行失败",
    };
  }

  return {
    chat,
    streamChat,
    chatStream,
    confirm,
  };
}

const defaultGateway = createAiGateway({
  readState: async () => require("../../db/store").readDB(),
  updateState: async (mutator) => require("../../db/store").updateDBOptimistic(mutator),
});

module.exports = {
  createAiGateway,
  chat: (...args) => defaultGateway.chat(...args),
  streamChat: (...args) => defaultGateway.streamChat(...args),
  chatStream: (...args) => defaultGateway.chatStream(...args),
  confirmAction: (...args) => defaultGateway.confirm(...args),
};
