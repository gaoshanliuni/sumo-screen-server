const { createCacheService } = require("./cache.service");

let singleton = null;

function getCache() {
  if (!singleton) {
    singleton = createCacheService();
  }
  return singleton;
}

module.exports = {
  getCache,
};
