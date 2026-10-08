const { buildOverviewFromState } = require("../../repositories/dashboard.repository");
const { summarizeDevicesFromState } = require("../../repositories/device.repository");

module.exports = [
  {
    name: "ink_overview_get",
    title: "查询系统概览",
    description: "查询设备统计、最近操作、待办和课程表概览。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["all", "online", "offline", "pending"] },
        keyword: { type: "string" },
      },
    },
    handler: async ({ state, params, actor }) => buildOverviewFromState(state, actor, params || {}),
  },
  {
    name: "ink_dashboard_summary",
    title: "查询首页统计",
    description: "查询当前用户可见设备总数、在线数、离线数和待绑定数。",
    riskLevel: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async ({ state, actor }) => summarizeDevicesFromState(state, actor),
  },
];
