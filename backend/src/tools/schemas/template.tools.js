module.exports = [
  {
    name: "ink_template_list",
    title: "查询 API 模板",
    description: "查询当前可用 API 模板列表。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async ({ state, actor }) => {
      const rows = Array.isArray(state.apiTemplates) ? state.apiTemplates : [];
      if (actor.role === "admin") return rows;
      return rows.filter((item) => item.enabled !== false);
    },
  },
  {
    name: "ink_template_refresh_now",
    title: "立即刷新 API 模板缓存",
    description: "触发设备 API 模板缓存刷新。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["deviceId", "slug"],
      properties: {
        deviceId: { type: "string" },
        slug: { type: "string" },
      },
    },
    handler: async ({ params }) => ({
      deviceId: params.deviceId,
      slug: params.slug,
      queued: true,
    }),
  },
];
