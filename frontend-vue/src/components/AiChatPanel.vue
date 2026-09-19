<template>
  <div class="ai-chat-shell">
    <header class="ai-chat-titlebar">
      <div class="ai-title-avatar">AI</div>
      <div class="ai-title-main">
        <h3>AI</h3>
        <p>{{ statusText }}</p>
      </div>
      <div class="ai-title-actions">
        <label class="thinking-toggle">
          <span>思考</span>
          <el-switch v-model="thinkingEnabled" :disabled="sending" />
        </label>
        <el-button :icon="Setting" plain @click="$emit('open-settings')">AI设置</el-button>
      </div>
    </header>

    <div ref="messageListRef" class="ai-message-list" aria-live="polite">
      <div v-for="message in messages" :key="message.id" class="ai-message-row" :class="message.role">
        <div v-if="message.role === 'assistant'" class="ai-avatar assistant-avatar">AI</div>
        <div class="ai-message-main">
          <div class="ai-bubble" :class="`${message.role}-bubble`">
            <div v-if="message.streaming && !message.text" class="typing-indicator">
              <span>对方正在输入</span>
              <i></i>
              <i></i>
              <i></i>
            </div>
            <template v-else>{{ message.text }}</template>
          </div>

          <section v-if="message.confirm" class="ai-confirm-card">
            <strong>需要确认</strong>
            <p>{{ message.confirm.reply || "这个操作会影响真实设备，需要你确认。" }}</p>
            <div v-if="message.confirm.plannedActions?.length" class="confirm-actions-preview">
              <span v-for="action in message.confirm.plannedActions" :key="String(action.tool || action.title)">
                {{ action.title || action.tool || "待执行操作" }}
              </span>
            </div>
            <div class="confirm-card-actions">
              <el-button :disabled="sending" @click="respondConfirm(message, false)">取消</el-button>
              <el-button type="primary" :loading="confirming" @click="respondConfirm(message, true)">确认执行</el-button>
            </div>
          </section>

          <div v-if="message.toolCalls?.length" class="tool-call-row">
            <el-tag v-for="tool in message.toolCalls" :key="`${tool.tool || 'tool'}-${tool.status || ''}`" size="small" effect="plain">
              {{ tool.tool || "tool" }} · {{ tool.status || "done" }}
            </el-tag>
          </div>
        </div>
        <div v-if="message.role === 'user'" class="ai-avatar user-avatar">我</div>
      </div>
    </div>

    <footer class="ai-composer">
      <el-input
        v-model="draft"
        class="ai-composer-input"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 4 }"
        resize="none"
        placeholder="输入消息"
        :disabled="sending"
        @keydown.enter.exact.prevent="sendText"
      />
      <el-button v-if="sending" :icon="Close" plain @click="cancelCurrent">停止</el-button>
      <el-button v-else type="primary" :icon="Promotion" :disabled="!canSend" @click="sendText">发送</el-button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Close, Promotion, Setting } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus/es/components/message/index.mjs";
import {
  confirmAiAction,
  sendAiChat,
  type AiChatResponse,
  type AiPlannedAction,
  type AiToolCall,
} from "../services/aiChat";

type ChatRole = "assistant" | "user";
type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  streaming: boolean;
  confirm: AiChatResponse | null;
  toolCalls: AiToolCall[];
};

const props = defineProps<{
  token: string;
  effectiveText?: string;
  initialThinkingEnabled?: boolean;
}>();

defineEmits<{
  (e: "open-settings"): void;
}>();

const draft = ref("");
const sending = ref(false);
const confirming = ref(false);
const thinkingEnabled = ref(Boolean(props.initialThinkingEnabled));
const sessionId = ref("");
const messageListRef = ref<HTMLDivElement | null>(null);
const activeController = ref<AbortController | null>(null);
const currentAssistantMessageId = ref("");

let revealTimer: ReturnType<typeof setTimeout> | null = null;
let resolveRevealTimer: (() => void) | null = null;

