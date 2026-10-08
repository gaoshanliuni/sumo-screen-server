const assert = require('assert');
const { collectMissingE6Jobs } = require('../src/services/e6/e6_asset_retry.service');
const state = {
  devices: [{ id: 'dev_e6', ownerId: 'u_admin', type: 'e6-color-frame' }],
  playCollections: [{ id: 'col_old', ownerId: 'u_admin', targetDeviceType: 'e6-color-frame' }],
  playCollectionItems: [{ id: 'item_1', collectionId: 'col_old', imageId: 'img_missing_meta', enabled: true }],
  imageAssets: [],
  e6RenderedAssets: [{ id: 'e6_old', imageId: 'img_missing_meta', binaryTfFileId: 'tf_e6', convertStatus: 'ready' }],
  tfFiles: [{ id: 'tf_e6', gridId: 'grid', size: 192000 }],
};
const out = collectMissingE6Jobs(state, { role: 'admin', userId: 'u_admin' }, 'col_old', ['dev_e6']);
assert.deepStrictEqual(out.jobs, []);
assert.deepStrictEqual(out.brokenImages, []);
console.log('[ok] orphan E6 asset is not treated as missing original');
