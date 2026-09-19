const createId = require("../utils/id");
const { getTool } = require("./registry");

const RISK_REQUIRES_CONFIRM = new Set(["write", "device_write", "device_action", "destructive", "upgrade", "admin"]);

function validateRequired(tool, params = {}) {
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  required.forEach((key) => {
    if (params[key] === undefined || params[key] === null || params[key] === "") {
      const error = new Error(`缺少参数: ${key}`);
      error.code = "BAD_PARAMS";
      throw error;
    }
  });
}

function sanitizeError(error) {
  return {
    errorCode: error?.code || "TOOL_ERROR",
    message: error?.message || String(error || "工具执行失败"),
    retryable: false,
  };
}

async function executeTool({ state, actor, name, params = {}, updateState = null, confirm = false, dryRun = undefined, reason = "" }) {
  const tool = getTool(name);
  if (!tool) {
    return {
      ok: false,
      tool: name,
      errorCode: "TOOL_NOT_FOUND",
      message: `工具不存在: ${name}`,
      retryable: false,
    };
  }

  const riskLevel = tool.riskLevel || "read";
  const effectiveDryRun = dryRun === undefined ? RISK_REQUIRES_CONFIRM.has(riskLevel) && !confirm : Boolean(dryRun);
  if (RISK_REQUIRES_CONFIRM.has(riskLevel) && !confirm) {
    return {
      ok: false,
      tool: tool.name,
      needConfirm: true,
      confirmToken: createId("confirm"),
      message: "该操作会修改系统或影响真实设备，请确认后继续",
      plannedActions: [
        {
          tool: tool.name,
          title: tool.title,
          riskLevel,
          params,
          reason,
        },
      ],
    };
  }

  try {
    validateRequired(tool, params);
    if (effectiveDryRun) {
      return {
        ok: true,
        tool: tool.name,
        dryRun: true,
        message: "dryRun completed",
        data: { params },
      };
    }
    const data = await tool.handler({ state, actor, params, updateState, confirm, dryRun: effectiveDryRun, reason });
    return {
      ok: true,
      tool: tool.name,
      message: "执行成功",
      data,
      auditId: createId("audit"),
    };
  } catch (error) {
    return {
      ok: false,
      tool: tool.name,
      ...sanitizeError(error),
      auditId: createId("audit"),
    };
  }
}

module.exports = {
  executeTool,
};
