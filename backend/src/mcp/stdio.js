#!/usr/bin/env node
require("dotenv").config();
const { initStore } = require("../db/store");
const { handleJsonRpc } = require("./server");

let buffer = Buffer.alloc(0);

function writeMessage(message) {
  if (!message) return;
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function tryReadContentLength() {
  const sep = buffer.indexOf("\r\n\r\n");
  if (sep < 0) return null;
  const header = buffer.slice(0, sep).toString("utf8");
  const match = /content-length:\s*(\d+)/i.exec(header);
  if (!match) return null;
  const length = Number(match[1]);
  const start = sep + 4;
  if (buffer.length < start + length) return null;
  const body = buffer.slice(start, start + length).toString("utf8");
  buffer = buffer.slice(start + length);
  return body;
}

function tryReadLine() {
  const nl = buffer.indexOf("\n");
  if (nl < 0) return null;
  const body = buffer.slice(0, nl).toString("utf8").trim();
  buffer = buffer.slice(nl + 1);
  return body;
}

async function handleBody(body) {
  if (!body) return;
  const message = JSON.parse(body);
  const response = await handleJsonRpc(message, { userToken: process.env.MCP_USER_TOKEN || "" });
  writeMessage(response);
}

async function pump() {
  while (buffer.length) {
    const body = tryReadContentLength() || tryReadLine();
    if (!body) break;
    // eslint-disable-next-line no-await-in-loop
    await handleBody(body);
  }
}

initStore()
  .then(() => {
    process.stdin.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      pump().catch((error) => {
        writeMessage({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: error?.message || String(error) },
        });
      });
    });
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[mcp] init failed: ${error?.message || error}`);
    process.exit(1);
  });
