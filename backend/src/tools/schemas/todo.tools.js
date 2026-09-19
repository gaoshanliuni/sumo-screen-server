const createId = require("../../utils/id");
const { getVisibleDevices } = require("../../repositories/device.repository");

module.exports = [
  {
    name: "ink_todo_list",
    title: "查询待办",
    description: "查询当前用户可见设备的待办事项。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        done: { type: "boolean" },
      },
    },
    handler: async ({ state, params, actor }) => {
      const visible = new Set(getVisibleDevices(state, actor).map((item) => item.id));
      let rows = (state.todos || []).filter((item) => visible.has(item.deviceId));
      if (params.deviceId) rows = rows.filter((item) => String(item.deviceId || "") === String(params.deviceId || ""));
      if (params.done !== undefined) rows = rows.filter((item) => Boolean(item.done) === Boolean(params.done));
      return rows;
    },
  },
  {
    name: "ink_todo_upsert",
    title: "新增或修改待办",
    description: "新增或修改单条设备待办。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["deviceId", "content"],
      properties: {
        id: { type: "string" },
        deviceId: { type: "string" },
        content: { type: "string" },
        done: { type: "boolean" },
      },
    },
    handler: async ({ state, params, actor, updateState }) => {
      const visible = new Set(getVisibleDevices(state, actor).map((item) => item.id));
      if (!visible.has(params.deviceId)) throw new Error("设备不存在或无权限");
      let saved = null;
      await updateState((draft) => {
        const now = new Date().toISOString();
        const rows = Array.isArray(draft.todos) ? draft.todos : (draft.todos = []);
        const existing = params.id ? rows.find((item) => item.id === params.id && item.deviceId === params.deviceId) : null;
        if (existing) {
          existing.content = String(params.content || existing.content || "");
          existing.done = params.done === undefined ? Boolean(existing.done) : Boolean(params.done);
          existing.updatedAt = now;
          saved = existing;
        } else {
          saved = {
            id: createId("todo"),
            deviceId: params.deviceId,
            content: String(params.content || ""),
            done: Boolean(params.done),
            createdAt: now,
            updatedAt: now,
          };
          rows.push(saved);
        }
      });
      return saved;
    },
  },
];