function createId(prefix = "msg") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function createMessage(role: ChatRole, text: string, options: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: createId(role),
    role,
    text,
    streaming: false,
    confirm: null,
    toolCalls: [],
    ...options,
  };
}

const messages = ref<ChatMessage[]>([
  createMessage(
    "assistant",
    "你可以让我查询设备、刷新页面、切换显示、生成下发计划。真实影响设备的操作会先让你确认。"
  ),
]);

const canSend = computed(() => Boolean(props.token && draft.value.trim() && !sending.value));
const statusText = computed(() => {
  if (sending.value) return thinkingEnabled.value ? "思考模式 · 正在回复" : "正在回复";
  if (thinkingEnabled.value) return "思考模式";
  return props.effectiveText || "在线";
});

watch(
  () => props.initialThinkingEnabled,
  (value) => {
    thinkingEnabled.value = Boolean(value);
  }
);

function scheduleScrollToBottom() {
  void nextTick(() => {
    const el = messageListRef.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  });
}

function clearRevealTimer() {
  if (revealTimer) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  if (resolveRevealTimer) {
    const resolve = resolveRevealTimer;
    resolveRevealTimer = null;
    resolve();
  }
}

async function revealText(message: ChatMessage, text: string) {
  clearRevealTimer();
  updateMessageById(message.id, (item) => ({ ...item, text: "" }));
  const chars = Array.from(text || "已收到");
  for (let index = 0; index < chars.length; index += 1) {
    const current = messages.value.find((item) => item.id === message.id);
    if (!current?.streaming) break;
    updateMessageById(message.id, (item) => ({ ...item, text: item.text + chars[index] }));
    scheduleScrollToBottom();
    await new Promise<void>((resolve) => {
      resolveRevealTimer = resolve;
      revealTimer = setTimeout(() => {
        revealTimer = null;
        resolveRevealTimer = null;
        resolve();
      }, 12);
    });
  }
  clearRevealTimer();
}

function updateMessageById(messageId: string, updater: (message: ChatMessage) => ChatMessage) {
  messages.value = messages.value.map((message) => (message.id === messageId ? updater(message) : message));
}

function resetStreamingMessages() {
  messages.value = messages.value.map((message) =>
    message.streaming
      ? {
          ...message,
          streaming: false,
          text: message.text || "已停止本次回复。",
        }
      : message
  );
  currentAssistantMessageId.value = "";
  clearRevealTimer();
}

function applyResultPatch(messageId: string, patch: Partial<AiChatResponse>) {
  if (patch.sessionId) sessionId.value = String(patch.sessionId);
  if (Array.isArray(patch.toolCalls)) {
    updateMessageById(messageId, (message) => ({ ...message, toolCalls: patch.toolCalls as AiToolCall[] }));
  }
  if (patch.needConfirm) {
    updateMessageById(messageId, (message) => ({
      ...message,
      confirm: {
        ...message.confirm,
        ...patch,
        reply: String(patch.reply || message.text || "这个操作需要确认。"),
        plannedActions: Array.isArray(patch.plannedActions) ? (patch.plannedActions as AiPlannedAction[]) : [],
      },
    }));
  }
}

