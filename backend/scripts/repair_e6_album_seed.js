const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const createId = require('../src/utils/id');
const { readDB, updateDB } = require('../src/db/store');
const { getGridBucket } = require('../src/utils/mongo');
const {
  convertImageBufferToE6P4,
  previewE6Buffer,
  DEFAULT_E6_DITHER_MODE,
  E6_CONVERTER_VERSION,
  E6_PACKED4_SIZE,
  e6TransformKey,
  normalizeE6ImageTransform,
} = require('../src/services/e6/e6_converter.service');

function sha256Hex(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function mimeFromPath(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}
async function saveTfBuffer({ ownerId, category = 'photo', originalName, mime, buffer, meta = {} }) {
  const recordId = createId('tf');
  const filename = `${recordId}_${originalName || 'file'}`;
  const hash = sha256Hex(buffer);
  const bucket = await getGridBucket('tf_files');
  const uploadStream = bucket.openUploadStream(filename, {
    contentType: mime || 'application/octet-stream',
    metadata: { ownerId, category, originalName: originalName || filename, sha256: hash, ...meta },
  });
  const gridId = await new Promise((resolve, reject) => {
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(uploadStream.id));
    uploadStream.end(buffer);
  });
  const now = new Date().toISOString();
  return {
    id: recordId,
    ownerId,
    category,
    name: filename,
    originalName: originalName || filename,
    size: buffer.length,
    mime: mime || 'application/octet-stream',
    gridId: String(gridId),
    url: `/api/tf/${recordId}/download`,
    sha256: hash,
    meta,
    createdAt: now,
    updatedAt: now,
  };
}
async function makeImage(ownerId, filePath, index) {
  const buffer = fs.readFileSync(filePath);
  const originalName = path.basename(filePath);
  const mime = mimeFromPath(filePath);
  const imageId = createId('img');
  const imageTransform = normalizeE6ImageTransform({});
  const ditherMode = DEFAULT_E6_DITHER_MODE;
  const originalTf = await saveTfBuffer({
    ownerId,
    category: 'photo',
    originalName,
    mime,
    buffer,
    meta: { sourceType: 'repair_local_upload', sourcePath: filePath },
  });
  console.log(`[repair] converting ${originalName} -> E6 ${ditherMode}`);
  const converted = await convertImageBufferToE6P4(buffer, { fit: 'contain', ditherMode, imageTransform, preview: false });
  const previewBuffer = await previewE6Buffer(converted.buffer);
  const e6Tf = await saveTfBuffer({
    ownerId,
    category: 'photo',
    originalName: `${path.parse(originalName).name}.e6p4`,
    mime: 'application/octet-stream',
    buffer: converted.buffer,
    meta: {
      imageAssetId: imageId,
      deviceType: 'e6-color-frame',
      format: 'e6p4',
      ditherMode: converted.ditherMode,
      dither: converted.dither,
      converterVersion: E6_CONVERTER_VERSION,
      converterEngine: converted.converterEngine,
      imageTransform: converted.imageTransform,
      transformKey: converted.transformKey,
    },
  });
  const previewTf = await saveTfBuffer({
    ownerId,
    category: 'photo',
    originalName: `${path.parse(originalName).name}.e6-preview.png`,
    mime: 'image/png',
    buffer: previewBuffer,
    meta: {
      imageAssetId: imageId,
      deviceType: 'e6-color-frame',
      format: 'e6-preview-png',
      ditherMode: converted.ditherMode,
      dither: converted.dither,
      converterVersion: E6_CONVERTER_VERSION,
      converterEngine: converted.converterEngine,
      imageTransform: converted.imageTransform,
      transformKey: converted.transformKey,
      binarySha256: converted.sha256,
    },
  });
  const now = new Date().toISOString();
  const e6AssetId = createId('e6asset');
  const imageAsset = {
    id: imageId,
    ownerId,
    sourceType: 'repair_local_upload',
    sourceId: 'repair_local_upload',
    sourcePath: filePath,
    originalName,
    mime,
    size: buffer.length,
    sha256: sha256Hex(buffer),
    tfFileId: originalTf.id,
    originalTfFileId: originalTf.id,
    gridId: originalTf.gridId || '',
    thumbnailGridId: '',
    previewGridId: '',
    width: 0,
    height: 0,
    status: 'ready',
    e6AssetId,
    e6ConvertStatus: 'ready',
    e6ConvertError: '',
    e6DitherMode: converted.ditherMode,
    e6ImageTransform: converted.imageTransform,
    e6TransformKey: converted.transformKey,
    createdAt: now,
    updatedAt: now,
  };
  const e6Asset = {
    id: e6AssetId,
    imageId,
    deviceType: 'e6-color-frame',
    width: converted.width,
    height: converted.height,
    colorMode: 'e6_6color',
    previewGridId: previewTf.gridId || '',
    previewTfFileId: previewTf.id,
    binaryGridId: e6Tf.gridId || '',
    binaryTfFileId: e6Tf.id,
    binarySha256: converted.sha256,
    binarySize: E6_PACKED4_SIZE,
    ditherMode: converted.ditherMode,
    dither: converted.dither,
    converterVersion: E6_CONVERTER_VERSION,
    converterEngine: converted.converterEngine,
    imageTransform: converted.imageTransform,
    transformKey: converted.transformKey,
    convertStatus: 'ready',
    createdAt: now,
    updatedAt: now,
  };
  return { imageAsset, e6Asset, tfFiles: [originalTf, e6Tf, previewTf], sortOrder: index + 1 };
}
(async () => {
  const deviceId = process.argv[2] || 'dev_255b348e80b94ec7';
  const files = process.argv.slice(3).filter(Boolean);
  const inputFiles = files.length ? files : [
    'D:\\epde6\\server\\data\\uploads\\1.png',
    'D:\\epde6\\server\\data\\integration_album\\integration_test.png',
  ];
  const existing = inputFiles.filter((file) => fs.existsSync(file));
  if (!existing.length) throw new Error('没有可导入图片文件');
  const snapshot = await readDB();
  const device = (snapshot.devices || []).find((item) => String(item.id) === deviceId);
  if (!device) throw new Error(`设备不存在: ${deviceId}`);
  const ownerId = String(device.ownerId || 'u_admin');
  const staged = [];
  for (let i = 0; i < existing.length; i++) staged.push(await makeImage(ownerId, existing[i], i));
  const collectionId = createId('col');
  const now = new Date().toISOString();
  await updateDB((draft) => {
    draft.tfFiles = Array.isArray(draft.tfFiles) ? draft.tfFiles : [];
    draft.imageAssets = Array.isArray(draft.imageAssets) ? draft.imageAssets : [];
    draft.e6RenderedAssets = Array.isArray(draft.e6RenderedAssets) ? draft.e6RenderedAssets : [];
    draft.playCollections = Array.isArray(draft.playCollections) ? draft.playCollections : [];
    draft.playCollectionItems = Array.isArray(draft.playCollectionItems) ? draft.playCollectionItems : [];
    draft.devices = Array.isArray(draft.devices) ? draft.devices : [];
    for (const item of staged.slice().reverse()) {
      for (const tf of item.tfFiles.slice().reverse()) {
        if (!draft.tfFiles.some((row) => row.id === tf.id)) draft.tfFiles.unshift(tf);
      }
    }
    for (const item of staged.slice().reverse()) {
      if (!draft.imageAssets.some((row) => row.id === item.imageAsset.id)) draft.imageAssets.unshift(item.imageAsset);
      if (!draft.e6RenderedAssets.some((row) => row.id === item.e6Asset.id)) draft.e6RenderedAssets.unshift(item.e6Asset);
    }
    draft.playCollections.unshift({
      id: collectionId,
      ownerId,
      name: `E6在线相册修复-${now.slice(0, 19).replace(/[T:]/g, '-')}`,
      description: '自动修复：由本地图片重新生成可播放 E6 相册',
      coverImageId: staged[0].imageAsset.id,
      playMode: 'slideshow',
      slideIntervalSec: 60,
      loopEnabled: true,
      shuffleEnabled: false,
      offlineSyncEnabled: true,
      targetDeviceType: 'e6-color-frame',
      status: 'enabled',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    staged.forEach((item, index) => {
      draft.playCollectionItems.push({
        id: createId('coli'),
        collectionId,
        imageId: item.imageAsset.id,
        sortOrder: index + 1,
        durationSec: 0,
        enabled: true,
        createdAt: now,
      });
    });
    const target = draft.devices.find((item) => String(item.id) === deviceId);
    if (target) {
      target.currentCollectionId = collectionId;
      target.currentPlayMode = 'album';
      target.lastDisplayCollectionId = collectionId;
      target.lastDisplayItemIndex = 0;
      target.updatedAt = now;
    }
  });
  console.log(JSON.stringify({ ok: true, deviceId, collectionId, images: staged.map((x) => x.imageAsset.id) }, null, 2));
  process.exit(0);
})().catch((error) => { console.error('[repair] failed', error); process.exit(1); });
