const DEVICE_TYPES = [
  {
    type: "ink-screen",
    label: "大尺寸水墨屏",
    colorMode: "bw",
    defaultResolution: { width: 800, height: 480 },
    supportsCollections: true,
    supportsTfSync: true,
    supportsRemoteImage: true,
  },
  {
    type: "e6-color-frame",
    label: "E6 彩色水墨屏相框",
    colorMode: "e6_6color",
    binaryFormat: "e6p4",
    defaultResolution: { width: 800, height: 480 },
    colors: ["black", "white", "red", "yellow", "blue", "green"],
    supportsCollections: true,
    supportsTfSync: true,
    supportsSdOffline: true,
    supportsWheelMenu: true,
    supportsSensorTelemetry: true,
    supportsApProvisioning: true,
  },
];

function listDeviceTypes() {
  return DEVICE_TYPES.map((item) => ({ ...item, defaultResolution: { ...item.defaultResolution } }));
}

function getDeviceType(type) {
  return listDeviceTypes().find((item) => item.type === type) || null;
}

module.exports = {
  listDeviceTypes,
  getDeviceType,
};
