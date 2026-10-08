const { readDB } = require("../db/store");
const { buildMobileOverview } = require("../services/mobile.service");

function listResources() {
  return [
    {
      uri: "ink://overview",
      name: "系统概览",
      description: "当前系统设备、日志、待办和课程表概览",
      mimeType: "application/json",
    },
    {
      uri: "ink://devices",
      name: "设备列表",
      description: "当前系统设备上下文",
      mimeType: "application/json",
    },
    {
      uri: "ink://templates",
      name: "API模板",
      description: "当前 API 模板上下文",
      mimeType: "application/json",
    },
  ];
}

async function readResource(uri) {
  const db = await readDB();
  const actor = { role: process.env.MCP_ROLE || "admin", userId: process.env.MCP_USER_ID || "mcp" };
  if (uri === "ink://overview") return buildMobileOverview(db, actor);
  if (uri === "ink://devices") return db.devices || [];
  if (uri === "ink://templates") return db.apiTemplates || [];
  const error = new Error(`未知资源: ${uri}`);
  error.code = "RESOURCE_NOT_FOUND";
  throw error;
}

module.exports = {
  listResources,
  readResource,
};
