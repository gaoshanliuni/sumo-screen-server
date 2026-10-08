const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const albumPanel = fs.readFileSync(path.join(root, "src", "components", "E6AlbumPanel.vue"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "src", "views", "DashboardCore.vue"), "utf8");
const service = fs.readFileSync(path.join(root, "src", "services", "e6Albums.ts"), "utf8");

const checks = [
  ["dashboard menu renders svg icons", dashboard.includes("menu-svg") && dashboard.includes("iconPaths")],
  ["album panel has dashboard shell", albumPanel.includes("album-dashboard")],
  [
    "album panel uses top-level mode tabs above whole workspace",
    albumPanel.includes("album-mode-pages") &&
      albumPanel.indexOf("album-mode-tabs") > 0 &&
      albumPanel.indexOf("album-mode-tabs") < albumPanel.indexOf("album-mode-pages"),
  ],
  ["play photo page has standalone device panel", albumPanel.includes("play-device-panel")],
  ["play photo page has collection thumbnail gallery", albumPanel.includes("play-collection-gallery")],
  ["play photo page renders collection item thumbnails", albumPanel.includes("collectionPreviewItems(")],
  ["collection editor owns source browser", albumPanel.includes("collection-editor-layout") && albumPanel.includes("source-browser-panel")],
  ["album panel can create collections", albumPanel.includes("createPlayCollection(")],
  ["album panel can patch collections", albumPanel.includes("patchPlayCollection(")],
  ["album panel can delete collections", albumPanel.includes("deletePlayCollection(")],
  ["album panel can patch album sources", albumPanel.includes("patchAlbumSource(")],
  ["album panel can delete album sources", albumPanel.includes("deleteAlbumSource(")],
  ["album panel calls real upload API", albumPanel.includes("uploadAlbumImages(")],
  ["service exposes uploadAlbumImages", service.includes("export async function uploadAlbumImages")],
  [
    "source browser moved into a dialog and main editor owns local upload",
    albumPanel.includes("sourcePickerOpen") &&
      albumPanel.includes("source-picker-dialog") &&
      albumPanel.includes("本地上传") &&
      albumPanel.includes("handlePasteUpload") &&
      albumPanel.includes("handleDropUpload"),
  ],
  [
    "local upload defaults to the active collection instead of target selector controls",
    albumPanel.includes("activeCollectionId") &&
      albumPanel.includes("currentUploadCollectionLabel") &&
      !albumPanel.includes("新集合名称，和目标集合二选一"),
  ],
  [
    "album panel exposes E6 dither mode controls",
    albumPanel.includes("ditherModeOptions") &&
      albumPanel.includes("waveshare_floyd") &&
      albumPanel.includes("photo_soft") &&
      albumPanel.includes("photo_detail") &&
      albumPanel.includes("poster_clean") &&
      albumPanel.includes("art_blue_noise") &&
      albumPanel.includes("抖动方式"),
  ],
  [
    "album panel sends selected dither mode for upload and import",
    (albumPanel.match(/ditherMode:\s*effectiveDitherMode\.value/g) || []).length >= 3,
  ],
  [
    "album panel supports on-demand E6 preview and dither persistence",
    albumPanel.includes("previewE6Images(") &&
      albumPanel.includes("setE6ImageDitherMode(") &&
      albumPanel.includes("previewImageIds") &&
      albumPanel.includes("applyPreviewDitherToImages"),
  ],
  [
    "collection detail supports selection controls and lasso select",
    albumPanel.includes("selectAllCollectionItems") &&
      albumPanel.includes("invertCollectionItems") &&
      albumPanel.includes("collectionGridRef") &&
      albumPanel.includes("startCollectionLasso") &&
      albumPanel.includes("collectionLassoStyle"),
  ],
  ["album API accepts dither mode payloads", service.includes("ditherMode?:") && service.includes('form.set("ditherMode"')],
  ["album API exposes E6 preview and dither setters", service.includes("export async function previewE6Images") && service.includes("export async function setE6ImageDitherMode")],
  ["album panel can remove a collection image", albumPanel.includes("removeCollectionItem(") && albumPanel.includes("setPlayCollectionItems(")],
  [
    "album panel previews images in current-page dialog",
    albumPanel.includes("imagePreviewDialog") &&
      albumPanel.includes("preview-dialog") &&
      albumPanel.includes("<el-dialog") &&
      !albumPanel.includes("window.open"),
  ],
  ["interval is edited in minutes", albumPanel.includes("切换分钟") && !albumPanel.includes("切换秒数")],
  [
    "push collection filters stale selected collection ids before request",
    albumPanel.includes("validSelectedCollectionIds") &&
      albumPanel.includes("selectedCollectionIds.value = validCollectionIds") &&
      albumPanel.includes("请选择有效集合"),
  ],
  [
    "push collection reports device ack state instead of unconditional success",
    albumPanel.includes("ackedSuccessCount") &&
      albumPanel.includes("ackedPendingCount") &&
      albumPanel.includes("设备未确认"),
  ],
];

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  throw new Error(`E6 album panel contract failed:\n- ${failed.join("\n- ")}`);
}

console.log("[ok] E6 album panel dashboard contract satisfied");
