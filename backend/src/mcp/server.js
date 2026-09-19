const { callTool, listTools } = require("./tools");
const { listResources, readResource } = require("./resources");
const { getPrompt, listPrompts } = require("./prompts");

function toMcpTool(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: `${tool.description || ""} 风险等级: ${tool.riskLevel || "read"}`,
    inputSchema: tool.inputSchema || { type: "object", properties: {} },
  };
}

function jsonText(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function handleJsonRpc(message = {}, context = {}) {
  const { id, method, params = {} } = message;
  if (method && method.startsWith("notifications/")) return null;
  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          serverInfo: {
            name: "ink-screen-platform-mcp",
            version: "1.0.0",
          },
        },
      };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: listTools().map(toMcpTool) } };
    }
    if (method === "tools/call") {
      const result = await callTool(params.name, params.arguments || {}, context);
      return { jsonrpc: "2.0", id, result: jsonText(result) };
    }
    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: listResources() } };
    }
    if (method === "resources/read") {
      const data = await readResource(params.uri);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri: params.uri,
              mimeType: "application/json",
              text: JSON.stringify(data, null, 2),
            },
          ],
        },
      };
    }
    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: listPrompts() } };
    }
    if (method === "prompts/get") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          description: params.name,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: getPrompt(params.name, params.arguments || {}),
              },
            },
          ],
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error?.message || String(error || "MCP error"),
      },
    };
  }
}

module.exports = {
  handleJsonRpc,
};
