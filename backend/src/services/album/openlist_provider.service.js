const path = require("path");
const HttpError = require("../../utils/httpError");
const { createConcurrencyLimiter } = require("../../utils/concurrency");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif"]);

function joinRemotePath(parent, name) {
  const base = String(parent || "/").replace(/\\/g, "/");
  const child = String(name || "").replace(/\\/g, "/");
  const joined = path.posix.join(base || "/", child);
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function mimeFromName(name = "") {
  const ext = path.extname(String(name || "").toLowerCase());
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return IMAGE_EXTENSIONS.has(ext) ? "image/*" : "application/octet-stream";
}

function isImageName(name = "") {
  return IMAGE_EXTENSIONS.has(path.extname(String(name || "").toLowerCase()));
}

function normalizePage(value, fallback = 1) {
  const n = Math.floor(Number(value || fallback));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizePageSize(value, fallback = 100) {
  const n = Math.floor(Number(value || fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(200, n));
}

function mapOpenListEntry(source, currentPath, entry = {}, importedMap = new Map()) {
  const name = String(entry.name || entry.title || "").trim();
  const rawIsDir =
    entry.is_dir !== undefined
      ? entry.is_dir
      : entry.isDir !== undefined
        ? entry.isDir
        : entry.type === "folder";
  const isDir = Boolean(rawIsDir);
  const itemPath = joinRemotePath(currentPath || source.rootPath || "/", name);
  const imported = importedMap.get(itemPath) || null;
  const sourceId = String(source.id || "");
  const queryPath = encodeURIComponent(itemPath);
  return {
    sourceId,
    path: itemPath,
    name,
    type: isDir ? "dir" : "file",
    mime: isDir ? "" : mimeFromName(name),
    size: Number(entry.size || 0),
    modifiedAt: String(entry.modified || entry.modifiedAt || entry.updated_at || ""),
    thumbnailUrl: isDir ? "" : `/api/album-sources/${encodeURIComponent(sourceId)}/thumbnail?path=${queryPath}`,
    previewUrl: isDir ? "" : `/api/album-sources/${encodeURIComponent(sourceId)}/preview?path=${queryPath}`,
    rawUrl: String(entry.raw_url || entry.rawUrl || entry.url || ""),
    providerThumbnailUrl: String(entry.thumb || entry.thumbnail || ""),
    imported: Boolean(imported),
    imageId: imported?.id || "",
    isImage: !isDir && isImageName(name),
  };
}

class OpenListProvider {
  constructor(options = {}) {
    this.fetcher = options.fetcher || fetch;
    this.limit = createConcurrencyLimiter(options.maxConcurrent || 16);
    this.tokenCache = new Map();
  }

  buildUrl(source, pathname) {
    const base = String(source.baseUrl || "").replace(/\/+$/, "");
    if (!base) throw new HttpError(400, "OpenList站点地址不能为空");
    return `${base}${pathname}`;
  }

  async fetchJson(source, pathname, { method = "POST", body = {}, token = "", timeoutMs = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || 20000)));
    try {
      const headers = { Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (token) headers.Authorization = token;
      const res = await this.fetcher(this.buildUrl(source, pathname), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch (_) {
        throw new HttpError(502, "OpenList响应不是JSON");
      }
      if (!res.ok || Number(payload.code || 200) >= 400) {
        throw new HttpError(res.status || 502, payload.message || payload.msg || "OpenList请求失败", payload);
      }
      return payload.data !== undefined ? payload.data : payload;
    } catch (error) {
      if (error?.name === "AbortError") throw new HttpError(504, "OpenList请求超时");
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, error?.message || "OpenList请求失败");
    } finally {
      clearTimeout(timer);
    }
  }

  async resolveToken(source, credential = {}) {
    const directToken = String(credential.token || "").trim();
    if (directToken) return directToken;
    const username = String(credential.username || "").trim();
    const password = String(credential.password || "").trim();
    if (!username || !password) return "";
    const cacheKey = `${source.id || source.baseUrl}|${username}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expireAt > Date.now()) return cached.token;
    const data = await this.fetchJson(source, "/api/auth/login", {
      body: { username, password },
      timeoutMs: Number(source.config?.timeoutSec || 20) * 1000,
    });
    const token = String(data.token || data.access_token || "");
    if (!token) throw new HttpError(502, "OpenList登录未返回token");
    this.tokenCache.set(cacheKey, { token, expireAt: Date.now() + 50 * 60 * 1000 });
    return token;
  }

  async testConnection(source, credential = {}) {
    const token = await this.resolveToken(source, credential);
    await this.listDir(source, credential, source.rootPath || "/", { page: 1, pageSize: 1, token });
    return { ok: true, message: "连接成功" };
  }

  async listDir(source, credential = {}, dirPath = "/", pagination = {}) {
    const token = pagination.token || (await this.resolveToken(source, credential));
    const page = normalizePage(pagination.page, 1);
    const pageSize = normalizePageSize(pagination.pageSize, 100);
    const targetPath = String(dirPath || source.rootPath || "/").replace(/\\/g, "/") || "/";
    const data = await this.limit(() =>
      this.fetchJson(source, "/api/fs/list", {
        token,
        body: {
          path: targetPath,
          password: String(credential.pathPassword || ""),
          page,
          per_page: pageSize,
          refresh: Boolean(pagination.refresh),
        },
        timeoutMs: Number(source.config?.timeoutSec || 20) * 1000,
      })
    );
    const content = Array.isArray(data.content) ? data.content : Array.isArray(data.files) ? data.files : [];
    const total = Number(data.total || data.count || content.length);
    return {
      sourceId: source.id,
      path: targetPath,
      page,
      pageSize,
      total,
      items: content.map((entry) => mapOpenListEntry(source, targetPath, entry, pagination.importedMap)),
    };
  }

  async getFileMeta(source, credential = {}, filePath = "/") {
    const token = await this.resolveToken(source, credential);
    const data = await this.limit(() =>
      this.fetchJson(source, "/api/fs/get", {
        token,
        body: { path: filePath, password: String(credential.pathPassword || "") },
        timeoutMs: Number(source.config?.timeoutSec || 20) * 1000,
      })
    );
    return data;
  }

  async getDownloadLink(source, credential = {}, filePath = "/") {
    const token = await this.resolveToken(source, credential);
    const data = await this.limit(() =>
      this.fetchJson(source, "/api/fs/link", {
        token,
        body: { path: filePath, password: String(credential.pathPassword || "") },
        timeoutMs: Number(source.config?.timeoutSec || 20) * 1000,
      })
    );
    return String(data.url || data.raw_url || data.link || "");
  }

  async openFileBuffer(source, credential = {}, filePath = "/") {
    const url = await this.getDownloadLink(source, credential, filePath);
    if (!url) throw new HttpError(404, "OpenList文件下载链接不存在");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(source.config?.timeoutSec || 20) * 1000);
    try {
      const res = await this.fetcher(url, { signal: controller.signal });
      if (!res.ok) throw new HttpError(res.status, "OpenList文件下载失败");
      const ab = await res.arrayBuffer();
      return {
        buffer: Buffer.from(ab),
        mime: res.headers.get("content-type") || mimeFromName(filePath),
        size: Number(res.headers.get("content-length") || 0),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  OpenListProvider,
  mapOpenListEntry,
  mimeFromName,
  isImageName,
};
