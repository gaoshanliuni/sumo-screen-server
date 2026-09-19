const { summarizeDevicesFromState } = require("../repositories/device.repository");
const { buildOverviewFromState } = require("../repositories/dashboard.repository");

const MOBILE_MENUS = [
  { key: "devices", title: "设备管理", icon: "monitor", path: "/pages/devices/devices" },
  { key: "variables", title: "设备变量", icon: "sliders", path: "/pages/device-variables/device-variables" },
  { key: "pin", title: "设备与PIN", icon: "lock", path: "/pages/device-pin/device-pin" },
  { key: "remote", title: "远程控制", icon: "remote", path: "/pages/remote/remote" },
  { key: "ai", title: "AI助手", icon: "ai", path: "/pages/assistant/assistant" },
  { key: "aiSettings", title: "AI设置", icon: "settings", path: "/pages/settings/settings?section=ai" },
  { key: "homepage", title: "主页", icon: "home", path: "/pages/homepage/homepage" },
  { key: "badgepage", title: "桌牌设置", icon: "card", path: "/pages/nameplate/nameplate" },
  { key: "history", title: "桌牌历史", icon: "history", path: "/pages/nameplate-history/nameplate-history" },
  { key: "todo", title: "TODO", icon: "todo", path: "/pages/todos/todos" },
  { key: "schedule", title: "课程表", icon: "schedule", path: "/pages/schedules/schedules" },
  { key: "firmware", title: "固件管理", icon: "firmware", path: "/pages/firmware/firmware" },
];

function findUser(state = {}, auth = {}) {
  const users = Array.isArray(state.users) ? state.users : [];
  return users.find((item) => String(item.id || "") === String(auth.userId || "")) || {};
}

function buildMobileBootstrap(state = {}, auth = {}) {
  const user = findUser(state, auth);
  const isAdmin = auth.role === "admin";
  return {
    user: {
      id: auth.userId || user.id || "",
      name: user.nickname || user.username || auth.username || (isAdmin ? "超级管理员" : "用户"),
      role: auth.role || user.role || "user",
    },
    summary: summarizeDevicesFromState(state, auth),
    menus: MOBILE_MENUS.filter((item) => isAdmin || !["firmware"].includes(item.key)),
    permissions: {
      canControlDevice: ["admin", "user"].includes(auth.role),
      canUpgradeFirmware: isAdmin,
      canUseAI: true,
    },
  };
}

function buildMobileOverview(state = {}, auth = {}, filters = {}) {
  return buildOverviewFromState(state, auth, filters);
}

module.exports = {
  MOBILE_MENUS,
  buildMobileBootstrap,
  buildMobileOverview,
};