async function sendText() {
  const text = draft.value.trim();
  if (!text || sending.value) return;
  if (!props.token) {
    ElMessage.error("请先登录");
    return;
  }

  activeController.value?.abort();
  resetStreamingMessages();
  draft.value = "";
  const userMessage = createMessage("user", text);
  const assistantMessage = createMessage("assistant", "", {
    streaming: true,
  });
  messages.value = [...messages.value, userMessage, assistantMessage];
  scheduleScrollToBottom();

  const controller = new AbortController();
  activeController.value = controller;
  currentAssistantMessageId.value = assistantMessage.id;
  sending.value = true;

  try {
    const result = await sendAiChat(
      props.token,
      {
        sessionId: sessionId.value,
        message: text,
        thinkingEnabled: thinkingEnabled.value,
        pageContext: { source: "web", page: "ai" },
      },
      {
        signal: controller.signal,
        onText(textChunk, mode) {
          updateMessageById(assistantMessage.id, (message) => ({
            ...message,
            text: mode === "replace" ? textChunk : message.text + textChunk,
          }));
          scheduleScrollToBottom();
        },
        onResult(patch) {
          applyResultPatch(assistantMessage.id, patch);
        },
      }
    );

    applyResultPatch(assistantMessage.id, result);
    if (!result.streamed) {
      await revealText(assistantMessage, result.reply || "已收到");
    }
    const finalMessage = messages.value.find((item) => item.id === assistantMessage.id);
    if (!finalMessage?.text) {
      updateMessageById(assistantMessage.id, (message) => ({ ...message, text: "已收到" }));
    }
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      updateMessageById(assistantMessage.id, (message) => ({
        ...message,
        text: message.text || "已停止本次回复。",
      }));
    } else {
      updateMessageById(assistantMessage.id, (message) => ({
        ...message,
        text: (error as Error).message || "AI 请求失败",
      }));
    }
  } finally {
    updateMessageById(assistantMessage.id, (message) => ({ ...message, streaming: false }));
    sending.value = false;
    activeController.value = null;
    currentAssistantMessageId.value = "";
    scheduleScrollToBottom();
  }
}

async function respondConfirm(message: ChatMessage, approved: boolean) {
  if (!message.confirm?.confirmToken || !props.token || confirming.value) return;
  confirming.value = true;
  try {
    const result = await confirmAiAction(props.token, {
      sessionId: message.confirm.sessionId || sessionId.value,
      confirmToken: message.confirm.confirmToken,
      approved,
    });
    message.confirm = null;
    messages.value = [...messages.value, createMessage("assistant", result.message || (approved ? "执行完成" : "已取消本次操作。"))];
    scheduleScrollToBottom();
  } catch (error) {
    ElMessage.error((error as Error).message || "确认操作失败");
  } finally {
    confirming.value = false;
  }
}

function cancelCurrent() {
  activeController.value?.abort();
  if (currentAssistantMessageId.value) {
    updateMessageById(currentAssistantMessageId.value, (message) => ({
      ...message,
      streaming: false,
      text: message.text || "已停止本次回复。",
    }));
  }
  clearRevealTimer();
}

onBeforeUnmount(() => {
  activeController.value?.abort();
  resetStreamingMessages();
  clearRevealTimer();
});
</script>

<style scoped>
.ai-chat-shell {
  min-height: min(760px, calc(100dvh - 170px));
  height: min(760px, calc(100dvh - 170px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  background: #ededed;
}

.ai-chat-titlebar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  background: #f7f7f7;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.ai-title-avatar,
.ai-avatar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 700;
}

.ai-title-avatar {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: #07c160;
  font-size: 13px;
}

.ai-title-main {
  flex: 1;
  min-width: 0;
}

.ai-title-main h3 {
  margin: 0;
  color: #111;
  font-size: 18px;
  line-height: 1.25;
}

.ai-title-main p {
  margin: 3px 0 0;
  color: #6f6f6f;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-title-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #555;
  font-size: 13px;
  white-space: nowrap;
}

.ai-message-list {
  min-height: 0;
  overflow-y: auto;
  padding: 18px 16px 22px;
}

.ai-message-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin-bottom: 15px;
}

.ai-message-row.user {
  justify-content: flex-end;
}

.ai-avatar {
  width: 34px;
  height: 34px;
  margin-top: 1px;
  border-radius: 7px;
  font-size: 12px;
}

.assistant-avatar {
  background: #07c160;
}

.user-avatar {
  background: #576b95;
}

.ai-message-main {
  max-width: min(72%, 780px);
  min-width: 0;
}

