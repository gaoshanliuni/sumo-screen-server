const createId = require("./id");
const { updateDBOptimistic } = require("../db/store");

function enqueueLogWrite(task) {
  setImmediate(() => {
    task().catch(() => {
      // Ignore logging failures to avoid breaking main flow.
    });
  });
  return Promise.resolve();
}

function logOperation({
  actorId = "system",
  actorRole = "system",
  action,
  targetType = "system",
  targetId = "",
  detail = {},
  status = "success",
}) {
  if (!action) return Promise.resolve();
  return enqueueLogWrite(async () => {
    await updateDBOptimistic((db) => {
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
  });
}

function logApi({
  callerRole = "unknown",
  callerId = "",
  deviceId = "",
  templateSlug = "",
  success = true,
  statusCode = 200,
  latencyMs = 0,
  error = "",
}) {
  return enqueueLogWrite(async () => {
    await updateDBOptimistic((db) => {
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
  });
}

module.exports = {
  logOperation,
  logApi,
};
