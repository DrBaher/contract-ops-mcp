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

let ndaAvailable = false;
try {
  execFileSync("nda-review-cli", ["--version"], { stdio: "ignore" });
  ndaAvailable = true;
} catch { /* not installed — review_nda test skips */ }
const skipNda = ndaAvailable ? false : "nda-review-cli not installed (runs only in CI's integration job)";

let draftAvailable = false;
try {
  execFileSync("draft", ["--version"], { stdio: "ignore" });
  draftAvailable = true;
} catch { /* not installed — fill_template test skips */ }
const skipDraft = draftAvailable ? false : "draft not installed (runs only in CI's integration job)";

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

test("fill_template passes JSON params to the real draft CLI and returns the filled doc", { skip: skipDraft }, async () => {
  // Regression: the handler used `--params -` (stdin), which draft-cli 0.9.0
  // rejects ("params file not found: -"). It must hand params to draft as a
  // JSON file so a filled document actually comes back.
  const TEMPLATE = "nda-template.md";
  writeFileSync(
    join(BASE, TEMPLATE),
    "NON-DISCLOSURE AGREEMENT\n\n" +
      "This NDA is between [Client Name] and Acme Corp, effective [Effective Date].\n",
  );
  const client = await connect();
  const res = await client.callTool({
    name: "fill_template",
    arguments: { template: TEMPLATE, params: { client_name: "Beta LLC", effective_date: "2026-08-01" } },
  });
  assert.ok(!res.isError, res.content[0].text);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.exitCode, 0, "draft should fill cleanly");
  const filled = data.output || "";
  assert.match(filled, /Beta LLC/, "client_name must be substituted");
  assert.match(filled, /2026-08-01/, "effective_date must be substituted");
  assert.doesNotMatch(filled, /\[Client Name\]|\[Effective Date\]/, "no placeholders should remain");
  await client.close();
});

test("review_nda runs the real CLI with --json --why and returns a structured report", { skip: skipNda }, async () => {
  // Self-contained fixtures: a minimal house playbook + an NDA with a known
  // high-severity non-solicit clause. Asserts the new parsed-JSON contract
  // (decision + risk_score + findings with per-finding evidence from --why),
  // not the old free-text behavior.
  const PLAYBOOK = "house-playbook.json";
  writeFileSync(
    join(BASE, PLAYBOOK),
    JSON.stringify({
      version: "0.1.0",
      org_name: "Test Org",
      policy: [
        {
          clause: "non_solicit_non_compete",
          preferred_position: "NDA should avoid hidden non-compete/non-solicit obligations unless explicitly negotiated.",
          red_flags: ["embedded non-compete", "overbroad non-solicit"],
          keywords: ["non-solicit", "non-compete", "solicit"],
        },
      ],
    }),
  );
  const NDA = "nda.txt";
  writeFileSync(
    join(BASE, NDA),
    "MUTUAL NON-DISCLOSURE AGREEMENT\n\n" +
      "This Agreement is between Acme Corp and Beta LLC.\n\n" +
      "1. Confidential Information. Each party may disclose confidential information.\n" +
      "2. Non-solicitation. Neither party shall solicit the other's employees for 5 years.\n",
  );

  const client = await connect();
  const res = await client.callTool({ name: "review_nda", arguments: { file: NDA, playbook: PLAYBOOK } });
  assert.ok(!res.isError, res.content[0].text);
  const data = JSON.parse(res.content[0].text);
  assert.equal(typeof data.exitCode, "number");
  const review = data.result;
  assert.ok(review && typeof review === "object", "review_nda must return parsed JSON, not free text");
  assert.equal(typeof review.decision, "string", "structured decision");
  assert.equal(typeof review.risk_score, "number", "structured risk_score");
  assert.ok(Array.isArray(review.findings), "structured findings array");
  // --why must enrich each finding with explainability evidence.
  assert.equal(review.explainability_mode, true, "--why should set explainability_mode");
  const solicit = review.findings.find((f) => f.clause === "non_solicit_non_compete");
  assert.ok(solicit, "should flag the non-solicit clause");
  assert.ok(solicit.evidence && Array.isArray(solicit.evidence.triggered_phrases), "finding carries --why evidence");
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
