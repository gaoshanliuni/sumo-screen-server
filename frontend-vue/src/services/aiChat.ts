import { apiRequest, type ApiResponse } from "./api";

export type AiChatRequest = {
  sessionId?: string;
  message: string;
  mode?: string;
  thinkingEnabled?: boolean;
  deviceId?: string;
  pageContext?: Record<string, unknown>;
};

export type AiToolCall = {
  tool?: string;
  status?: string;
  resultSummary?: string;
  [key: string]: unknown;
};

export type AiPlannedAction = {
  tool?: string;
  title?: string;
  riskLevel?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
};

export type AiChatResponse = {
  sessionId?: string;
  reply?: string;
  thinking?: string;
  needConfirm?: boolean;
  confirmToken?: string;
  plannedActions?: AiPlannedAction[];
  toolCalls?: AiToolCall[];
  [key: string]: unknown;
};

export type StreamUpdateMode = "append" | "replace";

export type AiChatStreamHandlers = {
  signal?: AbortSignal;
  onText?: (text: string, mode: StreamUpdateMode) => void;
  onResult?: (result: Partial<AiChatResponse>) => void;
};

export type AiChatSendResult = AiChatResponse & {
  streamed: boolean;
};

export type AiConfirmResponse = {
  status?: string;
  message?: string;
  results?: unknown[];
};

type NormalizedStreamEvent = {
  type: string;
  textDelta: string;
  fullText: string;
  updateMode: StreamUpdateMode | "none";
  result: Partial<AiChatResponse>;
  done: boolean;
};

type StreamState = {
  text: string;
  result: Partial<AiChatResponse>;
  emitted: boolean;
  lastRawData: string;
};

type ParsedStreamBlock = {
  eventName: string;
  raw: string;
};

class StreamFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamFallbackError";
  }
}

function authHeaders(token: string) {
  const headers = new Headers();
  headers.set("Accept", "text/event-stream, application/x-ndjson, application/json");
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function unwrapApiPayload(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "code" in payload && "data" in payload) {
    const wrapped = payload as ApiResponse<unknown>;
    if (Number(wrapped.code) >= 400) {
      throw new Error(wrapped.msg || "AI 请求失败");
    }
    return wrapped.data;
  }
  return payload;
}

function parseJsonMaybe(raw: string): unknown {
  const text = raw.trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function pickString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = pickString(value);
    if (text) return text;
  }
  return "";
}

function stripHiddenMarkup(value: string): string {
  return String(value || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function safeEventRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function stripHiddenFields(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripHiddenFields);

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (lower.includes("reasoning") || lower.includes("think")) continue;
    output[key] = stripHiddenFields(item);
  }
  return output;
}

function resultPatchFrom(source: Partial<AiChatResponse>): Partial<AiChatResponse> {
  const clean = stripHiddenFields(source) as Partial<AiChatResponse>;
  const resultPatch: Partial<AiChatResponse> = {};
  if (pickString(clean.sessionId)) resultPatch.sessionId = pickString(clean.sessionId);
  if (pickString(clean.reply)) resultPatch.reply = stripHiddenMarkup(pickString(clean.reply));
  if (typeof clean.needConfirm === "boolean") resultPatch.needConfirm = clean.needConfirm;
  if (pickString(clean.confirmToken)) resultPatch.confirmToken = pickString(clean.confirmToken);
  if (Array.isArray(clean.plannedActions)) resultPatch.plannedActions = clean.plannedActions;
  if (Array.isArray(clean.toolCalls)) resultPatch.toolCalls = clean.toolCalls;
  return resultPatch;
}

function normalizeStreamEvent(payload: unknown, eventName = ""): NormalizedStreamEvent {
  const data = unwrapApiPayload(payload);
  if (typeof data === "string") {
    return {
      type: eventName || "text",
      textDelta: data,
      fullText: "",
      updateMode: "append",
      result: {},
      done: false,
    };
  }
  if (!data || typeof data !== "object") {
    return {
      type: eventName || "empty",
      textDelta: "",
      fullText: "",
      updateMode: "none",
      result: {},
      done: false,
    };
  }

  const event = safeEventRecord(data);
  const nested = safeEventRecord(event.data);
  const type = String(event.type || event.event || nested.type || eventName || "").toLowerCase();
  const done =
    event.done === true ||
    nested.done === true ||
    ["done", "final", "complete", "completed", "end"].includes(type);

  if (type.includes("reasoning") || type.includes("think")) {
    return {
      type,
      textDelta: "",
      fullText: "",
      updateMode: "none",
      result: resultPatchFrom(event as Partial<AiChatResponse>),
      done,
    };
  }

  const textDelta = firstText(
    event.delta?.content ??
      event.delta?.text ??
      (typeof event.delta === "string" ? event.delta : ""),
    event.contentDelta,
    event.textDelta,
    event.token,
    nested.delta?.content,
    nested.delta?.text,
    typeof nested.delta === "string" ? nested.delta : "",
    nested.contentDelta,
    nested.textDelta,
    nested.token
  );

  const fullText = stripHiddenMarkup(firstText(
    event.fullText,
    event.full_text,
    nested.fullText,
    nested.full_text,
    done ? event.reply : "",
    done ? nested.reply : "",
    done ? event.content : "",
    done ? event.text : "",
    done ? nested.content : "",
    done ? nested.text : ""
  ));

  const finalResult = event.result || event.final || event.message || nested.result || null;
  const resultSource = (finalResult && typeof finalResult === "object" ? finalResult : event) as Partial<AiChatResponse>;
  const result = resultPatchFrom(resultSource);
  const updateMode: StreamUpdateMode | "none" = fullText ? "replace" : textDelta ? "append" : "none";

  return {
    type,
    textDelta,
    fullText,
    updateMode,
    result,
    done,
  };
}

