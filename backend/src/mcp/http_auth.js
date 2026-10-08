function bearerToken(raw) {
  return String(raw || "").replace(/^Bearer\s+/i, "").trim();
}

function header(req, name) {
  return req?.headers?.[name] || req?.headers?.[String(name || "").toLowerCase()] || "";
}

function serviceToken(env = process.env) {
  return String(env.MCP_AUTH_TOKEN || "").trim();
}

function isMcpServiceAuthorized(req, env = process.env) {
  const expected = serviceToken(env);
  if (!expected) return true;

  const explicitServiceToken = bearerToken(header(req, "x-mcp-token"));
  if (explicitServiceToken) return explicitServiceToken === expected;

  const authorizationToken = bearerToken(header(req, "authorization"));
  if (authorizationToken === expected) return true;

  return true;
}

function buildMcpHttpContext(req, env = process.env) {
  const expected = serviceToken(env);
  const authorizationToken = bearerToken(header(req, "authorization"));
  return {
    userToken: authorizationToken && authorizationToken !== expected ? authorizationToken : "",
  };
}

module.exports = {
  buildMcpHttpContext,
  isMcpServiceAuthorized,
};
