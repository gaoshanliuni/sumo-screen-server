#!/usr/bin/env node
require("dotenv").config();
const express = require("express");
const { initStore } = require("../db/store");
const { handleJsonRpc } = require("./server");
const { buildMcpHttpContext, isMcpServiceAuthorized } = require("./http_auth");

const app = express();
app.use(express.json({ limit: "2mb" }));

function requireToken(req, res, next) {
  if (!isMcpServiceAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  return next();
}

app.post("/mcp", requireToken, async (req, res) => {
  const response = await handleJsonRpc(req.body || {}, buildMcpHttpContext(req));
  if (!response) return res.status(202).end();
  return res.json(response);
});

const port = Number(process.env.MCP_PORT || 8899);
initStore()
  .then(() => {
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`[mcp] http listening on ${port}`);
    });
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[mcp] init failed: ${error?.message || error}`);
    process.exit(1);
  });
