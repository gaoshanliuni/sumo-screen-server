const { getVisibleDevices } = require("../../repositories/device.repository");

module.exports = [
  {
    name: "ink_schedule_list",
    title: "查询课程表",
    description: "查询当前用户可见设备的课程表。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
      },
    },
    handler: async ({ state, params, actor }) => {
      const visible = new Set(getVisibleDevices(state, actor).map((item) => item.id));
      let rows = (state.schedules || []).filter((item) => visible.has(item.deviceId));
      if (params.deviceId) rows = rows.filter((item) => String(item.deviceId || "") === String(params.deviceId || ""));
      return rows;
    },
  },
];