function applyStreamEvent(
  payload: unknown,
  eventName: string,
  raw: string,
  state: StreamState,
  handlers: AiChatStreamHandlers
) {
  console.debug("[ai-stream] raw chunk", raw);
  if (raw && raw === state.lastRawData && eventName === "delta") {
    console.debug("[ai-stream] event", { type: "duplicate", updateMode: "none", eventName });
    return false;
  }
  if (raw) state.lastRawData = raw;

  const event = normalizeStreamEvent(payload, eventName);
  console.debug("[ai-stream] event", { type: event.type, updateMode: event.updateMode, eventName });

  if (event.updateMode === "append" && event.textDelta) {
    state.text += event.textDelta;
    state.emitted = true;
    handlers.onText?.(event.textDelta, "append");
  } else if (event.updateMode === "replace" && event.fullText) {
    state.text = event.fullText;
    state.emitted = true;
    handlers.onText?.(event.fullText, "replace");
  }

  if (Object.keys(event.result).length) {
    state.result = { ...state.result, ...event.result };
    handlers.onResult?.(event.result);
  }
  return event.done;
}

function parseEventBlock(block: string): ParsedStreamBlock {
  const lines = block.split(/\r?\n/);
  const dataLines: string[] = [];
  let eventName = "";
  for (const line of lines) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    if (!line.includes(":") && line.trim()) dataLines.push(line.trim());
  }
  return { eventName, raw: dataLines.join("\n").trim() };
}

async function readStreamResponse(response: Response, handlers: AiChatStreamHandlers): Promise<AiChatSendResult> {
  if (!response.body) {
    throw new StreamFallbackError("当前浏览器不支持读取流式响应");
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = unwrapApiPayload(await response.json());
    const event = normalizeStreamEvent(payload, "json");
    return {
      ...event.result,
      reply: event.fullText || event.result.reply || event.textDelta,
      streamed: false,
    };
  }

  const isNdjson = contentType.includes("application/x-ndjson");
  if (!contentType.includes("text/event-stream") && !isNdjson) {
    throw new StreamFallbackError("后端暂未提供事件流响应");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const state: StreamState = { text: "", result: {}, emitted: false, lastRawData: "" };
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const blocks = isNdjson ? buffer.split(/\r?\n/) : buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const parsed = isNdjson ? { eventName: "message", raw: block.trim() } : parseEventBlock(block);
      if (!parsed.raw || parsed.raw === "[DONE]") continue;
      const doneEvent = applyStreamEvent(parseJsonMaybe(parsed.raw), parsed.eventName, parsed.raw, state, handlers);
      if (doneEvent) {
        await reader.cancel().catch(() => undefined);
        return buildStreamResult(state);
      }
    }
  }

  const tail = isNdjson ? { eventName: "message", raw: buffer.trim() } : parseEventBlock(buffer);
  if (tail.raw && tail.raw !== "[DONE]") {
    applyStreamEvent(parseJsonMaybe(tail.raw), tail.eventName, tail.raw, state, handlers);
  }
  if (!state.emitted && !Object.keys(state.result).length) {
    throw new StreamFallbackError("流式响应没有返回内容");
  }
  return buildStreamResult(state);
}

function buildStreamResult(state: StreamState): AiChatSendResult {
  return {
    ...state.result,
    reply: state.text || state.result.reply || "",
    streamed: true,
  };
}

async function sendAiChatStream(token: string, payload: AiChatRequest, handlers: AiChatStreamHandlers = {}) {
  const response = await fetch("/api/ai/chat/stream", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload),
    signal: handlers.signal,
  });

  if (!response.ok) {
    throw new StreamFallbackError(`流式接口不可用 (${response.status})`);
  }
  return await readStreamResponse(response, handlers);
}

async function sendAiChatFallback(token: string, payload: AiChatRequest): Promise<AiChatSendResult> {
  const result = await apiRequest<AiChatResponse>("/api/ai/chat", {
    method: "POST",
    token,
    timeoutMs: 60000,
    body: JSON.stringify(payload),
  });
  const clean = resultPatchFrom(result);
  return { ...clean, reply: clean.reply || result.reply || "", streamed: false };
}

export async function sendAiChat(token: string, payload: AiChatRequest, handlers: AiChatStreamHandlers = {}) {
  try {
    return await sendAiChatStream(token, payload, handlers);
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    if (!(error instanceof StreamFallbackError)) throw error;
    return await sendAiChatFallback(token, payload);
  }
}

export async function confirmAiAction(
  token: string,
  payload: { sessionId?: string; confirmToken: string; approved: boolean }
) {
  return apiRequest<AiConfirmResponse>("/api/ai/confirm", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}
