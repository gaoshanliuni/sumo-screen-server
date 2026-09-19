const { createAlbumSourceService } = require("../../services/album/album_source.service");
const { createAlbumProvider } = require("../../services/album/provider_registry.service");
const {
  DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC,
  createPlayCollectionService,
} = require("../../services/play_collection.service");

const sourceService = createAlbumSourceService();
const collectionService = createPlayCollectionService();

function text(value) {
  return String(value || "").trim();
}

function normalizeLimit(value, fallback, max) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function buildImportedMap(state, sourceId) {
  const map = new Map();
  (state.imageAssets || [])
    .filter((item) => item.sourceId === sourceId && item.sourcePath)
    .forEach((item) => {
      map.set(item.sourcePath, item);
    });
  return map;
}

function compactSource(source = {}) {
  return {
    id: text(source.id),
    name: text(source.name),
    providerType: text(source.providerType),
    baseUrl: text(source.baseUrl),
    rootPath: text(source.rootPath || "/"),
    isPublic: source.isPublic === true,
    isEnabled: source.isEnabled !== false,
    lastTestStatus: text(source.lastTestStatus),
    lastTestMessage: text(source.lastTestMessage),
    updatedAt: text(source.updatedAt),
  };
}

function compactCollection(collection = {}) {
  return {
    id: text(collection.id),
    name: text(collection.name),
    description: text(collection.description),
    slideIntervalSec: Number(collection.slideIntervalSec || DEFAULT_PLAY_COLLECTION_SLIDE_INTERVAL_SEC),
    loopEnabled: collection.loopEnabled !== false,
    shuffleEnabled: collection.shuffleEnabled === true,
    offlineSyncEnabled: collection.offlineSyncEnabled !== false,
    itemCount: Number(collection.itemCount || 0),
    updatedAt: text(collection.updatedAt),
  };
}

