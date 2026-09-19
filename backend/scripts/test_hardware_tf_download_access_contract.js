/* eslint-disable no-console */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const routeSource = fs.readFileSync(path.join(__dirname, "../src/routes/hardware.routes.js"), "utf8");

assert.match(routeSource, /function canDeviceAccessTfFile\(file, device, db\)/, "download access helper must receive db context");
assert.match(routeSource, /e6RenderedAssets/, "download access helper must check rendered E6 assets");
assert.match(routeSource, /playCollectionItems/, "download access helper must check collection items");
assert.match(routeSource, /currentCollectionId/, "download access helper must allow current assigned collection");
assert.match(routeSource, /lastDisplayCollectionId/, "download access helper must allow last assigned collection");
assert.match(routeSource, /canDeviceAccessTfFile\(file, device, db\)/, "download route must pass db to helper");

console.log("[ok] hardware tf download access contract passed");
