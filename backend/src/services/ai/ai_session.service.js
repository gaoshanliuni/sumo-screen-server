const createId = require("../../utils/id");

function createSessionId() {
  return createId("ai_sess");
}

function appendAiEvent(state = {}, event = {}) {
  state.aiMessages = Array.isArray(state.aiMessages) ? state.aiMessages : [];
  state.aiMessages.push({
    id: createId("aimsg"),
    ...event,
    createdAt: event.createdAt || new Date().toISOString(),
  });
  if (state.aiMessages.length > 2000) state.aiMessages = state.aiMessages.slice(-2000);
}

module.exports = {
  appendAiEvent,
  createSessionId,
};
