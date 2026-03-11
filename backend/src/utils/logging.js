const createId = require("./id");
const { updateDB } = require("../db/store");

async function logOperation({
  actorId = "system",
  actorRole = "system",
  action,
  targetType = "system",
  targetId = "",
  detail = {},
  status = "success",
}) {
  if (!action) return;

  try {
    await updateDB((db) => {
      db.operationLogs.unshift({
        id: createId("oplog"),
        actorId,
        actorRole,
        action,
        targetType,
        targetId,
        detail,
        status,
        createdAt: new Date().toISOString(),
      });
      db.operationLogs = db.operationLogs.slice(0, 5000);
    });
  } catch (_) {
    // Ignore logging failures to avoid breaking main flow.
  }
}

async function logApi({
  callerRole = "unknown",
  callerId = "",
  deviceId = "",
  templateSlug = "",
  success = true,
  statusCode = 200,
  latencyMs = 0,
  error = "",
}) {
  try {
    await updateDB((db) => {
      db.apiLogs.unshift({
        id: createId("apilog"),
        callerRole,
        callerId,
        deviceId,
        templateSlug,
        success,
        statusCode,
        latencyMs,
        error,
        createdAt: new Date().toISOString(),
      });
      db.apiLogs = db.apiLogs.slice(0, 10000);
    });
  } catch (_) {
    // Ignore logging failures to avoid breaking main flow.
  }
}

module.exports = {
  logOperation,
  logApi,
};
