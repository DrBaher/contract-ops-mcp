import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// These tests pin the security guarantees of the `run` escape hatch: it must
// not become a way around (1) base-dir path confinement or (2) the
// human-gated signing model. They drive the real server over stdio so the
// guards are exercised end to end, including the error envelope.

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "contract-ops-mcp.mjs");

async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
  const client = new Client({ name: "run-guard", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

test("run refuses an absolute path that escapes the base dir", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "run", arguments: { cli: "extract", args: ["/etc/passwd", "--json"] } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /escapes the allowed base dir/);
  await client.close();
});

test("run refuses a ../ path that climbs out of the base dir", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "run", arguments: { cli: "extract", args: ["../../etc/passwd"] } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /escapes the allowed base dir/);
  await client.close();
});

test("run refuses an escaping path passed as --flag=value", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "run", arguments: { cli: "sign", args: ["request", "verify-signed-pdf", "--path=/etc/passwd"] } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /escapes the allowed base dir/);
  await client.close();
});

test("run refuses signing-mutation commands (sign create)", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "run", arguments: { cli: "sign", args: ["request", "create", "--title", "x"] } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /signing-mutation command "create" is not allowed/);
  await client.close();
});

test("run refuses the sign subcommand itself", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "run", arguments: { cli: "sign", args: ["sign", "--request-id", "r", "--token", "t"] } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /signing-mutation command "sign" is not allowed/);
  await client.close();
});

test("run still allows a read-only sign command (verify-receipt) past the guards", async () => {
  // sign isn't installed in the unit env, so we only assert the guards let it
  // through to the install-hint path — not that signing happened.
  const client = await connect();
  const res = await client.callTool({ name: "run", arguments: { cli: "sign", args: ["request", "verify-receipt", "--bundle", "bundle"] } });
  // Either the CLI ran, or it reported "not installed" — but NOT a guard rejection.
  assert.doesNotMatch(res.content[0].text, /escapes the allowed base dir|signing-mutation command/);
  await client.close();
});

test("run allows ordinary relative-path args on a non-sign CLI", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "run", arguments: { cli: "extract", args: ["contract.md", "--json"] } });
  assert.doesNotMatch(res.content[0].text, /escapes the allowed base dir/);
  await client.close();
});