.ai-message-row.user .ai-message-main {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.ai-bubble {
  position: relative;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 5px;
  font-size: 15px;
  line-height: 1.58;
  white-space: pre-wrap;
  word-break: break-word;
}

.assistant-bubble {
  background: #fff;
  color: #111;
}

.assistant-bubble::before {
  content: "";
  position: absolute;
  left: -5px;
  top: 12px;
  width: 0;
  height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-right: 6px solid #fff;
}

.user-bubble {
  background: #95ec69;
  color: #111;
}

.user-bubble::after {
  content: "";
  position: absolute;
  right: -5px;
  top: 12px;
  width: 0;
  height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-left: 6px solid #95ec69;
}

.typing-indicator {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #606266;
}

.typing-indicator i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #909399;
  animation: typing-dot 1s infinite ease-in-out;
}

.typing-indicator i:nth-child(3) {
  animation-delay: 0.14s;
}

.typing-indicator i:nth-child(4) {
  animation-delay: 0.28s;
}

.ai-confirm-card {
  margin-top: 9px;
  padding: 12px;
  border-left: 4px solid #fa9d3b;
  border-radius: 7px;
  background: #fff;
  color: #303133;
}

.ai-confirm-card p {
  margin: 6px 0 0;
  color: #606266;
  font-size: 14px;
  line-height: 1.55;
}

.confirm-actions-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.confirm-actions-preview span {
  padding: 3px 8px;
  border-radius: 4px;
  background: #f4f4f5;
  color: #606266;
  font-size: 12px;
}

.confirm-card-actions,
.tool-call-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.ai-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 9px;
  align-items: end;
  padding: 10px 12px;
  background: #f7f7f7;
  border-top: 1px solid rgba(0, 0, 0, 0.1);
}

.ai-composer-input :deep(.el-textarea__inner) {
  min-height: 40px !important;
  border-radius: 5px;
  box-shadow: none;
}

@keyframes typing-dot {
  0%,
  70%,
  100% {
    transform: translateY(0);
    opacity: 0.45;
  }
  35% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

:global(.dark-mode) .ai-chat-shell {
  border-color: #30363d;
  background: #202124;
}

:global(.dark-mode) .ai-message-list {
  background: #202124;
}

:global(.dark-mode) .ai-chat-titlebar,
:global(.dark-mode) .ai-composer {
  background: #1f2328;
  border-color: rgba(255, 255, 255, 0.08);
}

:global(.dark-mode) .ai-title-main h3,
:global(.dark-mode) .assistant-bubble,
:global(.dark-mode) .ai-confirm-card {
  color: #f2f3f5;
}

:global(.dark-mode) .ai-title-main p,
:global(.dark-mode) .thinking-toggle,
:global(.dark-mode) .ai-confirm-card p {
  color: #a7b0ba;
}

:global(.dark-mode) .assistant-bubble,
:global(.dark-mode) .ai-confirm-card {
  background: #2b3036;
}

:global(.dark-mode) .assistant-bubble::before {
  border-right-color: #2b3036;
}

:global(.dark-mode) .user-bubble {
  background: #2f7d45;
  color: #f8fafc;
}

:global(.dark-mode) .user-bubble::after {
  border-left-color: #2f7d45;
}

:global(.dark-mode) .confirm-actions-preview span {
  background: #30363d;
  color: #c9d1d9;
}

:global(.dark-mode) .typing-indicator {
  color: #a7b0ba;
}

:global(.dark-mode) .typing-indicator i {
  background: #8b949e;
}

:global(.dark-mode) .ai-composer-input :deep(.el-textarea__inner) {
  background: #161b22;
  border-color: #30363d;
  color: #e6edf3;
}

@media (max-width: 720px) {
  .ai-chat-shell {
    min-height: calc(100dvh - 150px);
    height: calc(100dvh - 150px);
  }

  .ai-chat-titlebar {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .ai-title-actions {
    width: 100%;
    justify-content: space-between;
  }

  .ai-message-list {
    padding: 14px 10px 18px;
  }

  .ai-message-main {
    max-width: 78%;
  }

  .ai-composer {
    grid-template-columns: 1fr;
  }
}
</style>
