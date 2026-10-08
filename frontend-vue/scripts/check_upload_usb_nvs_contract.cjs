const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const albumPanel = fs.readFileSync(path.join(root, "src", "components", "E6AlbumPanel.vue"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "src", "views", "DashboardCore.vue"), "utf8");
const backendRoot = path.resolve(root, "..", "backend");
const albumImportRoutes = fs.readFileSync(path.join(backendRoot, "src", "routes", "album_import.routes.js"), "utf8");

const checks = [
  [
    "web album upload auto-starts after file selection",
    /function\s+handleUploadInput[\s\S]*uploadFiles\.value\s*=[\s\S]*void\s+uploadSelectedFiles\(\)/.test(albumPanel),
  ],
  [
    "backend exposes singular upload alias for clients that call upload",
    albumImportRoutes.includes('"/upload"') && albumImportRoutes.includes('handleAlbumUpload'),
  ],
  [
    "usb nvs has mutually exclusive mode tabs",
    dashboard.includes("usb-nvs-mode-tabs") &&
      dashboard.includes("usbNvsState.mode === 'usb'") &&
      dashboard.includes("usbNvsState.mode === 'online'"),
  ],
  [
    "online nvs does not silently fallback to globally selected devices",
    /function\s+selectedNvsDeviceId\(\)\s*\{\s*return\s+usbNvsState\.selectedDeviceId\s*\|\|\s*"";\s*\}/.test(dashboard),
  ],
  [
    "usb nvs reads from connected usb instead of backend device selector",
    dashboard.includes("readUsbHardwareNvs") && dashboard.includes("USB 读取硬件 NVS"),
  ],
];

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  throw new Error(`upload/usb-nvs contract failed:\n- ${failed.join("\n- ")}`);
}

console.log("[ok] upload and USB/NVS contract satisfied");
