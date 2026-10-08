import { apiRequest } from "./api";

export type AlbumProviderType = "openlist" | "nas_local" | "local_upload" | "tf_file";

export type AlbumSourceConfig = {
  timeoutSec?: number;
  trustSelfSigned?: boolean;
  maxConcurrency?: number;
  thumbnailCacheSec?: number;
  allowedExtensions?: string[];
};

export type AlbumSourceRow = {
  id: string;
  ownerId?: string;
  providerType: AlbumProviderType | string;
  name: string;
  description?: string;
  baseUrl?: string;
  rootPath?: string;
  config?: AlbumSourceConfig;
  username?: string;
  hasPassword?: boolean;
  hasToken?: boolean;
  isPublic?: boolean;
  isEnabled?: boolean;
  lastTestStatus?: string;
  lastTestMessage?: string;
  lastTestAt?: string;
  lastSyncAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AlbumBrowseItem = {
  sourceId: string;
  path: string;
  name: string;
  type: "dir" | "file" | string;
  mime?: string;
  size?: number;
  modifiedAt?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  rawUrl?: string;
  providerThumbnailUrl?: string;
  imported?: boolean;
  imageId?: string;
  isImage?: boolean;
};

export type AlbumBrowseResult = {
  sourceId: string;
  path: string;
  page: number;
  pageSize: number;
  total: number;
  items: AlbumBrowseItem[];
};

export type AlbumImportJobRow = {
  id?: string;
  jobId?: string;
  status?: string;
  total?: number;
  done?: number;
  successCount?: number;
  failedCount?: number;
  message?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  images?: Array<Record<string, any>>;
  importedImages?: Array<Record<string, any>>;
  items?: Array<Record<string, any>>;
  results?: Array<Record<string, any>>;
  [key: string]: any;
};

export type E6ImageTransform = {
  rotateDeg?: number;
  crop?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
};

export type PlayCollectionItemRow = {
  id?: string;
  imageId: string;
  sortOrder?: number;
  name?: string;
  originalName?: string;
  path?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  originalPreviewUrl?: string;
  e6PreviewUrl?: string;
  e6PreviewTfFileId?: string;
  status?: string;
  [key: string]: any;
};

export type PlayCollectionRow = {
  id: string;
  ownerId?: string;
  name: string;
  description?: string;
  playMode?: string;
  slideIntervalSec?: number;
  offlineSyncEnabled?: boolean;
  items?: PlayCollectionItemRow[];
  itemCount?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: any;
};

export type DeviceTypeRow = {
  id: string;
  name: string;
  defaultWidth?: number;
  defaultHeight?: number;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ImageCatalogItem = {
  imageId: string;
  sourceId?: string;
  path?: string;
  name?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  status?: string;
};

function appendQuery(path: string, query: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    const text = String(value ?? "").trim();
    if (text) params.set(key, text);
  });
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function fetchAlbumSources(token: string) {
  return apiRequest<AlbumSourceRow[]>("/api/album-sources", { token });
}

export async function createAlbumSource(token: string, payload: Partial<AlbumSourceRow> & Record<string, any>) {
  return apiRequest<AlbumSourceRow>("/api/album-sources", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export async function patchAlbumSource(token: string, id: string, payload: Partial<AlbumSourceRow> & Record<string, any>) {
  return apiRequest<AlbumSourceRow>(`/api/album-sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    token,
    body: JSON.stringify(payload),
  });
}

export async function deleteAlbumSource(token: string, id: string) {
  return apiRequest<{ id: string }>(`/api/album-sources/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token,
  });
}

export async function testAlbumSource(token: string, id: string) {
  return apiRequest<AlbumSourceRow | { ok?: boolean; message?: string }>(`/api/album-sources/${encodeURIComponent(id)}/test`, {
    method: "POST",
    token,
    body: JSON.stringify({}),
  });
}

export async function browseAlbumSource(
  token: string,
  id: string,
  query: { path?: string; page?: number; pageSize?: number } = {}
) {
  return apiRequest<AlbumBrowseResult>(
    appendQuery(`/api/album-sources/${encodeURIComponent(id)}/browse`, {
      path: query.path || "/",
      page: query.page || 1,
      pageSize: query.pageSize || 60,
    }),
    { token, timeoutMs: 45000 }
  );
}

export async function importAlbumImages(
  token: string,
  payload: {
    sourceId: string;
    paths?: string[];
    items?: Array<{ path: string; name?: string }>;
    targetCollectionId?: string;
    createCollection?: Partial<PlayCollectionRow>;
    dedupe?: boolean;
    autoConvert?: boolean;
    ditherMode?: string;
  }
) {
  return apiRequest<AlbumImportJobRow>("/api/album-imports/images", {
    method: "POST",
    token,
    timeoutMs: 60000,
    body: JSON.stringify(payload),
  });
}

export async function uploadAlbumImages(
  token: string,
  payload: {
    files: File[];
    targetCollectionId?: string;
    createCollectionName?: string;
    slideIntervalSec?: number;
    ownerId?: string;
    autoConvert?: boolean;
    dedupe?: boolean;
    ditherMode?: string;
    imageTransform?: E6ImageTransform;
  }
) {
  const form = new FormData();
  payload.files.forEach((file) => form.append("files", file));
  if (payload.targetCollectionId) form.set("targetCollectionId", payload.targetCollectionId);
  if (payload.createCollectionName) form.set("createCollectionName", payload.createCollectionName);
  if (payload.slideIntervalSec !== undefined) form.set("slideIntervalSec", String(payload.slideIntervalSec));
  if (payload.ownerId) form.set("ownerId", payload.ownerId);
  form.set("autoConvert", payload.autoConvert === false ? "false" : "true");
  form.set("dedupe", payload.dedupe === false ? "false" : "true");
  if (payload.ditherMode) form.set("ditherMode", payload.ditherMode);
  if (payload.imageTransform) form.set("imageTransform", JSON.stringify(payload.imageTransform));
  return apiRequest<{
    collectionId?: string;
    files: Array<{ imageId: string; originalName: string; size: number; mime: string; e6Ready?: boolean; e6Status?: string }>;
    failed?: Array<{ originalName: string; error: string }>;
    successCount: number;
    failedCount: number;
  }>("/api/album-imports/uploads", {
    method: "POST",
    token,
    timeoutMs: 120000,
    body: form,
  });
}

export async function previewE6Images(
  token: string,
  payload: {
    imageIds: string[];
    ditherMode?: string;
    imageTransform?: E6ImageTransform;
  }
) {
  return apiRequest<{
    previews: Array<{
      imageId: string;
      ditherMode: string;
      binaryTfFileId?: string;
      previewTfFileId?: string;
      converterVersion?: string;
      converterEngine?: string;
      imageTransform?: E6ImageTransform;
      transformKey?: string;
      generated?: boolean;
      previewUrl?: string;
      previewDataUrl: string;
    }>;
  }>("/api/album-imports/e6-preview", {
    method: "POST",
    token,
    timeoutMs: 120000,
    body: JSON.stringify(payload),
  });
}

export async function setE6ImageDitherMode(
  token: string,
  payload: {
    imageIds: string[];
    ditherMode: string;
    imageTransform?: E6ImageTransform;
  }
) {
  return apiRequest<{
    count: number;
    updated: Array<{ imageId: string; ditherMode: string; e6Status: string }>;
  }>("/api/album-imports/e6-dither", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export async function fetchAlbumImportJob(token: string, jobId: string) {
  return apiRequest<AlbumImportJobRow>(`/api/album-imports/${encodeURIComponent(jobId)}`, { token });
}

export async function fetchPlayCollections(token: string) {
  return apiRequest<PlayCollectionRow[]>("/api/play-collections", { token });
}

export async function createPlayCollection(token: string, payload: Partial<PlayCollectionRow>) {
  return apiRequest<PlayCollectionRow>("/api/play-collections", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export async function fetchPlayCollection(token: string, id: string) {
  return apiRequest<PlayCollectionRow>(`/api/play-collections/${encodeURIComponent(id)}`, { token });
}

export async function patchPlayCollection(token: string, id: string, payload: Partial<PlayCollectionRow>) {
  return apiRequest<PlayCollectionRow>(`/api/play-collections/${encodeURIComponent(id)}`, {
    method: "PATCH",
    token,
    body: JSON.stringify(payload),
  });
}

export async function deletePlayCollection(token: string, id: string) {
  return apiRequest<{ id: string }>(`/api/play-collections/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token,
  });
}

export async function setPlayCollectionItems(token: string, id: string, items: Array<{ imageId: string; sortOrder: number }>) {
  return apiRequest<PlayCollectionItemRow[]>(`/api/play-collections/${encodeURIComponent(id)}/items`, {
    method: "PUT",
    token,
    body: JSON.stringify({ items }),
  });
}

export async function pushPlayCollection(token: string, id: string, deviceIds: string[]) {
  return apiRequest<Record<string, any>>(`/api/play-collections/${encodeURIComponent(id)}/push`, {
    method: "POST",
    token,
    timeoutMs: 60000,
    body: JSON.stringify({ deviceIds }),
  });
}

export async function pushMergedPlayCollections(
  token: string,
  collectionIds: string[],
  deviceIds: string[],
  options: {
    slideIntervalSec?: number;
    loopEnabled?: boolean;
    offlineSyncEnabled?: boolean;
    dedupe?: boolean;
  } = {}
) {
  return apiRequest<Record<string, any>>("/api/play-collections/merged-push", {
    method: "POST",
    token,
    timeoutMs: 60000,
    body: JSON.stringify({
      collectionIds,
      deviceIds,
      ...options,
    }),
  });
}

export async function fetchAlbumDeviceTypes(token: string) {
  return apiRequest<DeviceTypeRow[]>("/api/device-types", { token });
}

export async function createAlbumDeviceType(token: string, payload: Partial<DeviceTypeRow>) {
  return apiRequest<DeviceTypeRow>("/api/device-types", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export async function fetchAlbumBinaryObjectUrl(token: string, path: string) {
  const headers = new Headers();
  headers.set("Accept", "image/*,*/*;q=0.8");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { headers });
  if (!response.ok) {
    throw new Error(`图片读取失败(${response.status})`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
