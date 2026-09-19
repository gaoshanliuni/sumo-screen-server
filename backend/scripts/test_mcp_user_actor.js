/* eslint-disable no-console */
const assert = require("assert");

const storePath = require.resolve("../src/db/store");
let state = null;

function makeState() {
  const now = new Date().toISOString();
  return {
    users: [
      { id: "u_1", username: "alice", role: "user", status: "enabled" },
      { id: "u_2", username: "bob", role: "user", status: "enabled" },
    ],
    devices: [
      {
        id: "dev_user_1",
        ownerId: "u_1",
        displayName: "Alice E6",
        type: "e6-color-frame",
        bindState: "bound",
        status: "enabled",
        online: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "dev_user_2",
        ownerId: "u_2",
        displayName: "Bob E6",
        type: "e6-color-frame",
        bindState: "bound",
        status: "enabled",
        online: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    playCollections: [],
    playCollectionItems: [],
    imageAssets: [],
    remoteCommandAcks: [],
    operationLogs: [],
  };
}

require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: {
    readDB: async () => state,
    updateDB: async (mutator) => mutator(state),
  },
};

delete process.env.MCP_ROLE;
delete process.env.MCP_USER_ID;
delete process.env.MCP_USER_TOKEN;

const { handleJsonRpc } = require("../src/mcp/server");
const { signToken } = require("../src/utils/jwt");

function parseToolResult(response) {
  assert.ifError(response.error);
  return JSON.parse(response.result.content[0].text);
}

async function rpc(method, params = {}, context = {}) {
  return handleJsonRpc({ jsonrpc: "2.0", id: Math.floor(Math.random() * 100000), method, params }, context);
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[failed] ${name}: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}

async function main() {
  state = makeState();

  await run("MCP context actor limits tools to the current user", async () => {
    const own = parseToolResult(
      await rpc(
        "tools/call",
        { name: "ink_device_get_display_state", arguments: { deviceName: "Alice E6" } },
        { actor: { role: "user", userId: "u_1", username: "alice" } }
      )
    );
    assert.strictEqual(own.ok, true);
    assert.strictEqual(own.data.device.id, "dev_user_1");

    const foreign = parseToolResult(
      await rpc(
        "tools/call",
        { name: "ink_device_get_display_state", arguments: { deviceName: "Bob E6" } },
        { actor: { role: "user", userId: "u_1", username: "alice" } }
      )
    );
    assert.strictEqual(foreign.ok, false);
    assert.match(foreign.message, /设备不存在|无权限/);
  });

  await run("MCP user token resolves actor and avoids default admin fallback", async () => {
    const token = signToken({ role: "user", userId: "u_2", username: "bob" });
    const result = parseToolResult(
      await rpc(
        "tools/call",
        { name: "ink_device_get_display_state", arguments: { deviceName: "Bob E6" } },
        { userToken: token }
      )
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.device.id, "dev_user_2");
  });

  await run("MCP without actor is a restricted user, not admin", async () => {
    const result = parseToolResult(
      await rpc("tools/call", { name: "ink_device_get_display_state", arguments: { deviceName: "Alice E6" } })
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /设备不存在|无权限/);
  });

  if (process.exitCode) {
    throw new Error("MCP user actor test failed");
  }
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
