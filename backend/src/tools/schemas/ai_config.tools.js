const { createAiConfigService } = require("../../services/ai/ai_config.service");

const aiConfigService = createAiConfigService();

module.exports = [
  {
    name: "ink_ai_config_get",
    title: "查询我的 AI 配置",
    description: "查询当前用户自己的 AI 配置和最终生效配置。调用建议：AI 回复超时、模型不可用或用户问当前模型/API Key 状态时先调用它。",
    riskLevel: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async ({ state, actor }) => aiConfigService.getMyConfig(state, actor),
  },
  {
    name: "ink_ai_config_save",
    title: "保存我的 AI 配置",
    description: "保存当前用户的 DeepSeek 接入配置。调用建议：只在用户明确要求修改模型、接入 URL、启用状态或思考模式时使用；API Key 属于敏感信息，执行前必须确认。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "配置名称，例如 我的 DeepSeek。" },
        provider: { type: "string", enum: ["deepseek"], description: "当前仅支持 deepseek。" },
        baseUrl: { type: "string", description: "DeepSeek 兼容 API 地址，例如 https://api.deepseek.com。" },
        model: { type: "string", description: "模型名，例如 deepseek-chat；思考模式开启且模型为 deepseek-chat 时会调用 deepseek-reasoner。" },
        apiKey: { type: "string", description: "新的 API Key；留空则保留旧密钥。" },
        enabled: { type: "boolean", description: "是否启用 AI。" },
        thinkingEnabled: { type: "boolean", description: "是否启用思考模式。" },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ params, actor, updateState }) => {
      if (typeof updateState !== "function") throw new Error("updateState unavailable");
      let output = null;
      await updateState((draft) => {
        const saved = aiConfigService.saveMyConfig(draft, actor, params || {});
        output = {
          config: saved,
          effective: aiConfigService.getMyConfig(draft, actor).effective,
        };
      });
      return output;
    },
  },
];
