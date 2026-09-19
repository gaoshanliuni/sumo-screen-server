/* eslint-disable no-console */
const assert = require("assert");
const {
  cleanupUnusedPageCacheFilesInDraft,
  deleteGridObjects,
  isSystemPageCacheTfFile,
  prunePageImageHistoryInDraft,
} = require("../src/services/tf_file_cleanup.service");

function gridId(seed) {
  return String(seed).padStart(24, "0").slice(-24);
}

function pageFile({ id, pageType = "homepage", deviceId = "dev1", preview = false, versionIndex = 0 }) {
  const ts = 1760000000000 - versionIndex;
  const suffix = `${ts}-${String(versionIndex).padStart(8, "a")}`;
  const originalName = preview
    ? `${pageType}_preview_${deviceId}_${suffix}.png`
    : `${pageType}_${deviceId}_${suffix}.epd4`;
  return {
    id,
    ownerId: "u1",
    category: preview ? "photo" : "background",
    name: `${id}_${originalName}`,
    originalName,
    size: preview ? 128 : 192000,
    mime: preview ? "image/png" : "application/x-epd4",
    gridId: gridId(id.replace(/\D/g, "") || 1),
    source: pageType,
    generatedBy: "page-render",
    meta: {
      source: pageType,
      pageType,
      generatedBy: "page-render",
      originalName,
    },
    createdAt: new Date(ts).toISOString(),
    updatedAt: new Date(ts).toISOString(),
  };
}

function pageRow(index) {
  return {
    id: `hpi_${index}`,
    deviceId: "dev1",
    ownerId: "u1",
    imageFileId: `tf_img_${index}`,
    previewFileId: `tf_preview_${index}`,
    updatedAt: new Date(1760000000000 - index).toISOString(),
    createdAt: new Date(1760000000000 - index).toISOString(),
  };
}

async function main() {
  const state = {
    tfFiles: [],
    homepageImages: [],
    badgepageImages: [],
    weatherpageImages: [],
    imageAssets: [],
    e6RenderedAssets: [],
    remoteCommandAcks: [],
  };

  for (let i = 0; i < 5; i += 1) {
    state.homepageImages.push(pageRow(i));
    state.tfFiles.push(pageFile({ id: `tf_img_${i}`, versionIndex: i }));
    state.tfFiles.push(pageFile({ id: `tf_preview_${i}`, preview: true, versionIndex: i }));
  }

  const prune = prunePageImageHistoryInDraft({
    draft: state,
    imageKey: "homepageImages",
    deviceId: "dev1",
    maxVersions: 3,
  });
  assert.strictEqual(state.homepageImages.length, 3, "homepageImages should retain max_versions rows");
  assert.deepStrictEqual(
    new Set(prune.candidateFileIds),
    new Set(["tf_img_3", "tf_preview_3", "tf_img_4", "tf_preview_4"]),
    "pruned rows should produce old image/preview TF IDs"
  );

  const cleanup = cleanupUnusedPageCacheFilesInDraft(state, {
    candidateFileIds: prune.candidateFileIds,
  });
  assert.strictEqual(cleanup.removedCount, 4, "old page cache TF files should be removed");
  assert.deepStrictEqual(
    new Set(cleanup.removedFileIds),
    new Set(["tf_img_3", "tf_preview_3", "tf_img_4", "tf_preview_4"]),
    "removed TF IDs should match pruned page rows"
  );
  assert(
    ["tf_img_0", "tf_preview_0", "tf_img_1", "tf_preview_1", "tf_img_2", "tf_preview_2"].every((id) =>
      state.tfFiles.some((file) => file.id === id)
    ),
    "latest retained page rows must keep their TF files"
  );

  const manualE6 = {
    id: "tf_manual_e6",
    ownerId: "u1",
    category: "background",
    name: "tf_manual_e6_manual.e6p4",
    originalName: "manual.e6p4",
    mime: "application/x-e6p4",
    gridId: gridId(998),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  state.tfFiles.push(manualE6);
  const manualCleanup = cleanupUnusedPageCacheFilesInDraft(state, {
    now: new Date("2026-07-05T00:00:00.000Z"),
    minAgeMs: 1,
  });
  assert.strictEqual(manualCleanup.removedFileIds.includes("tf_manual_e6"), false, "manual E6 files must not be removed");
  assert(state.tfFiles.some((file) => file.id === "tf_manual_e6"), "manual E6 file should remain in tfFiles");

  const protectedState = {
    tfFiles: [
      pageFile({ id: "tf_page_binary_protected", versionIndex: 20 }),
      pageFile({ id: "tf_page_preview_protected", preview: true, versionIndex: 20 }),
    ],
    homepageImages: [],
    badgepageImages: [],
    weatherpageImages: [],
    imageAssets: [{ id: "img1", originalTfFileId: "tf_page_preview_protected" }],
    e6RenderedAssets: [{ id: "e6a1", binaryTfFileId: "tf_page_binary_protected", convertStatus: "ready" }],
    remoteCommandAcks: [],
  };
  const protectedCleanup = cleanupUnusedPageCacheFilesInDraft(protectedState);
  assert.strictEqual(protectedCleanup.removedCount, 0, "active image/e6 references should protect TF files");

  const oldSystemFile = pageFile({ id: "tf_old_orphan", versionIndex: 99 });
  assert.strictEqual(isSystemPageCacheTfFile(oldSystemFile), true, "generated page cache should be recognized");
  const failureState = {
    tfFiles: [oldSystemFile],
    homepageImages: [],
    badgepageImages: [],
    weatherpageImages: [],
    imageAssets: [],
    e6RenderedAssets: [],
    remoteCommandAcks: [],
  };
  const failureCleanup = cleanupUnusedPageCacheFilesInDraft(failureState);
  assert.strictEqual(failureCleanup.removedCount, 1, "DB cleanup should remove orphan page cache before GridFS delete");
  assert.strictEqual(failureState.tfFiles.length, 0, "orphan TF DB record should stay removed even if GridFS delete fails");

  const warnings = [];
  const deleteSummary = await deleteGridObjects(failureCleanup.deleteJobs, {
    bucket: {
      delete: async () => {
        throw new Error("simulated grid delete failure");
      },
    },
    logger: {
      warn: (message) => warnings.push(String(message)),
    },
  });
  assert.strictEqual(deleteSummary.requested, 1, "delete should be attempted once");
  assert.strictEqual(deleteSummary.failed, 1, "GridFS delete failure should be reported");
  assert.strictEqual(warnings.length, 1, "GridFS delete failure should be logged");

  console.log("[ok] TF page cache cleanup contract passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
