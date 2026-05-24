// End-to-end tests against a REAL installed suite CLI (contract-lint).
//
// The smoke tests cover the server in isolation (tool listing, base-dir
// lockdown, missing-CLI hints). These go one step further: they spawn the
// server pointed at a real contract-lint install and assert the curated
// tools actually invoke it and parse its output — so a change to a CLI's
// `--catalog`/`--json` shape (or a regression in our arg wiring) fails CI
// instead of silently returning garbage to an agent.
//
// Locally contract-lint usually isn't on PATH, so these skip gracefully.
// CI's `integration` job installs it and runs them for real.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "contract-ops-mcp.mjs");

let lintAvailable = false;
try {
  execFileSync("contract-lint", ["--version"], { stdio: "ignore" });
  lintAvailable = true;
} catch { /* not installed — tests below skip */ }
const skip = lintAvailable ? false : "contract-lint not installed (runs only in CI's integration job)";

// One contract with two known defects: a leftover placeholder and a
// cross-reference to a section that doesn't exist.
const BASE = mkdtempSync(join(tmpdir(), "comcp-int-"));
const FIXTURE = "agreement.md";
writeFileSync(
  join(BASE, FIXTURE),
  "MASTER SERVICES AGREEMENT\n\n" +
    "This Agreement is between [CLIENT_NAME] and Acme Corp.\n\n" +
    "1. Term. As described in Section 9, this is perpetual.\n\n" +
    "2. Fees. The Client shall pay.\n",
);
after(() => rmSync(BASE, { recursive: true, force: true }));

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, CONTRACT_OPS_MCP_BASE_DIR: BASE },
  });
  const client = new Client({ name: "integration", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

test("catalog(lint) returns a well-formed --catalog (shape guard)", { skip }, async () => {
  const client = await connect();
  const res = await client.callTool({ name: "catalog", arguments: { cli: "lint" } });
  assert.ok(!res.isError, res.content[0].text);
  const { result: cat } = JSON.parse(res.content[0].text);
  assert.equal(cat.name, "contract-lint");
  assert.equal(typeof cat.version, "string");
  assert.ok(Array.isArray(cat.commands) || Array.isArray(cat.flags), "catalog must list commands or flags");
  assert.ok(cat.exitCodes && typeof cat.exitCodes === "object", "catalog must document exit codes");
  await client.close();
});

test("lint_contract runs the real CLI and returns structured findings", { skip }, async () => {
  const client = await connect();
  const res = await client.callTool({ name: "lint_contract", arguments: { path: FIXTURE } });
  const data = JSON.parse(res.content[0].text);
  assert.equal(typeof data.exitCode, "number");
  const lint = data.result;
  assert.ok(lint && Array.isArray(lint.findings), "expected structured findings");
  const rules = new Set(lint.findings.map((f) => f.rule));
  assert.ok(rules.has("placeholder"), "should flag the leftover placeholder");
  assert.ok(rules.has("broken-xref"), "should flag the broken cross-reference");
  await client.close();
});

test("suite_status marks an installed CLI as installed:true", { skip }, async () => {
  const client = await connect();
  const res = await client.callTool({ name: "suite_status", arguments: {} });
  const { clis } = JSON.parse(res.content[0].text);
  const lint = clis.find((c) => c.cli === "lint");
  assert.ok(lint, "lint row present");
  assert.equal(lint.installed, true);
  assert.ok(typeof lint.version === "string" && lint.version.length > 0, "reports a version");
  await client.close();
});
