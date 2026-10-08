const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "src", "components", "E6AlbumPanel.vue"), "utf8");

const checks = [
  [
    "preview dialog keeps an explicit clicked-image target list",
    panel.includes("targetImageIds") && panel.includes("imagePreviewDialog.targetImageIds"),
  ],
  [
    "converted preview ids come from the dialog target, not stale collection selection",
    /const previewImageIds = computed[\s\S]*imagePreviewDialog\.targetImageIds[\s\S]*\[imagePreviewDialog\.imageId\]/.test(panel) &&
      !/const previewImageIds = computed[\s\S]*selectedCollectionItemIds\.value\.length[\s\S]*\?[\s\S]*selectedCollectionItemIds\.value/.test(panel),
  ],
  [
    "opening a preview resets previous converted result before assigning the new target",
    panel.includes("imagePreviewDialog.e6Previews = []") &&
      panel.includes("imagePreviewDialog.targetImageIds = imageId ? [imageId] : []"),
  ],
  [
    "preview dialog exposes rotation and crop controls",
    panel.includes("rotatePreviewImage(") &&
      panel.includes("resetPreviewCrop") &&
      panel.includes("cropX") &&
      panel.includes("裁剪"),
  ],
  [
    "preview and apply requests send the same image transform payload",
    (panel.match(/imageTransform:\s*previewImageTransform\.value/g) || []).length >= 2,
  ],
];

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  throw new Error(`E6 preview dialog contract failed:\n- ${failed.join("\n- ")}`);
}

console.log("[ok] E6 preview dialog target contract satisfied");
