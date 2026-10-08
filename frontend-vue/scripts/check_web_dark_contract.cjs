const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const albumPanel = fs.readFileSync(path.join(root, "src", "components", "E6AlbumPanel.vue"), "utf8");
const aiPanel = fs.readFileSync(path.join(root, "src", "components", "AiChatPanel.vue"), "utf8");

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const albumDarkSelectors = [
  ".album-topbar",
  ".album-panel",
  ".album-mode-tabs",
  ".album-mode-tabs button.active",
  ".device-row",
  ".collection-row",
  ".source-chip",
  ".collection-gallery-card",
  ".album-tile",
  ".upload-zone",
  ".confirm-box",
  ".selected-footer",
  ".preview-thumb",
  ".thumb-preview",
];

const aiDarkSelectors = [
  ".ai-chat-shell",
  ".ai-chat-titlebar",
  ".ai-message-list",
  ".assistant-bubble",
  ".user-bubble",
  ".ai-confirm-card",
  ".confirm-actions-preview span",
  ".ai-composer",
  ".typing-indicator",
];

const checks = [
  ["album panel has dark-mode overrides", count(albumPanel, ":global(.dark-mode)") >= 12],
  [
    "album dark mode covers main light surfaces",
    albumDarkSelectors.every((selector) => albumPanel.includes(`:global(.dark-mode) ${selector}`)),
  ],
  ["AI panel has complete dark-mode overrides", count(aiPanel, ":global(.dark-mode)") >= 10],
  ["AI dark mode covers message and composer surfaces", aiDarkSelectors.every((selector) => aiPanel.includes(`:global(.dark-mode) ${selector}`))],
];

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  throw new Error(`web dark-mode contract failed:\n- ${failed.join("\n- ")}`);
}

console.log("[ok] web dark-mode contract satisfied");
