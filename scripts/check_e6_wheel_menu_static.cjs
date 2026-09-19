const fs = require("fs");
const path = require("path");

const firmwareRoot = process.env.E6_FIRMWARE_ROOT || "D:/epde6/firmware";

function read(rel) {
  return fs.readFileSync(path.join(firmwareRoot, rel), "utf8");
}

const menuHeader = read("include/menu_controller.h");
const menuSource = read("src/menu_controller.cpp");
const frameApp = read("src/frame_app.cpp");
const displayHeader = read("include/epaper_display.h");
const displaySource = read("src/epaper_display.cpp");
const wheelSource = read("src/wheel_input.cpp");
const appConfig = read("include/app_config.h");

const checks = [
  [
    "menu controller returns real actions for frame app",
    menuHeader.includes("enum class MenuAction") &&
      menuHeader.includes("RenderMenu") &&
      menuHeader.includes("NextPhoto") &&
      menuHeader.includes("RefreshNow") &&
      menuHeader.includes("EnterNetworkSetup"),
  ],
  [
    "menu controller maps click rotate and long press to a menu state machine",
    /MenuAction\s+MenuController::handleWheelEvent/.test(menuSource) &&
      menuSource.includes("selectedIndex_") &&
      menuSource.includes("RotateLeft") &&
      menuSource.includes("RotateRight") &&
      menuSource.includes("LongPress"),
  ],
  [
    "frame app executes wheel actions instead of only logging state",
    frameApp.includes("handleWheelAction") &&
      frameApp.includes("renderWheelMenu") &&
      frameApp.includes("renderWheelStatus") &&
      frameApp.includes("refreshCurrentAlbumFlow()"),
  ],
  [
    "frame app exposes a USB serial wheel event diagnostic path",
    frameApp.includes("wheel.event") &&
      frameApp.includes("handleSerialWheelEvent") &&
      frameApp.includes("wheel.event.result") &&
      frameApp.includes("unsupported wheel event"),
  ],
  [
    "frame loop no longer blocks wheel polling with one second idle delays",
    !frameApp.includes("delay(1000)") && frameApp.includes("idleDelay"),
  ],
  [
    "display can draw visible wheel menu and status screens",
    displayHeader.includes("drawWheelMenu") &&
      displayHeader.includes("drawWheelStatus") &&
      displaySource.includes("refresh start wheel menu bw fast") &&
      displaySource.includes("wheelMenuBwPixelColor") &&
      !displaySource.includes("EPD_COLOR_YELLOW : EPD_COLOR_WHITE"),
  ],
  [
    "wheel input has debounce fields to avoid false clicks and missed rotations",
    wheelSource.includes("ENCODER_DEBOUNCE_MS") &&
      wheelSource.includes("BUTTON_DEBOUNCE_MS") &&
      wheelSource.includes("lastRotateAtMs_"),
  ],
  [
    "wheel input supports the three physical key layout from the vendor usage note",
    appConfig.includes("WHEEL_KEY_UP_PIN") &&
      appConfig.includes("WHEEL_KEY_MID_PIN") &&
      appConfig.includes("WHEEL_KEY_DOWN_PIN") &&
      wheelSource.includes("wheel key mode enabled") &&
      wheelSource.includes("pollKeys") &&
      wheelSource.includes("WheelEventType::RotateLeft") &&
      wheelSource.includes("WheelEventType::RotateRight"),
  ],
];

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  throw new Error(`E6 wheel menu contract failed:\n- ${failed.join("\n- ")}`);
}

console.log("[ok] E6 wheel menu static contract satisfied");
