const HttpError = require("../../utils/httpError");
const { OpenListProvider } = require("./openlist_provider.service");
const { NasLocalProvider } = require("./nas_provider.service");

function createAlbumProvider(source = {}, options = {}) {
  const type = String(source.providerType || "").trim();
  const maxConcurrent = Number(source.config?.maxConcurrency || options.maxConcurrent || 4);
  if (type === "openlist") {
    return new OpenListProvider({ ...options, maxConcurrent });
  }
  if (type === "nas_local") {
    return new NasLocalProvider({ ...options, maxConcurrent });
  }
  throw new HttpError(400, "该相册来源暂不支持浏览");
}

module.exports = {
  createAlbumProvider,
};
