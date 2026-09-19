const { findDeviceFromState } = require("../../repositories/device.repository");

function ensureDevice(state, actor, deviceId) {
  const device = findDeviceFromState(state, actor, deviceId);
  if (!device) {
    const error = new Error("设备不存在或无权限");
    error.code = "DEVICE_NOT_FOUND";
    throw error;
  }
  return device;
}

module.exports = [
  {
    name: "ink_remote_refresh_page",
    title: "刷新设备页面图片",
    description: "让设备重新获取指定页面的最新渲染图片。",
    riskLevel: "device_action",
    inputSchema: {
      type: "object",
      required: ["deviceId"],
      properties: {
        deviceId: { type: "string" },
        pageType: { type: "string", default: "homepage" },
      },
    },
    handler: async ({ state, params, actor }) => {
      const device = ensureDevice(state, actor, params.deviceId);
      return {
        deviceId: device.id,
        pageType: params.pageType || "homepage",
        queued: true,
      };
    },
  },
  {
    name: "ink_remote_switch_view",
    title: "切换设备显示页面",
    description: "切换设备当前显示页面。",
    riskLevel: "device_action",
    inputSchema: {
      type: "object",
      required: ["deviceId", "view"],
      properties: {
        deviceId: { type: "string" },
        view: { type: "string" },
      },
    },
    handler: async ({ state, params, actor }) => {
      const device = ensureDevice(state, actor, params.deviceId);
      return {
        deviceId: device.id,
        view: params.view || "home",
        queued: true,
      };
    },
  },
];
