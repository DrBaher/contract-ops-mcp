import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "contract-ops-mcp.mjs");

async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
  const client = new Client({ name: "smoke", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

test("lists the curated tools + escape hatches", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["extract_contract", "lint_contract", "compare_versions", "fill_template",
    "review_nda", "contract_vault_due", "verify_signature", "catalog", "run", "suite_status"]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  // Signing-mutation tools must NOT be exposed.
  assert.ok(!names.some((n) => /create|^sign_/.test(n)), "no signature-mutating tools");
  await client.close();
});

test("suite_status reports all nine CLIs", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "suite_status", arguments: {} });
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.clis.length, 9);
  assert.ok("baseDir" in data);
  await client.close();
});

test("a tool on a missing CLI returns a clear install hint (not a crash)", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "catalog", arguments: { cli: "extract" } });
  assert.match(res.content[0].text, /not installed|pipx install extract-cli/);
  assert.equal(res.isError, true);
  await client.close();
});

test("base-dir lockdown rejects a path escape", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "lint_contract", arguments: { path: "../../etc/passwd" } });
  assert.match(res.content[0].text, /escapes the allowed base dir/);
  assert.equal(res.isError, true);
  await client.close();
});
