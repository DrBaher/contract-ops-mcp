// The VERSION constant (reported in the MCP serverInfo) must match package.json,
// so a release bumping one but not the other fails CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "../contract-ops-mcp.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

test("VERSION matches package.json version", () => {
  assert.equal(VERSION, pkg.version);
});

test("server.json + mcpName match package.json (MCP Registry stays in sync)", () => {
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal(server.name, pkg.mcpName);
});
