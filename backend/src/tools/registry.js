const deviceTools = require("./schemas/device.tools");
const overviewTools = require("./schemas/overview.tools");
const remoteTools = require("./schemas/remote.tools");
const pageTools = require("./schemas/page.tools");
const todoTools = require("./schemas/todo.tools");
const scheduleTools = require("./schemas/schedule.tools");
const templateTools = require("./schemas/template.tools");
const firmwareTools = require("./schemas/firmware.tools");
const collectionTools = require("./schemas/collection.tools");
const albumTools = require("./schemas/album.tools");
const aiConfigTools = require("./schemas/ai_config.tools");
const extendedTools = require("./schemas/extended.tools");
const adminOpsTools = require("./schemas/admin_ops.tools");

const baseRegistry = [
  ...deviceTools,
  ...overviewTools,
  ...remoteTools,
  ...pageTools,
  ...todoTools,
  ...scheduleTools,
  ...templateTools,
  ...firmwareTools,
  ...collectionTools,
  ...albumTools,
  ...aiConfigTools,
  ...extendedTools,
];

const baseNames = new Set(baseRegistry.map((tool) => tool.name));
const registry = [
  ...baseRegistry,
  ...adminOpsTools.filter((tool) => !baseNames.has(tool.name)),
];

const byName = new Map(registry.map((tool) => [tool.name, tool]));

function formatUsageHint(tool = {}) {
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  const riskLevel = tool.riskLevel || "read";
  const requiredText = required.length ? `必填参数：${required.join(", ")}。` : "无必填参数。";
  const confirmText = ["write", "device_write", "device_action", "destructive", "upgrade", "admin"].includes(riskLevel)
    ? "会修改系统或影响真实设备，首次调用不要传 confirm；用户确认后再次调用并传 confirm=true。"
    : "只读查询可直接调用。";
  return `使用方法：${requiredText}${confirmText}`;
}

function describeTool(tool = {}) {
  const description = String(tool.description || "").trim();
  const usage = formatUsageHint(tool);
  return description.includes("使用方法") || description.includes("Use when") || description.includes("调用建议")
    ? description
    : `${description}${description ? "\n" : ""}${usage}`;
}

function listTools() {
  return registry.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: describeTool(tool),
    riskLevel: tool.riskLevel,
    inputSchema: tool.inputSchema || { type: "object", properties: {} },
  }));
}

function getTool(name) {
  return byName.get(String(name || ""));
}

module.exports = {
  getTool,
  listTools,
  registry,
};
