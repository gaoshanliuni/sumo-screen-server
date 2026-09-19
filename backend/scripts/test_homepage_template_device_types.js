/* eslint-disable no-console */
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "1";
process.env.DB_CONNECT_TIMEOUT_MS = process.env.DB_CONNECT_TIMEOUT_MS || "200";
process.env.DB_OP_TIMEOUT_MS = process.env.DB_OP_TIMEOUT_MS || "1000";
process.env.DB_INIT_RETRY_MAX = process.env.DB_INIT_RETRY_MAX || "1";
process.env.DB_RETRY_COOLDOWN_MS = process.env.DB_RETRY_COOLDOWN_MS || "60000";

const assert = require("assert");
const http = require("http");
const app = require("../src/app");
const { updateDB } = require("../src/db/store");
const { signToken } = require("../src/utils/jwt");
const { closeMongoClient } = require("../src/utils/mongo");

async function request(baseUrl, path, { method = "GET", token = "", body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok || Number(payload.code || 0) >= 400) {
    throw new Error(`${method} ${path} -> ${response.status}: ${payload.msg || "failed"}`);
  }
  return payload.data;
}

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = signToken({ role: "user", userId: "u_home_tpl", username: "home-tpl" });

  try {
    await updateDB((draft) => {
      draft.users = Array.isArray(draft.users) ? draft.users : [];
      if (!draft.users.some((item) => item.id === "u_home_tpl")) {
        draft.users.push({ id: "u_home_tpl", username: "home-tpl", role: "user", status: "active" });
      }
      draft.homepageTemplates = [];
    });

    const created = await request(baseUrl, "/api/homepages/templates", {
      method: "POST",
      token,
      body: {
        name: "E6 专用主页",
        type: "custom_html",
        html: "<div>hello</div>",
        targetDeviceTypes: ["e6-color-frame"],
      },
    });

    assert.deepStrictEqual(created.targetDeviceTypes, ["e6-color-frame"]);

    const updated = await request(baseUrl, "/api/homepages/templates", {
      method: "POST",
      token,
      body: {
        id: created.id,
        name: "通用主页",
        type: "custom_html",
        html: "<div>hello</div>",
        targetDeviceTypes: [],
      },
    });
    assert.deepStrictEqual(updated.targetDeviceTypes, []);

    const templates = await request(baseUrl, "/api/homepages/templates", { token });
    const row = templates.find((item) => item.id === created.id);
    assert.ok(row, "updated template should be listed");
    assert.deepStrictEqual(row.targetDeviceTypes, []);

    console.log("[ok] homepage templates preserve target device types");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeMongoClient();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
