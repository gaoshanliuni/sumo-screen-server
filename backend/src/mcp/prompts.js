function listPrompts() {
  return [
    {
      name: "ink_diagnose_device",
      description: "诊断墨水屏设备离线、刷新失败或页面异常",
      arguments: [{ name: "device", description: "设备名称、MAC 或 ID", required: false }],
    },
    {
      name: "ink_generate_nameplate",
      description: "根据会议主题、时间地点生成桌牌内容并规划下发",
      arguments: [{ name: "brief", description: "会议或桌牌需求描述", required: true }],
    },
    {
      name: "ink_dispatch_schedule",
      description: "生成课程表下发计划",
      arguments: [{ name: "target", description: "目标设备或设备组", required: true }],
    },
  ];
}

function getPrompt(name, args = {}) {
  if (name === "ink_diagnose_device") {
    return `请诊断墨水屏设备问题。设备线索：${args.device || "未指定"}。先查询设备，再查看最近日志，任何真实设备操作都要先确认。`;
  }
  if (name === "ink_generate_nameplate") {
    return `请根据下面需求生成桌牌内容和下发计划，先给预览和确认，不要直接执行：${args.brief || ""}`;
  }
  if (name === "ink_dispatch_schedule") {
    return `请为目标 ${args.target || ""} 规划课程表下发，先查询目标设备和课程表，真实下发前必须确认。`;
  }
  return "";
}

module.exports = {
  getPrompt,
  listPrompts,
};
