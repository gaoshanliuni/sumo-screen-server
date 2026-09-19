/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const storePath = path.join(__dirname, "../src/db/store.js");
const source = fs.readFileSync(storePath, "utf8");

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

assert(
  source.includes("id: normalizeStringField(payload.id || record.id || \"\")"),
  "payload-only records must merge table record.id back into payload when payload.id is missing"
);
assert(
  source.includes("createdAt: payload.createdAt || fromDbDateTime(record.created_at)") &&
    source.includes("updatedAt: payload.updatedAt || fromDbDateTime(record.updated_at)"),
  "payload-only records must preserve DB timestamps when payload timestamps are missing"
);

console.log("[ok] payload-only record hydration preserves table id and timestamps");
