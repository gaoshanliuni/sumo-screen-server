const { listDevicesFromState, findDeviceFromState } = require("../../repositories/device.repository");

module.exports = [
  {
    name: "ink_device_list",
    title: "查询设备列表",
    description: "按状态、在线状态、关键词和分页查询当前用户可见的墨水屏设备。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["all", "online", "offline", "pending", "enabled", "blocked"] },
        keyword: { type: "string" },
        page: { type: "integer", minimum: 1, default: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    handler: async ({ state, params, actor }) => {
      const status = params.status === "all" ? "" : params.status;
      return listDevicesFromState(state, { ...params, status, auth: actor });
    },
  },
  {
    name: "ink_device_get",
    title: "查询设备详情",
    description: "查询当前用户可见的单个设备详情。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      required: ["deviceId"],
      properties: {
        deviceId: { type: "string" },
      },
    },
    handler: async ({ state, params, actor }) => {
      const device = findDeviceFromState(state, actor, params.deviceId);
      if (!device) {
        const error = new Error("设备不存在或无权限");
        error.code = "DEVICE_NOT_FOUND";
        throw error;
      }
      return device;
    },
  },
  {
    name: "ink_device_update",
    title: "修改设备基础信息",
    description: "修改设备名称、备注、默认页面、状态和归属用户。调用建议：普通用户只能修改自己的 displayName/remark/defaultView；管理员可修改 status/ownerId 以绑定或转移设备。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["deviceId"],
      properties: {
        deviceId: { type: "string" },
        displayName: { type: "string" },
        remark: { type: "string" },
        defaultView: { type: "string" },
        status: { type: "string", enum: ["enabled", "blocked"] },
        ownerId: { type: "string", description: "管理员可用：把设备归属到指定用户；传空字符串可解绑。" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const device = findDeviceFromState(state, actor, params.deviceId);
      if (!device) {
        const error = new Error("设备不存在或无权限");
        error.code = "DEVICE_NOT_FOUND";
        throw error;
      }
      const allowed = actor.role === "admin"
        ? ["displayName", "remark", "defaultView", "status", "ownerId"]
        : ["displayName", "remark", "defaultView"];
      let updated = null;
      if (typeof updateState === "function") {
        await updateState((draft) => {
          const row = (draft.devices || []).find((item) => String(item.id || "") === String(device.id || ""));
          if (!row) return;
          allowed.forEach((key) => {
            if (params[key] !== undefined) row[key] = String(params[key] || "");
          });
          if (actor.role === "admin" && params.ownerId !== undefined) {
            row.bindState = row.ownerId ? "bound" : "pending";
            row.boundAt = row.ownerId ? row.boundAt || new Date().toISOString() : "";
            row.boundBy = row.ownerId ? String(actor.userId || "") : "";
          }
          row.updatedAt = new Date().toISOString();
          updated = row;
        });
      }
      return updated || { ...device, ...params };
    },
  },
];
