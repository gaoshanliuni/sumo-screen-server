/**
 * 诊断脚本：检查相册/集合中缺失原图的图片
 *
 * 用法：node scripts/diagnose_e6_missing_original.js [imageId]
 *
 * 检查逻辑：
 * 1. 找到指定 imageId 的 imageAsset 记录
 * 2. 检查其 originalTfFileId / tfFileId 指向的 TF 文件是否存在
 * 3. 检查 TF 文件的 gridId 是否有效
 * 4. 检查 MongoDB GridFS 中是否还有对应的文件
 * 5. 列出该图片所在的所有播放集合
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { readDB } = require("../src/db/store");
const { getGridBucket, ObjectId } = require("../src/utils/mongo");
const { connectMongo } = require("../src/server"); // 假设 server.js 导出了 connectMongo

async function main() {
  const targetImageId = process.argv[2] ? String(process.argv[2]).trim() : null;

  console.log("=".repeat(70));
  console.log("  E6 原图缺失诊断");
  console.log("=".repeat(70));

  try {
    const state = await readDB();

    const imageAssets = Array.isArray(state.imageAssets) ? state.imageAssets : [];
    const tfFiles = Array.isArray(state.tfFiles) ? state.tfFiles : [];
    const e6Assets = Array.isArray(state.e6RenderedAssets) ? state.e6RenderedAssets : [];
    const playCollectionItems = Array.isArray(state.playCollectionItems) ? state.playCollectionItems : [];
    const playCollections = Array.isArray(state.playCollections) ? state.playCollections : [];

    console.log(`\n数据统计:`);
    console.log(`  imageAssets: ${imageAssets.length} 条`);
    console.log(`  tfFiles: ${tfFiles.length} 条`);
    console.log(`  e6RenderedAssets: ${e6Assets.length} 条`);
    console.log(`  playCollectionItems: ${playCollectionItems.length} 条`);
    console.log(`  playCollections: ${playCollections.length} 条`);

    // 找到缺失原图的所有图片
    const problems = [];

    for (const image of imageAssets) {
      if (targetImageId && image.id !== targetImageId) continue;

      const originalTfId = String(image.originalTfFileId || image.tfFileId || "");
      const tfFile = tfFiles.find((f) => f.id === originalTfId);

      const hasE6Asset = e6Assets.some((a) => {
        const status = String(a.convertStatus || "").toLowerCase();
        return a.imageId === image.id && a.binaryTfFileId && (!status || status === "ready" || status === "success");
      });

      const problem = {
        imageId: image.id,
        originalName: image.originalName || "",
        sourceType: image.sourceType || "",
        sourcePath: image.sourcePath || "",
        originalTfFileId: originalTfId,
        tfFileId: image.tfFileId || "",
        hasE6Asset,
        e6ConvertStatus: image.e6ConvertStatus || "",
        tfFileExists: Boolean(tfFile),
        tfGridId: tfFile?.gridId || "",
        tfSha256: tfFile?.sha256 || "",
        tfSize: tfFile?.size || 0,
        ownerId: image.ownerId || "",
      };

      // 找到所在集合
      const containingItems = playCollectionItems.filter((item) => item.imageId === image.id);
      problem.inCollections = containingItems.map((item) => {
        const collection = playCollections.find((c) => c.id === item.collectionId);
        return {
          collectionId: item.collectionId,
          collectionName: collection?.name || "(已删除)",
          enabled: item.enabled,
        };
      });

      if (!hasE6Asset && (!tfFile || !tfFile.gridId)) {
        problems.push(problem);
      }
    }

    if (targetImageId) {
      const allProblems = problems;
      console.log(`\n--- 图片 ${targetImageId} 详情 ---`);

      const image = imageAssets.find((i) => i.id === targetImageId);
      if (!image) {
        console.log(`  ❌ 图片 ${targetImageId} 在 imageAssets 中不存在！`);
        process.exit(1);
      }

      console.log(`  图片记录:`);
      console.log(`    id: ${image.id}`);
      console.log(`    originalName: ${image.originalName || "(空)"}`);
      console.log(`    sourceType: ${image.sourceType || "(空)"}`);
      console.log(`    sourcePath: ${image.sourcePath || "(空)"}`);
      console.log(`    originalTfFileId: ${image.originalTfFileId || "(空)"}`);
      console.log(`    tfFileId: ${image.tfFileId || "(空)"}`);
      console.log(`    sha256: ${image.sha256 || "(空)"}`);
      console.log(`    status: ${image.status || "(空)"}`);
      console.log(`    e6ConvertStatus: ${image.e6ConvertStatus || "(空)"}`);
      console.log(`    e6ConvertError: ${image.e6ConvertError || "(空)"}`);
      console.log(`    createdAt: ${image.createdAt || "(空)"}`);
      console.log(`    updatedAt: ${image.updatedAt || "(空)"}`);

      const originalTfId = String(image.originalTfFileId || image.tfFileId || "");
      const tfFile = tfFiles.find((f) => f.id === originalTfId || f.id === image.tfFileId);

      if (tfFile) {
        console.log(`\n  TF文件记录:`);
        console.log(`    id: ${tfFile.id}`);
        console.log(`    name: ${tfFile.name || "(空)"}`);
        console.log(`    originalName: ${tfFile.originalName || "(空)"}`);
        console.log(`    gridId: ${tfFile.gridId || "(空)"}`);
        console.log(`    sha256: ${tfFile.sha256 || "(空)"}`);
        console.log(`    size: ${tfFile.size || 0}`);
        console.log(`    mime: ${tfFile.mime || "(空)"}`);
        console.log(`    category: ${tfFile.category || "(空)"}`);
        console.log(`    createdAt: ${tfFile.createdAt || "(空)"}`);

        if (tfFile.gridId) {
          try {
            const bucket = await getGridBucket("tf_files");
            const gridId = new ObjectId(tfFile.gridId);
            const files = await bucket.find({ _id: gridId }).toArray();
            if (files.length > 0) {
              console.log(`\n  MongoDB GridFS: ✅ 文件存在`);
              console.log(`    filename: ${files[0].filename || "(空)"}`);
              console.log(`    length: ${files[0].length || 0}`);
              console.log(`    uploadDate: ${files[0].uploadDate || "(空)"}`);
            } else {
              console.log(`\n  MongoDB GridFS: ❌ 文件不存在！（gridId=${tfFile.gridId}）`);
            }
          } catch (error) {
            console.log(`\n  MongoDB GridFS: ❌ 查询失败: ${error.message}`);
          }
        } else {
          console.log(`\n  MongoDB GridFS: ⚠️  gridId 为空，无法查询`);
        }
      } else {
        console.log(`\n  TF文件记录: ❌ 不存在！`);
        console.log(`    搜索的 originalTfFileId: "${image.originalTfFileId || "(空)"}"`);
        console.log(`    搜索的 tfFileId: "${image.tfFileId || "(空)"}"`);

        // 尝试用 sha256 查找
        if (image.sha256) {
          const tfBySha256 = tfFiles.find((f) => f.sha256 === image.sha256);
          if (tfBySha256) {
            console.log(`    ⚠️  通过 sha256 找到匹配的 TF 文件: ${tfBySha256.id}`);
            console.log(`    gridId: ${tfBySha256.gridId || "(空)"}`);
          }
        }
      }

      // 所在的集合
      const containingItems = playCollectionItems.filter((item) => item.imageId === targetImageId);
      if (containingItems.length > 0) {
        console.log(`\n  所在播放集合:`);
        containingItems.forEach((item) => {
          const col = playCollections.find((c) => c.id === item.collectionId);
          console.log(`    - ${item.collectionId} "${col?.name || '(已删除)'}" enabled=${item.enabled}`);
        });
      } else {
        console.log(`\n  所在播放集合: 无`);
      }

      // E6 asset 状态
      const relatedE6 = e6Assets.filter((a) => a.imageId === targetImageId);
      if (relatedE6.length > 0) {
        console.log(`\n  关联的 E6 Assets:`);
        relatedE6.forEach((a) => {
          console.log(`    - ${a.id}`);
          console.log(`      status: ${a.convertStatus || "(空)"}`);
          console.log(`      ditherMode: ${a.ditherMode || "(空)"}`);
          console.log(`      binaryTfFileId: ${a.binaryTfFileId || "(空)"}`);
          console.log(`      previewTfFileId: ${a.previewTfFileId || "(空)"}`);
          console.log(`      binarySha256: ${a.binarySha256 || "(空)"}`);
          console.log(`      createdAt: ${a.createdAt || "(空)"}`);
        });
      } else {
        console.log(`\n  关联的 E6 Assets: 无`);
      }

      // 结论
      console.log(`\n${"-".repeat(70)}`);
      console.log(`诊断结论:`);
      if (!image.originalTfFileId && !image.tfFileId) {
        console.log(`  ❌ 图片没有 originalTfFileId 和 tfFileId，原图引用完全丢失`);
        console.log(`  💡 建议：重新上传该图片，或从集合中移除该图片`);
      } else if (!tfFile) {
        console.log(`  ❌ TF文件记录 " ${originalTfId}" 不存在于 tfFiles 表中`);
        console.log(`  💡 建议：TF文件记录可能被删除。如MongoDB中仍有GridFS文件，可重建TF记录`);
      } else if (!tfFile.gridId) {
        console.log(`  ❌ TF文件记录存在但 gridId 为空，GridFS文件已丢失`);
        console.log(`  💡 建议：重新上传该图片`);
      } else {
        console.log(`  ❌ GridFS文件 ${tfFile.gridId} 不存在`);
        console.log(`  💡 建议：重新上传该图片`);
      }
      console.log("-".repeat(70));

    } else {
      // 扫描全部
      console.log(`\n--- 全部缺失原图的图片 (共 ${problems.length} 张) ---`);
      if (problems.length === 0) {
        console.log(`  ✅ 所有图片都有可用的原图`);
      } else {
        problems.forEach((p) => {
          const status = p.tfFileExists
            ? (p.tfGridId ? `✅ GridFS有文件(gridId=${p.tfGridId})` : `❌ gridId为空`)
            : `❌ TF记录不存在(originalTfFileId=${p.originalTfFileId || "(空)"})`;
          console.log(`  ${p.imageId} | ${p.originalName || "(无名称)"} | ${status}`);
          if (p.inCollections.length) {
            p.inCollections.forEach((c) => {
              console.log(`    ↳ 集合: ${c.collectionId} "${c.collectionName}"`);
            });
          }
        });
      }
    }
  } catch (error) {
    console.error(`\n诊断失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }

  process.exit(0);
}

main();