module.exports = [
  {
    name: "ink_album_source_list",
    title: "查询相册来源",
    description: "查询当前用户可见的 OpenList、NAS、本地上传等相册来源。调用建议：用户要找来源、浏览目录或导入照片前先用它拿 sourceId。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "按来源名称、地址或根路径过滤；不填返回全部可见来源。" },
        includeDisabled: { type: "boolean", default: false, description: "是否包含停用来源。" },
      },
    },
    handler: async ({ state, params, actor }) => {
      const keyword = text(params.keyword).toLowerCase();
      const sources = sourceService
        .listSources(state, actor)
        .filter((source) => params.includeDisabled || source.isEnabled !== false)
        .filter((source) => {
          if (!keyword) return true;
          return [source.name, source.baseUrl, source.rootPath, source.providerType]
            .map((item) => text(item).toLowerCase())
            .some((item) => item.includes(keyword));
        })
        .map(compactSource);
      return { sources, total: sources.length };
    },
  },
  {
    name: "ink_album_source_save",
    title: "新建或修改相册来源",
    description: "保存相册来源配置。调用建议：新建时不要传 sourceId；修改已有来源时传 sourceId。公开来源、凭据和地址会影响真实数据访问，需用户确认。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["name", "providerType"],
      properties: {
        sourceId: { type: "string", description: "已有来源 ID；不填则新建。" },
        providerType: { type: "string", enum: ["openlist", "nas_local", "local_upload", "tf_file"], description: "来源类型。" },
        name: { type: "string", description: "来源名称。" },
        description: { type: "string", description: "来源说明。" },
        baseUrl: { type: "string", description: "OpenList 站点地址；providerType=openlist 时必填。" },
        rootPath: { type: "string", description: "来源根路径，例如 /photos。" },
        username: { type: "string", description: "OpenList 用户名，可选。" },
        password: { type: "string", description: "OpenList 密码；留空不修改旧密码。" },
        token: { type: "string", description: "OpenList token；留空不修改旧 token。" },
        isPublic: { type: "boolean", description: "是否公开给其他用户可见。" },
        isEnabled: { type: "boolean", description: "是否启用来源。" },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ params, actor, updateState }) => {
      if (typeof updateState !== "function") throw new Error("updateState unavailable");
      let saved = null;
      await updateState((draft) => {
        saved = params.sourceId
          ? sourceService.patchSource(draft, actor, params.sourceId, params)
          : sourceService.createSource(draft, actor, params);
      });
      return compactSource(saved);
    },
  },
  {
    name: "ink_album_source_delete",
    title: "删除相册来源",
    description: "删除相册来源入口。调用建议：只删除来源配置，不删除已经导入集合的图片；执行前向用户确认来源名称和 ID。",
    riskLevel: "destructive",
    inputSchema: {
      type: "object",
      required: ["sourceId"],
      properties: {
        sourceId: { type: "string", description: "要删除的来源 ID。" },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ params, actor, updateState }) => {
      if (typeof updateState !== "function") throw new Error("updateState unavailable");
      let output = null;
      await updateState((draft) => {
        output = sourceService.deleteSource(draft, actor, params.sourceId);
      });
      return output;
    },
  },
  {
    name: "ink_album_source_browse",
    title: "浏览相册来源目录",
    description: "浏览来源目录并返回文件夹、图片缩略图和导入状态。调用建议：用户要从 OpenList/NAS 选图片时，先列来源，再用 sourceId 和 path 逐级浏览。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      required: ["sourceId"],
      properties: {
        sourceId: { type: "string", description: "来源 ID。" },
        path: { type: "string", default: "/", description: "要浏览的目录路径。" },
        page: { type: "integer", minimum: 1, default: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100, default: 60 },
        refresh: { type: "boolean", default: false, description: "是否刷新来源缓存。" },
      },
    },
    handler: async ({ state, params, actor }) => {
      const source = sourceService.getSource(state, params.sourceId, actor);
      const credential = sourceService.getCredentialForProvider(state, source.id, actor);
      const provider = createAlbumProvider(source);
      const result = await provider.listDir(source, credential, text(params.path || source.rootPath || "/") || "/", {
        page: params.page || 1,
        pageSize: normalizeLimit(params.pageSize, 60, 100),
        refresh: params.refresh === true,
        importedMap: buildImportedMap(state, source.id),
      });
      return result;
    },
  },
  {
    name: "ink_collection_save",
    title: "新建或修改播放集合",
    description: "保存 E6/墨水屏播放集合。调用建议：新建不传 collectionId；修改传 collectionId；切换间隔使用秒，若用户说分钟需换算为分钟*60。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        collectionId: { type: "string", description: "已有集合 ID；不填则新建。" },
        name: { type: "string", description: "集合名称。" },
        description: { type: "string", description: "集合说明。" },
        slideIntervalSec: { type: "integer", minimum: 5, maximum: 86400, description: "切换间隔秒数。" },
        loopEnabled: { type: "boolean", description: "是否循环播放。" },
        shuffleEnabled: { type: "boolean", description: "是否随机播放。" },
        offlineSyncEnabled: { type: "boolean", description: "是否离线同步。" },
        targetDeviceType: { type: "string", description: "目标设备类型，E6 使用 e6-color-frame。" },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ params, actor, updateState }) => {
      if (typeof updateState !== "function") throw new Error("updateState unavailable");
      let saved = null;
      await updateState((draft) => {
        saved = params.collectionId
          ? collectionService.patchCollection(draft, actor, params.collectionId, params)
          : collectionService.createCollection(draft, actor, params);
      });
      return compactCollection(saved);
    },
  },
  {
    name: "ink_collection_delete",
    title: "删除播放集合",
    description: "删除播放集合及其播放关系。调用建议：删除前明确告知用户不会删除原始图片，但会移除集合里的播放关系。",
    riskLevel: "destructive",
    inputSchema: {
      type: "object",
      required: ["collectionId"],
      properties: {
        collectionId: { type: "string", description: "要删除的集合 ID。" },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ params, actor, updateState }) => {
      if (typeof updateState !== "function") throw new Error("updateState unavailable");
      let output = null;
      await updateState((draft) => {
        output = collectionService.deleteCollection(draft, actor, params.collectionId);
      });
      return output;
    },
  },
  {
    name: "ink_collection_set_items",
    title: "设置集合图片",
    description: "替换集合中的图片列表。调用建议：删除单张图片时先读集合详情，再传移除该 imageId 后的完整 items；新增图片需先通过导入/上传接口得到 imageId。",
    riskLevel: "write",
    inputSchema: {
      type: "object",
      required: ["collectionId", "items"],
      properties: {
        collectionId: { type: "string", description: "集合 ID。" },
        items: {
          type: "array",
          description: "完整图片列表；每项至少包含 imageId，可带 sortOrder。",
          items: {
            type: "object",
            required: ["imageId"],
            properties: {
              imageId: { type: "string" },
              sortOrder: { type: "integer" },
            },
          },
        },
        confirm: { type: "boolean", description: "用户确认后传 true。" },
      },
    },
    handler: async ({ params, actor, updateState }) => {
      if (typeof updateState !== "function") throw new Error("updateState unavailable");
      let items = null;
      await updateState((draft) => {
        items = collectionService.setItems(draft, actor, params.collectionId, params.items || []);
      });
      return { collectionId: params.collectionId, items };
    },
  },
];
