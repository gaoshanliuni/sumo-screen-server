const { listTools } = require("../tools/registry");
const { executeTool } = require("../tools/executor");
const { readDB, updateDB } = require("../db/store");
const { verifyToken } = require("../utils/jwt");

function actorFromToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  try {
    const payload = verifyToken(raw);
    return {
      role: payload.role || "user",
      userId: payload.userId || payload.sub || "",
      username: payload.username || payload.name || "mcp",
      deviceId: payload.deviceId || "",
    };
  } catch (_) {
    return null;
  }
}

function explicitEnvActor() {
  if (!process.env.MCP_ROLE && !process.env.MCP_USER_ID) return null;
  return {
    role: process.env.MCP_ROLE || "user",
    userId: process.env.MCP_USER_ID || "mcp",
    username: "mcp",
  };
}

function getMcpActor(context = {}) {
  if (context.actor && typeof context.actor === "object") {
    return {
      role: context.actor.role || "user",
      userId: context.actor.userId || context.actor.sub || "",
      username: context.actor.username || context.actor.name || "mcp",
      deviceId: context.actor.deviceId || "",
    };
  }
  return actorFromToken(context.userToken) ||
    actorFromToken(process.env.MCP_USER_TOKEN) ||
    explicitEnvActor() || {
      role: "user",
      userId: "mcp",
      username: "mcp",
    };
}

async function callTool(name, params = {}, context = {}) {
  const state = await readDB();
  return executeTool({
    state,
    actor: getMcpActor(context),
    name,
    params,
    updateState: updateDB,
    confirm: params.confirm === true,
    dryRun: params.dryRun,
    reason: "mcp",
  });
}

module.exports = {
  callTool,
  getMcpActor,
  listTools,
};
