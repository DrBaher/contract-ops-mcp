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

// --- Finding #1 regression: the `run` escape hatch must NOT become an
// unguarded signing path. Signing stays human-gated; only sign-cli's
// read/verify subcommands are reachable through this server. These reject
// BEFORE shelling out, so they pass even though `sign` isn't installed in CI's
// smoke job (the gate is the assertion, not the CLI's behavior).
test("run(sign, request create ...) is rejected (signing stays human-gated)", async () => {
  const client = await connect();
  const res = await client.callTool({
    name: "run",
    arguments: { cli: "sign", args: ["request", "create", "--title", "Mutual NDA", "--document", "./nda.pdf"] },
  });
  assert.equal(res.isError, true, "request create must be refused");
  assert.match(res.content[0].text, /human-gated|not a read-only operation/i);
  // Must NOT have reached the CLI (no "not installed" hint = gate fired first).
  assert.doesNotMatch(res.content[0].text, /not installed/);
  await client.close();
});

test("run(sign, request sign ...) is rejected", async () => {
  const client = await connect();
  const res = await client.callTool({
    name: "run",
    arguments: { cli: "sign", args: ["request", "sign", "--request-id", "req_x", "--token", "t"] },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /human-gated|not a read-only operation/i);
  await client.close();
});

test("run(sign, ...) blocks other lifecycle-mutating subcommands (send/approve/sign/cancel)", async () => {
  const client = await connect();
  for (const args of [
    ["sign", "--request-id", "r", "--token", "t"],     // top-level signer sign
    ["approve", "--request-id", "r", "--token", "t"],
    ["request", "send", "--request-id", "r"],
    ["request", "cancel", "--request-id", "r", "--yes", "true"],
    ["request", "run-email"],
    ["signer", "decline"],
    ["db", "rotate-keys"],
    ["pdf", "stamp", "--pdf", "x", "--out", "y"],       // writes a PDF — not read-only
    ["--provider", "local", "request", "create"],       // leading global flag must not bypass the gate
  ]) {
    const res = await client.callTool({ name: "run", arguments: { cli: "sign", args } });
    assert.equal(res.isError, true, `expected refusal for: sign ${args.join(" ")}`);
    assert.match(res.content[0].text, /human-gated|not a read-only operation/i, `wrong error for: sign ${args.join(" ")}`);
  }
  await client.close();
});

test("run(sign, <read-only op>) is allowed through the gate (reaches the CLI / install hint)", async () => {
  const client = await connect();
  // sign isn't installed in the smoke job; the read-only allowlist lets these
  // PASS the gate, so they reach exec() and return the install hint rather than
  // the human-gated refusal. That proves the allowlist isn't a blanket deny.
  for (const args of [
    ["request", "verify-signed-pdf", "--request-id", "r", "--path", "x"],
    ["request", "verify-receipt", "--bundle", "x"],
    ["audit", "show", "--request-id", "r"],
    ["request", "show", "--request-id", "r"],
    ["--catalog", "json"],
  ]) {
    const res = await client.callTool({ name: "run", arguments: { cli: "sign", args } });
    assert.doesNotMatch(res.content[0].text, /human-gated|not a read-only operation/i,
      `read-only op wrongly blocked: sign ${args.join(" ")}`);
  }
  await client.close();
});
