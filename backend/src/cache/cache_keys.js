module.exports = {
  dashboardSummary: (userId) => `dashboard:summary:${userId || "all"}`,
  mobileBootstrap: (userId, role) => `mobile:bootstrap:${userId || "anonymous"}:${role || "unknown"}`,
  deviceList: (userId, hash) => `devices:list:${userId || "all"}:${hash || "default"}`,
  deviceStatus: (deviceId) => `devices:status:${deviceId}`,
  aiSession: (sessionId) => `ai:session:${sessionId}`,
  aiConfirm: (confirmToken) => `ai:confirm:${confirmToken}`,
  taskState: (taskId) => `task:state:${taskId}`,
  lockFirmwareUpgrade: (deviceId) => `lock:firmware-upgrade:${deviceId}`,
};
