const fs = require("fs");
const path = require("path");
const HttpError = require("../../utils/httpError");
const { mimeFromName, isImageName } = require("./openlist_provider.service");
const { createConcurrencyLimiter } = require("../../utils/concurrency");

function stripLeadingSeparators(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function hasAbsolutePathIntent(value) {
  const text = String(value || "");
  return /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text);
}

function pathStartsWith(child, parent) {
  const a = process.platform === "win32" ? String(child).toLowerCase() : String(child);
  const b = process.platform === "win32" ? String(parent).toLowerCase() : String(parent);
  return a === b || a.startsWith(`${b}${path.sep}`);
}

function resolveNasLocalPath(source = {}, requestedPath = "/") {
  const rootPath = String(source.rootPath || source.basePath || "").trim();
  if (!rootPath) throw new HttpError(400, "NAS根目录不能为空");
  if (hasAbsolutePathIntent(requestedPath)) {
    throw new HttpError(403, "越权访问NAS目录");
  }

  const root = path.resolve(rootPath);
  const relative = stripLeadingSeparators(requestedPath || ".");
  const resolvedPath = path.resolve(root, relative || ".");
  if (!pathStartsWith(resolvedPath, root)) {
    throw new HttpError(403, "越权访问NAS目录");
  }
  return { root, resolvedPath };
}

function toBrowserPath(relativePath) {
  const text = String(relativePath || "").replace(/\\/g, "/");
  return text ? `/${text.replace(/^\/+/, "")}` : "/";
}

function mapNasEntry(source, currentPath, entry, stat, importedMap = new Map()) {
  const childPath = toBrowserPath(path.posix.join(String(currentPath || "/"), entry.name));
  const isDir = stat.isDirectory();
  const imported = importedMap.get(childPath) || null;
  const sourceId = String(source.id || "");
  const queryPath = encodeURIComponent(childPath);
  return {
    sourceId,
    path: childPath,
    name: entry.name,
    type: isDir ? "dir" : "file",
    mime: isDir ? "" : mimeFromName(entry.name),
    size: isDir ? 0 : Number(stat.size || 0),
    modifiedAt: stat.mtime ? stat.mtime.toISOString() : "",
    thumbnailUrl: isDir ? "" : `/api/album-sources/${encodeURIComponent(sourceId)}/thumbnail?path=${queryPath}`,
    previewUrl: isDir ? "" : `/api/album-sources/${encodeURIComponent(sourceId)}/preview?path=${queryPath}`,
    rawUrl: "",
    providerThumbnailUrl: "",
    imported: Boolean(imported),
    imageId: imported?.id || "",
    isImage: !isDir && isImageName(entry.name),
  };
}

class NasLocalProvider {
  constructor(options = {}) {
    this.limit = createConcurrencyLimiter(options.maxConcurrent || 8);
  }

  async testConnection(source) {
    const { resolvedPath } = resolveNasLocalPath(source, ".");
    const stat = await fs.promises.stat(resolvedPath);
    if (!stat.isDirectory()) throw new HttpError(400, "NAS根路径不是目录");
    return { ok: true, message: "连接成功" };
  }

  async listDir(source, credential = {}, dirPath = "/", pagination = {}) {
    return this.limit(async () => {
      const page = Math.max(1, Math.floor(Number(pagination.page || 1)));
      const pageSize = Math.max(1, Math.min(200, Math.floor(Number(pagination.pageSize || 100))));
      const browserPath = toBrowserPath(dirPath || "/");
      const { resolvedPath } = resolveNasLocalPath(source, browserPath);
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isDirectory()) throw new HttpError(400, "目标路径不是目录");

      const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-Hans-CN");
      });
      const slice = sorted.slice((page - 1) * pageSize, page * pageSize);
      const items = [];
      for (const entry of slice) {
        const fullPath = path.join(resolvedPath, entry.name);
        // eslint-disable-next-line no-await-in-loop
        const childStat = await fs.promises.stat(fullPath);
        items.push(mapNasEntry(source, browserPath, entry, childStat, pagination.importedMap));
      }
      return {
        sourceId: source.id,
        path: browserPath,
        page,
        pageSize,
        total: sorted.length,
        items,
      };
    });
  }

  async openFileBuffer(source, credential = {}, filePath = "/") {
    return this.limit(async () => {
      const { resolvedPath } = resolveNasLocalPath(source, filePath);
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isFile()) throw new HttpError(400, "目标路径不是文件");
      const buffer = await fs.promises.readFile(resolvedPath);
      return {
        buffer,
        mime: mimeFromName(resolvedPath),
        size: Number(stat.size || buffer.length),
      };
    });
  }
}

module.exports = {
  NasLocalProvider,
  resolveNasLocalPath,
};
