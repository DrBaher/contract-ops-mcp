// The VERSION constant (reported in the MCP serverInfo) must match package.json,
// so a release bumping one but not the other fails CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "../contract-ops-mcp.mjs";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

test("VERSION matches package.json version", () => {
  assert.equal(VERSION, pkg.version);
});
