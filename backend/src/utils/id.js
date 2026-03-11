const { randomUUID } = require("crypto");

function createId(prefix = "id") {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

module.exports = createId;
