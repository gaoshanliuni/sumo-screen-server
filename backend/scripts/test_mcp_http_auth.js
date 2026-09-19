const assert = require("assert");

const { buildMcpHttpContext, isMcpServiceAuthorized } = require("../src/mcp/http_auth");

function req(headers = {}) {
  const normalized = {};
  Object.entries(headers).forEach(([key, value]) => {
    normalized[key.toLowerCase()] = value;
  });
  return { headers: normalized };
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
  const env = { MCP_AUTH_TOKEN: "service-token" };
  const userJwt = "user.jwt.token";

  await run("HTTP MCP accepts user JWT when service token is configured but omitted", async () => {
    const request = req({ authorization: `Bearer ${userJwt}` });
    assert.strictEqual(isMcpServiceAuthorized(request, env), true);
    assert.deepStrictEqual(buildMcpHttpContext(request, env), { userToken: userJwt });
  });

  await run("HTTP MCP accepts user JWT plus optional service token", async () => {
    const request = req({ authorization: `Bearer ${userJwt}`, "x-mcp-token": "service-token" });
    assert.strictEqual(isMcpServiceAuthorized(request, env), true);
    assert.deepStrictEqual(buildMcpHttpContext(request, env), { userToken: userJwt });
  });

  await run("HTTP MCP rejects an explicitly wrong service token", async () => {
    const request = req({ authorization: `Bearer ${userJwt}`, "x-mcp-token": "wrong-token" });
    assert.strictEqual(isMcpServiceAuthorized(request, env), false);
  });

  await run("HTTP MCP keeps legacy Authorization service token compatibility", async () => {
    const request = req({ authorization: "Bearer service-token" });
    assert.strictEqual(isMcpServiceAuthorized(request, env), true);
    assert.deepStrictEqual(buildMcpHttpContext(request, env), { userToken: "" });
  });

  if (process.exitCode) throw new Error("MCP HTTP auth test failed");
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
