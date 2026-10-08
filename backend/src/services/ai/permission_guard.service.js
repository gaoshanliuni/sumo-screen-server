function canUseAi(actor = {}) {
  return ["admin", "user"].includes(actor.role);
}

function ensureAiAllowed(actor = {}) {
  if (!canUseAi(actor)) {
    const error = new Error("当前账号无权使用 AI 助手");
    error.status = 403;
    throw error;
  }
}

module.exports = {
  canUseAi,
  ensureAiAllowed,
};
