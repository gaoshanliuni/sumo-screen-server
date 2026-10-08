module.exports = [
  {
    name: "ink_firmware_list",
    title: "查询固件库",
    description: "查询固件库版本和标签。",
    riskLevel: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async ({ state }) => (Array.isArray(state.firmwares) ? state.firmwares : []),
  },
  {
    name: "ink_firmware_upgrade",
    title: "固件升级",
    description: "为设备创建固件升级任务。",
    riskLevel: "upgrade",
    inputSchema: {
      type: "object",
      required: ["deviceId", "firmwareId"],
      properties: {
        deviceId: { type: "string" },
        firmwareId: { type: "string" },
      },
    },
    handler: async ({ params }) => ({
      deviceId: params.deviceId,
      firmwareId: params.firmwareId,
      queued: true,
    }),
  },
];
