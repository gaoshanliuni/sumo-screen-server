const { listDevicesFromState, summarizeDevicesFromState } = require("./device.repository");
const { paginateRows } = require("./pagination");

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function listRecent(rows, options = {}) {
  const sorted = [...safeArray(rows)].sort((a, b) => {
    const av = Date.parse(a.createdAt || a.updatedAt || "") || 0;
    const bv = Date.parse(b.createdAt || b.updatedAt || "") || 0;
    return bv - av;
  });
  return sorted.slice(0, Number(options.limit || 10));
}

function buildOverviewFromState(state = {}, auth = {}, filters = {}) {
  const summary = summarizeDevicesFromState(state, auth, filters);
  const filteredDevices = listDevicesFromState(state, {
    auth,
    status: filters.status || "",
    keyword: filters.keyword || "",
    page: filters.page || 1,
    pageSize: filters.pageSize || 20,
  });

  const visibleIds = new Set(listDevicesFromState(state, { auth, page: 1, pageSize: 100 }).rows.map((item) => item.id));
  const deviceTypeMap = new Map();
  filteredDevices.rows.forEach((device) => {
    const name = device.deviceTypeName || device.type || "未分类";
    deviceTypeMap.set(name, Number(deviceTypeMap.get(name) || 0) + 1);
  });

  return {
    summary,
    filteredDevices,
    recentOperations: listRecent(state.operationLogs, { limit: 10 }),
    recentApiLogs: listRecent(state.apiLogs, { limit: 10 }),
    recentFailures: listRecent(
      safeArray(state.operationLogs).filter((item) => String(item.status || "") === "failed"),
      { limit: 10 }
    ),
    recentNameplateHistory: listRecent(
      safeArray(state.nameplateHistory).filter((item) => !item.deviceId || visibleIds.has(item.deviceId)),
      { limit: 10 }
    ),
    todoSummary: {
      total: safeArray(state.todos).filter((item) => visibleIds.has(item.deviceId)).length,
      pending: safeArray(state.todos).filter((item) => visibleIds.has(item.deviceId) && !item.done).length,
    },
    scheduleSummary: {
      total: safeArray(state.schedules).filter((item) => visibleIds.has(item.deviceId)).length,
    },
    deviceTypeDistribution: Array.from(deviceTypeMap.entries()).map(([name, count]) => ({ name, count })),
    system: {
      redis: "optional",
      queue: "optional",
      ai: "optional",
      generatedAt: new Date().toISOString(),
    },
  };
}

function listLogsFromState(state = {}, collectionKey = "operationLogs", options = {}) {
  const rows = safeArray(state[collectionKey]);
  return paginateRows(rows, options);
}

module.exports = {
  buildOverviewFromState,
  listLogsFromState,
};
