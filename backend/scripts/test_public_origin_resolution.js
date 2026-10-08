/* eslint-disable no-console */
const assert = require("assert");
const { resolvePublicBaseUrl, isPrivateHost, requestOrigin } = require("../src/utils/publicOrigin");

function req({ protocol = "http", host = "", forwardedProto = "", forwardedHost = "" } = {}) {
  return {
    protocol,
    headers: {
      host,
      "x-forwarded-proto": forwardedProto,
      "x-forwarded-host": forwardedHost,
    },
    get(name) {
      if (String(name).toLowerCase() === "host") return host;
      return "";
    },
  };
}

assert.strictEqual(isPrivateHost("https://192.168.50.46:8890"), true);
assert.strictEqual(isPrivateHost("https://epd.gaoshanliuni.top:19999"), false);
assert.strictEqual(
  requestOrigin(req({ host: "127.0.0.1:8890", forwardedProto: "https", forwardedHost: "epd.gaoshanliuni.top:19999" })),
  "https://epd.gaoshanliuni.top:19999"
);
assert.strictEqual(
  resolvePublicBaseUrl(
    req({ host: "127.0.0.1:8890", forwardedProto: "https", forwardedHost: "epd.gaoshanliuni.top:19999" }),
    "https://192.168.50.46:8890"
  ),
  "https://epd.gaoshanliuni.top:19999"
);
assert.strictEqual(
  resolvePublicBaseUrl(req({ protocol: "https", host: "epd.gaoshanliuni.top:19999" }), "https://cdn.example.com"),
  "https://cdn.example.com"
);

console.log("[ok] public origin resolution avoids private configured origin for public requests");
