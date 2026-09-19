const assert = require('assert');
const { createPlayCollectionService } = require('../src/services/play_collection.service');

const state = {
  users: [{ id: 'u_admin', role: 'admin', status: 'enabled' }],
  devices: [{ id: 'dev_e6', ownerId: 'u_admin', type: 'e6-color-frame' }],
  playCollections: [{ id: 'col_old', ownerId: 'u_admin', name: 'old', targetDeviceType: 'e6-color-frame', version: 1 }],
  playCollectionItems: [{ id: 'item_1', collectionId: 'col_old', imageId: 'img_missing_meta', sortOrder: 1, enabled: true }],
  imageAssets: [],
  e6RenderedAssets: [{
    id: 'e6_old',
    imageId: 'img_missing_meta',
    binaryTfFileId: 'tf_e6',
    binarySha256: 'sha',
    binarySize: 192000,
    convertStatus: 'ready',
    ditherMode: 'waveshare_floyd',
    converterVersion: 'e6-waveshare-v1',
    converterEngine: 'waveshare',
    createdAt: '2026-06-07T00:00:00.000Z',
  }],
  tfFiles: [{ id: 'tf_e6', originalName: 'old.e6p4', size: 192000, sha256: 'sha', gridId: 'grid' }],
};

const svc = createPlayCollectionService({ now: () => '2026-06-24T00:00:00.000Z' });
const manifest = svc.buildManifest(state, { role: 'device', deviceId: 'dev_e6' }, { collectionId: 'col_old', deviceId: 'dev_e6' });
assert.strictEqual(manifest.items.length, 1);
assert.strictEqual(manifest.items[0].imageId, 'img_missing_meta');
assert.strictEqual(manifest.items[0].downloadUrl, '/api/hardware/tf/download/tf_e6');
const list = svc.listItems(state, { role: 'admin', userId: 'u_admin' }, 'col_old');
assert.strictEqual(list[0].status, 'ready');
assert.strictEqual(list[0].isImage, true);
console.log('[ok] orphan E6 asset can keep legacy collection playable');
