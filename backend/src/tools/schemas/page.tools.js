function getPageCollection(pageType = "homepage") {
  const type = String(pageType || "homepage").toLowerCase();
  if (type === "badgepage" || type === "nameplate") return "badgepageConfigs";
  if (type === "weatherpage") return "weatherpageConfigs";
  return "homepageConfigs";
}

module.exports = [
  {
    name: "ink_page_get_config",
    title: "获取页面配置",
    description: "获取主页、桌牌页或天气页的设备配置。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        pageType: { type: "string", default: "homepage" },
      },
    },
    handler: async ({ state, params }) => {
      const collection = getPageCollection(params.pageType);
      const rows = Array.isArray(state[collection]) ? state[collection] : [];
      if (!params.deviceId) return rows;
      return rows.find((item) => String(item.deviceId || "") === String(params.deviceId || "")) || null;
    },
  },
  {
    name: "ink_page_render_preview",
    title: "渲染页面预览",
    description: "生成页面预览任务。真实渲染仍由现有页面渲染接口执行。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        pageType: { type: "string", default: "homepage" },
      },
    },
    handler: async ({ params }) => ({
      pageType: params.pageType || "homepage",
      deviceId: params.deviceId || "",
      preview: null,
      message: "请调用现有页面 render 接口生成真实预览图",
    }),
  },
  {
    name: "ink_page_render_and_push",
    title: "渲染并下发页面",
    description: "渲染页面并下发到设备。",
    riskLevel: "device_action",
    inputSchema: {
      type: "object",
      required: ["deviceId"],
      properties: {
        deviceId: { type: "string" },
        pageType: { type: "string", default: "homepage" },
      },
    },
    handler: async ({ params }) => ({
      pageType: params.pageType || "homepage",
      deviceId: params.deviceId,
      queued: true,
    }),
  },
];
