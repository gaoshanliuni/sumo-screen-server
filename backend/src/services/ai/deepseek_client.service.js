const axios = require("axios");
const config = require("../../config");

function splitThinkingFromContent(value = "") {
  const text = String(value || "");
  const match = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (!match) return { thinking: "", content: text };
  return {
    thinking: String(match[1] || "").trim(),
    content: `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim(),
  };
}

function isDeepSeekConfigured(options = null) {
  if (options && typeof options === "object") {
    return Boolean(options.enabled !== false && options.apiKey);
  }
  return Boolean(config.ai?.enabled && config.ai?.deepseekApiKey);
}

async function chatWithDeepSeek(messages = [], options = {}) {
  if (!isDeepSeekConfigured(options)) {
    const error = new Error("DeepSeek 未配置");
    error.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw error;
  }
  const baseUrl = String(options.baseUrl || config.ai.deepseekBaseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const configuredModel = String(options.model || config.ai.deepseekModel || "deepseek-chat").trim() || "deepseek-chat";
  const model = options.thinkingEnabled === true && configuredModel === "deepseek-chat"
    ? "deepseek-reasoner"
    : configuredModel;
  const resp = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages,
      temperature: options.temperature ?? 0.2,
    },
    {
      timeout: Number(config.ai.timeoutMs || 20000),
      headers: {
        Authorization: `Bearer ${options.apiKey || config.ai.deepseekApiKey}`,
        "Content-Type": "application/json",
      },
    }
  );
  return resp.data?.choices?.[0]?.message?.content || "";
}

async function chatWithDeepSeekStream(messages = [], options = {}, onEvent = async () => {}) {
  if (!isDeepSeekConfigured(options)) {
    const error = new Error("DeepSeek 未配置");
    error.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw error;
  }
  const baseUrl = String(options.baseUrl || config.ai.deepseekBaseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const configuredModel = String(options.model || config.ai.deepseekModel || "deepseek-chat").trim() || "deepseek-chat";
  const model = options.thinkingEnabled === true && configuredModel === "deepseek-chat"
    ? "deepseek-reasoner"
    : configuredModel;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.ai.timeoutMs || 20000));
  let content = "";
  let thinking = "";
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${options.apiKey || config.ai.deepseekApiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.2,
        stream: true,
      }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `DeepSeek stream failed: HTTP ${response.status}`);
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const raw = trimmed.slice(5).trim();
        if (raw === "[DONE]") continue;
        let payload = null;
        try {
          payload = JSON.parse(raw);
        } catch (_) {
          continue;
        }
        const delta = payload?.choices?.[0]?.delta || {};
        const reasoning = String(delta.reasoning_content || delta.reasoningContent || "");
        if (reasoning) {
          thinking += reasoning;
          await onEvent({ type: "thinking", text: reasoning });
        }
        const piece = String(delta.content || "");
        if (piece) {
          content += piece;
          const split = splitThinkingFromContent(piece);
          if (split.thinking) {
            thinking += split.thinking;
            await onEvent({ type: "thinking", text: split.thinking });
          }
          if (split.content) {
            await onEvent({ type: "delta", text: split.content });
          }
        }
      }
    }
    const finalSplit = splitThinkingFromContent(content);
    if (!thinking && finalSplit.thinking) thinking = finalSplit.thinking;
    return {
      content: finalSplit.content || content,
      thinking,
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  chatWithDeepSeek,
  chatWithDeepSeekStream,
  isDeepSeekConfigured,
  splitThinkingFromContent,
};
