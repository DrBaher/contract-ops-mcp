#!/usr/bin/env node
/**
 * contract-ops-mcp — one MCP server for the whole contract-ops CLI suite.
 *
 * Wire it up once and an agent gets all nine local-first CLIs as tools:
 *   "contract-ops": { "command": "npx", "args": ["-y", "contract-ops-mcp"] }
 *
 * Design:
 *   - Curated, ergonomic tools for the common operations (typed inputs, JSON out),
 *     PLUS `catalog(cli)` and `run(cli, args)` escape hatches for the long tail.
 *   - Each tool shells out to the installed CLI (no shell; execFile). If a CLI
 *     isn't installed the tool returns a clear install hint.
 *   - Signing stays HUMAN-GATED: only sign's read/verify ops are exposed, never
 *     request-create/sign — those stay behind sign-cli's own MCP + per-signer tokens.
 *   - File-path arguments are confined to CONTRACT_OPS_MCP_BASE_DIR (default: cwd).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { resolve, sep, join } from "node:path";
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const VERSION = "0.3.0";

// bin + how to install it, per CLI key the tools/escape-hatches reference.
const CLIS = {
  extract:          { bin: "extract",          install: "pipx install extract-cli" },
  "template-vault": { bin: "template-vault",   install: "pipx install template-vault-cli" },
  draft:            { bin: "draft",            install: "npm i -g @drbaher/draft-cli" },
  "nda-review":     { bin: "nda-review-cli",   install: "pipx install nda-review-cli" },
  lint:             { bin: "contract-lint",    install: "pipx install contract-lint" },
  compare:          { bin: "compare",          install: "npm i -g compare-cli" },
  docx2pdf:         { bin: "docx2pdf",         install: "npm i -g docx2pdf-cli" },
  sign:             { bin: "sign",             install: "npm i -g @drbaher/sign-cli" },
  "contract-vault": { bin: "contract-vault",   install: "pipx install contract-vault" },
};

const BASE_DIR = resolve(process.env.CONTRACT_OPS_MCP_BASE_DIR || process.cwd());

// Signing is HUMAN-GATED here: this server only exposes sign-cli's read/verify
// operations, never request-create/send/sign/approve — those stay behind
// sign-cli's own MCP + per-signer approval tokens (see README "Safety" +
// AGENTS.md). The curated sign tools already pin fixed read-only commands; this
// allowlist is the gate for the `run`/`catalog` escape hatches so they can't
// become an unguarded signing path.
//
// Verb prefixes that are pure-read / verify-only per `sign --catalog json`
// (reconciled against sign-cli 0.6.0 on 2026-07-13 — the version the linked
// `sign` bin actually builds; the earlier "0.6.5" note was aspirational, the
// installed CLI reports 0.6.0. Every entry below still exists in 0.6.0 and its
// catalog summary still declares it read-only — several say so explicitly
// ("Pure read — no state mutation", "no audit events written", "never touches
// request state"). `profile show` stays OFF this list.)
// Each entry matches the leading non-flag command tokens.
const SIGN_READONLY_COMMANDS = [
  ["--catalog"],                  // machine-readable catalog (the catalog tool)
  ["--help"], ["--version"],
  ["request", "verify-signed-pdf"],
  ["request", "verify-receipt"],
  ["request", "show"],
  ["request", "list"],
  ["request", "diff"],
  ["request", "rerun-policy"],    // "Pure read — no state mutation"
  ["audit", "show"],
  ["audit", "verify"],
  ["audit", "search"],
  ["audit", "scan"],
  ["audit", "anchors-list"],
  ["audit", "verify-anchor"],
  ["audit", "verify-chain-bundle"],
  ["audit", "verify-head"],
  ["pdf", "inspect"],
  ["pdf", "detect-signature-field"],
  ["pdf", "detect-date-field"],
  ["pdf", "stamp", "verify"],     // "tamper checks"; note: bare `pdf stamp` writes a PDF and is NOT allowed
  ["signer", "list"],
  ["signer", "policy", "try"],    // offline tester, "without touching state"
  ["signer", "policy", "lint"],
  ["signer", "policy", "diff"],   // "Pure preview — never touches request state"
  ["doctor", "providers"],
  ["db", "backend"],
  ["mcp", "tools"],
  ["examples"],
  ["completion"],
];

// Flags that mutate state, sign, transmit, rotate keys, or auto-confirm a
// mutation. Even on an otherwise read-only subcommand these turn a read into a
// write, so any sign invocation carrying one is refused — closing the
// "allowlisted subcommand + mutating flag" gap.
//
// This is a DENYLIST, not a fail-closed read-flag allowlist, and that is a
// deliberate, catalog-grounded choice (verified against sign 0.6.0 on
// 2026-07-13): sign-cli's `--catalog json` UNDER-REPORTS flags — e.g.
// `request verify-signed-pdf` requires `--request-id` and `--path` yet the
// catalog and `--help` both list it as flagless — so an allowlist built from
// the catalog would falsely reject the curated `verify_signature` tool's own
// `--path`. The CLI also silently ignores unrecognized flags, so an unknown
// flag is not reliably dangerous; the sound thing to block is the known
// mutating/signing verbs below. `--out`/`--output` are intentionally NOT here —
// a read that writes its report to a file is not a state mutation, and the
// artifact-writing subcommands (`request receipt`, `pdf stamp`, `audit anchor`,
// …) are already blocked at the subcommand level.
const SIGN_MUTATING_FLAGS = new Set([
  "--apply", "--repair", "--fix", "--force", "-f", "--write", "--save",
  "--set", "--overwrite", "--rotate", "--rotate-keys", "--backup", "--init",
  "--delete", "--remove", "--prune", "--approve", "--decline", "--send",
  "--sign", "--anchor", "--timestamp", "--token", "--yes", "-y", "--confirm",
  "--commit", "--emit", "--reissue",
]);

// Reject any `sign` invocation whose leading command tokens are not on the
// read-only allowlist, OR that carries a state-mutating flag. Throws (surfaced
// as isError) so an agent gets a clear, non-silent refusal. Leading flags (e.g.
// --provider local) are skipped over for command classification, but a mutating
// subcommand anywhere after them is still caught because we match the first
// non-flag token sequence — and a mutating flag anywhere is caught by the scan
// below regardless of position.
function assertSignReadOnly(args) {
  const tokens = args.map(String);

  // Flag scan first: a mutating flag on ANY sign invocation (even an allowlisted
  // read subcommand) is refused. Handles both `--flag value` and `--flag=value`.
  const mutating = tokens.find((t) => t.startsWith("-") && SIGN_MUTATING_FLAGS.has(t.split("=")[0]));
  if (mutating) {
    throw new Error(
      `signing is human-gated through this server: the '${mutating.split("=")[0]}' flag mutates or transmits state and is not reachable here. ` +
      `Only sign-cli's read/verify ops are exposed. To create/send/sign/approve a request, use sign-cli's own ` +
      `MCP server with its per-signer approval tokens.`);
  }
  // A leading "--flag value"? We need the first *command* token. Global flags
  // like --provider/--profile/--verbose take a value; bare --catalog/--help do
  // not. To stay safe we match against the full leading non-empty token list
  // and accept iff some allowlisted prefix appears at the front after skipping
  // recognised global value-flags.
  const GLOBAL_VALUE_FLAGS = new Set(["--provider", "--strict-provider", "--profile", "--verbose"]);
  const cmd = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      // standalone read-only flags are themselves allowlisted (e.g. --catalog)
      if (t === "--catalog" || t === "--help" || t === "--version") { cmd.push(t); break; }
      if (GLOBAL_VALUE_FLAGS.has(t)) { i++; continue; }   // skip flag + its value
      continue;                                            // skip an unknown flag (no value assumed)
    }
    cmd.push(t);
    // collect up to 3 command tokens (longest allowlist prefix is 3)
    if (cmd.length >= 3) break;
    // peek: if next token is a flag, the command is complete
    if (i + 1 < tokens.length && tokens[i + 1].startsWith("-")) break;
  }
  const ok = SIGN_READONLY_COMMANDS.some((prefix) =>
    prefix.length <= cmd.length && prefix.every((p, idx) => p === cmd[idx]));
  if (!ok) {
    const shown = cmd.length ? cmd.join(" ") : "(no command)";
    throw new Error(
      `signing is human-gated through this server: 'sign ${shown}' is not a read-only operation. ` +
      `Only sign-cli's read/verify ops are reachable here (e.g. 'request verify-signed-pdf', ` +
      `'request verify-receipt', 'audit show'). To create/send/sign a request, use sign-cli's own ` +
      `MCP server with its per-signer approval tokens.`);
  }
}

function safePath(p, label = "path") {
  if (typeof p !== "string" || !p) throw new Error(`${label} is required`);
  const r = resolve(BASE_DIR, p);
  if (r !== BASE_DIR && !r.startsWith(BASE_DIR + sep)) {
    throw new Error(`${label} escapes the allowed base dir (${BASE_DIR}); set CONTRACT_OPS_MCP_BASE_DIR to widen it`);
  }
  return r;
}

const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Classify an execFile callback (err, stdout, stderr) into our result shape.
// Pure + exported so the timeout/signal/maxBuffer-vs-real-exit distinction is
// unit-testable without spawning a 180s process.
//   - real exit code N  → { exitCode: N }
//   - timeout (SIGTERM kill) → { exitCode: null, timedOut: true, killed: "SIGTERM" }
//   - other signal kill → { exitCode: null, killed: <signal> }
//   - maxBuffer overflow → { exitCode: null, maxBufferExceeded: true }
// Collapsing all of these to exitCode 1 (the old behavior) made a 180s timeout
// indistinguishable from a genuine exit(1) I/O error.
function classifyExec(err, stdout, stderr) {
  if (err && (err.code === "ENOENT" || err.errno === -2)) return { notInstalled: true };
  const out = { stdout: stdout || "", stderr: stderr || "" };
  if (!err) { out.exitCode = 0; return out; }
  if (err.killed || err.signal || typeof err.code !== "number") {
    out.exitCode = null;
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      out.maxBufferExceeded = true;
    } else {
      if (err.killed && err.signal === "SIGTERM") out.timedOut = true; // execFile timeout kills with SIGTERM
      if (err.signal) out.killed = err.signal;
    }
    out.error = err.message;
  } else {
    out.exitCode = err.code;
  }
  return out;
}

// Run a CLI, no shell. Returns {notInstalled} | {exitCode, stdout, stderr, ...}.
function exec(bin, args, { input } = {}) {
  return new Promise((res) => {
    const child = execFile(
      bin, args,
      { cwd: BASE_DIR, timeout: 180000, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => res(classifyExec(err, stdout, stderr)),
    );
    if (input != null) { try { child.stdin.write(input); child.stdin.end(); } catch { /* ignore */ } }
  });
}

const result = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

// Run a suite CLI and shape stdout into JSON (parsed when the tool used --json).
async function cli(key, args, { input } = {}) {
  const c = CLIS[key];
  // Enforce the documented human-gated-signing guarantee on EVERY path that
  // shells out to sign — curated tools, catalog, and the `run` escape hatch.
  if (key === "sign") assertSignReadOnly(args);
  const r = await exec(c.bin, args, { input });
  if (r.notInstalled) return result(`${c.bin} is not installed. Install it:  ${c.install}`, true);
  const parsed = tryJson(r.stdout);
  const out = { exitCode: r.exitCode };   // null when the child was killed (timeout/signal/maxBuffer)
  if (parsed !== null) out.result = parsed;
  else if (r.stdout.trim()) out.output = r.stdout.trim();
  if (r.stderr.trim()) out.stderr = r.stderr.trim();
  // Surface abnormal-termination markers distinctly from a real exit code so an
  // agent can tell a 180s timeout / signal kill / maxBuffer overflow apart from
  // a genuine exit(1) I/O error (they're no longer both exitCode 1).
  if (r.timedOut) out.timedOut = true;
  if (r.killed) out.killed = r.killed;
  if (r.maxBufferExceeded) out.maxBufferExceeded = true;
  if (r.error && r.exitCode === null) out.error = r.error;
  // Non-zero is meaningful (findings/gates), not necessarily an error — surface it, don't throw.
  // A killed run (exitCode null) IS an error: mark it so callers branch correctly.
  return result(JSON.stringify(out, null, 2), r.exitCode === null);
}

const str = (description) => ({ type: "string", description });

// ---- curated tools + escape hatches ----
const TOOLDEFS = [
  {
    name: "extract_contract",
    description: "Ingest any contract (.md/.txt/.html/.docx/.pdf) into structured JSON — parties, dates, term, governing law, a clause map, defined terms — each with a confidence + source. Deterministic, no network.",
    inputSchema: { type: "object", properties: { path: str("Path to the contract file (within the base dir).") }, required: ["path"], additionalProperties: false },
    handler: (a) => cli("extract", [safePath(a.path), "--json"]),
  },
  {
    name: "lint_contract",
    description: "Lint one contract for internal-consistency defects — leftover placeholders, broken cross-references, undefined/unused defined terms, numbering gaps, party/date inconsistencies. Returns findings (rule, severity, line).",
    inputSchema: { type: "object", properties: { path: str("Path to the document."), fail_on: { type: "string", enum: ["error", "warning", "none"], description: "Severity threshold for the exit code (default: error)." } }, required: ["path"], additionalProperties: false },
    handler: (a) => cli("lint", [safePath(a.path), "--json", ...(a.fail_on ? ["--fail-on", a.fail_on] : [])]),
  },
  {
    name: "compare_versions",
    description: "Clause-aware drift detection between two contract versions. exitCode: 0 clean · 2 substantive drift · 3 cosmetic · 4 clauses moved · 1 I/O error.",
    inputSchema: { type: "object", properties: { base: str("Path to the agreed/base version."), candidate: str("Path to the version to check.") }, required: ["base", "candidate"], additionalProperties: false },
    handler: (a) => cli("compare", [safePath(a.base, "base"), safePath(a.candidate, "candidate"), "--json"]),
  },
  {
    name: "fill_template",
    description: "Fill placeholders in a markdown/.docx template with parameter values (deterministic; no LLM). Returns the filled document on stdout.",
    inputSchema: { type: "object", properties: { template: str("Path to the template."), params: { type: "object", description: "Parameter values (snake_case keys), passed as JSON.", additionalProperties: true } }, required: ["template"], additionalProperties: false },
    handler: async (a) => {
      const templatePath = safePath(a.template, "template");
      if (!a.params || !Object.keys(a.params).length) return cli("draft", [templatePath, "--no-llm"]);
      // draft-cli reads params from a JSON *file* (`--params FILE`); it does not
      // accept `-`/stdin. Write a private temp file rather than the
      // `--<key> value` flag form — a template param named `output`, `syntax`,
      // `json`, etc. would otherwise collide with draft's own flags. Clean up
      // regardless of outcome.
      const dir = mkdtempSync(join(tmpdir(), "comcp-fill-"));
      try {
        const pfile = join(dir, "params.json");
        writeFileSync(pfile, JSON.stringify(a.params));
        return await cli("draft", [templatePath, "--no-llm", "--params", pfile]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "convert_to_pdf",
    description: "Convert a Word document to PDF (needs a PDF backend such as LibreOffice on the host).",
    inputSchema: { type: "object", properties: { input: str("Path to the .docx."), output: str("Output .pdf path (optional).") }, required: ["input"], additionalProperties: false },
    handler: (a) => cli("docx2pdf", [safePath(a.input, "input"), safePath(a.output || a.input.replace(/\.docx$/i, ".pdf"), "output"), "--json"]),
  },
  {
    name: "review_nda",
    description: "Review an NDA against a house playbook — deterministic scoring with evidence per finding. Returns the structured review report (decision, risk_score, findings with evidence).",
    inputSchema: { type: "object", properties: { file: str("Path to the NDA."), playbook: str("Path to the house playbook JSON (optional).") }, required: ["file"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["review", "--file", safePath(a.file, "file"), ...(a.playbook ? ["--playbook", safePath(a.playbook, "playbook")] : []), "--json", "--why"]),
  },
  // ---- NDA drafting & negotiation (nda-review-cli) ----
  // Draft/negotiate need a one-time org policy; --base keeps it (and the
  // negotiation state) inside the workspace, never in the CLI's install dir.
  {
    name: "nda_setup",
    description: "One-time: generate the org NDA policy + default playbook in the workspace (needed before draft_nda / negotiate_*). Idempotent; writes config into the workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => cli("nda-review", ["setup", "--quick", "--yes", "--base", BASE_DIR]),
  },
  {
    name: "generate_redlines",
    description: "Generate a clause-ready redline draft from a review_nda JSON report. Writes redline markdown to `out`. Deterministic; no org policy needed.",
    inputSchema: { type: "object", properties: { review_json: str("Path to a saved review_nda JSON report."), out: str("Output path for the redline markdown."), mode: { type: "string", enum: ["classic", "v2"], description: "Redline format (default classic)." } }, required: ["review_json", "out"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["generate-redlines", "--review-json", safePath(a.review_json, "review_json"), "--out", safePath(a.out, "out"), ...(a.mode ? ["--mode", a.mode] : [])]),
  },
  {
    name: "draft_nda",
    description: "Draft a new NDA from a built-in template into `out` (markdown; optional .docx). Deterministic. If placeholders are missing the result lists them — fill and retry. Needs nda_setup first.",
    inputSchema: { type: "object", properties: {
      out: str("Output markdown path."),
      purpose: str("Purpose / deal description."),
      template: { type: "string", enum: ["common-paper-mutual", "mutual", "one-way-out"], description: "Which built-in template (default mutual)." },
      out_docx: str("Optional Word .docx output path."),
      effective_date: str("Effective date."),
      governing_law: str("Governing law."),
      party_a: str("Party A name (mutual)."),
      party_a_address: str("Party A address (mutual)."),
      party_b: str("Party B name (mutual)."),
      party_b_address: str("Party B address (mutual)."),
      disclosing_party: str("Disclosing party (one-way)."),
      receiving_party: str("Receiving party (one-way)."),
    }, required: ["out", "purpose"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["draft", "--base", BASE_DIR, "--out", safePath(a.out, "out"), "--purpose", String(a.purpose),
      ...(a.template ? ["--template", a.template] : []),
      ...(a.out_docx ? ["--out-docx", safePath(a.out_docx, "out_docx")] : []),
      ...(a.effective_date ? ["--effective-date", String(a.effective_date)] : []),
      ...(a.governing_law ? ["--governing-law", String(a.governing_law)] : []),
      ...(a.party_a ? ["--party-a", String(a.party_a)] : []),
      ...(a.party_a_address ? ["--party-a-address", String(a.party_a_address)] : []),
      ...(a.party_b ? ["--party-b", String(a.party_b)] : []),
      ...(a.party_b_address ? ["--party-b-address", String(a.party_b_address)] : []),
      ...(a.disclosing_party ? ["--disclosing-party", String(a.disclosing_party)] : []),
      ...(a.receiving_party ? ["--receiving-party", String(a.receiving_party)] : []),
    ]),
  },
  // Negotiation — read-only views over a negotiation state file.
  {
    name: "negotiate_status",
    description: "Show a negotiation's rounds, per-clause status, and signatures. Read-only.",
    inputSchema: { type: "object", properties: { state: str("Path to the negotiation state file.") }, required: ["state"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["negotiate", "status", "--state", safePath(a.state, "state")]),
  },
  {
    name: "negotiate_review",
    description: "Review the latest negotiation round against your policy. Read-only.",
    inputSchema: { type: "object", properties: { state: str("Path to the negotiation state file."), as: { type: "string", enum: ["a", "b"], description: "Which side's policy view." } }, required: ["state"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["negotiate", "review", "--base", BASE_DIR, "--state", safePath(a.state, "state"), ...(a.as ? ["--as", a.as] : [])]),
  },
  {
    name: "negotiate_diff",
    description: "Clause-by-clause changes between two negotiation rounds (defaults to the last two). Read-only.",
    inputSchema: { type: "object", properties: { state: str("Path to the negotiation state file."), from_round: str("From round number."), to_round: str("To round number.") }, required: ["state"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["negotiate", "diff", "--base", BASE_DIR, "--state", safePath(a.state, "state"), ...(a.from_round ? ["--from-round", String(a.from_round)] : []), ...(a.to_round ? ["--to-round", String(a.to_round)] : [])]),
  },
  {
    name: "negotiate_analyze",
    description: "Post-hoc negotiation dashboard: trajectory, per-clause winners, source breakdown, outcome. Read-only.",
    inputSchema: { type: "object", properties: { state: str("Path to the negotiation state file.") }, required: ["state"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["negotiate", "analyze", "--base", BASE_DIR, "--state", safePath(a.state, "state")]),
  },
  {
    name: "negotiate_validate",
    description: "Integrity check on a negotiation state file: schema + hash-chain + per-round shape. Read-only.",
    inputSchema: { type: "object", properties: { state: str("Path to the negotiation state file.") }, required: ["state"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["negotiate", "validate", "--state", safePath(a.state, "state")]),
  },
  // Negotiation — commitment/signing acts. Each signs a round in the state
  // file's hash chain; the harness gates these with typed human consent.
  {
    name: "negotiate_init",
    description: "Start a negotiation: draft from a template + parties, SIGN as Party A, and write the state file. Signs a negotiating commitment. Needs nda_setup first.",
    inputSchema: { type: "object", properties: {
      out: str("Output path for the negotiation state file."),
      purpose: str("Purpose / deal description."),
      template: { type: "string", enum: ["common-paper-mutual", "mutual", "one-way-out"], description: "Which built-in template (default mutual)." },
      party_a_name: str("Party A name."), party_a_address: str("Party A address."),
      party_b_name: str("Party B name."), party_b_address: str("Party B address."),
      effective_date: str("Effective date."), governing_law: str("Governing law."),
    }, required: ["out", "purpose"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["negotiate", "init", "--base", BASE_DIR, "--out", safePath(a.out, "out"), "--purpose", String(a.purpose),
      ...(a.template ? ["--template", a.template] : []),
      ...(a.party_a_name ? ["--party-a-name", String(a.party_a_name)] : []),
      ...(a.party_a_address ? ["--party-a-address", String(a.party_a_address)] : []),
      ...(a.party_b_name ? ["--party-b-name", String(a.party_b_name)] : []),
      ...(a.party_b_address ? ["--party-b-address", String(a.party_b_address)] : []),
      ...(a.effective_date ? ["--effective-date", String(a.effective_date)] : []),
      ...(a.governing_law ? ["--governing-law", String(a.governing_law)] : []),
    ]),
  },
  {
    name: "negotiate_counter",
    description: "Sign a counter-round with amendments — either from a JSON amendments file you provide, or deterministic --auto with a stance. Signs a negotiating commitment.",
    inputSchema: { type: "object", properties: {
      state: str("Path to the negotiation state file."),
      amendments_file: str("Path to a JSON amendments file (drafted by you)."),
      as: { type: "string", enum: ["a", "b"], description: "Which side you're countering as." },
      stance: { type: "string", enum: ["compromising", "conservative", "middleground"], description: "Deterministic stance when using auto." },
      auto: { type: "boolean", description: "Use the deterministic auto-amender instead of an amendments file." },
      out: str("Optional output path for the round."),
    }, required: ["state"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["negotiate", "counter", "--base", BASE_DIR, "--state", safePath(a.state, "state"),
      ...(a.amendments_file ? ["--amendments-file", safePath(a.amendments_file, "amendments_file")] : []),
      ...(a.as ? ["--as", a.as] : []),
      ...(a.stance ? ["--stance", a.stance] : []),
      ...(a.auto ? ["--auto"] : []),
      ...(a.out ? ["--out", safePath(a.out, "out")] : []),
    ]),
  },
  {
    name: "negotiate_accept",
    description: "Accept the current negotiated text, SIGNING convergence on your side. Signs a binding acceptance.",
    inputSchema: { type: "object", properties: { state: str("Path to the negotiation state file."), as: { type: "string", enum: ["a", "b"], description: "Which side." }, out: str("Optional output path.") }, required: ["state"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["negotiate", "accept", "--base", BASE_DIR, "--state", safePath(a.state, "state"), ...(a.as ? ["--as", a.as] : []), ...(a.out ? ["--out", safePath(a.out, "out")] : [])]),
  },
  {
    name: "negotiate_finalize",
    description: "Finalize a converged negotiation: emit the final .md and .docx. The legal SIGNATURE stays with the human — no e-signature is applied here; hand off to sign-cli.",
    inputSchema: { type: "object", properties: { state: str("Path to the negotiation state file."), out_md: str("Final markdown output path."), out_docx: str("Final .docx output path.") }, required: ["state", "out_md", "out_docx"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["negotiate", "finalize", "--base", BASE_DIR, "--state", safePath(a.state, "state"), "--out-md", safePath(a.out_md, "out_md"), "--out-docx", safePath(a.out_docx, "out_docx"), "--skip-signoff"]),
  },
  {
    name: "template_vault_find",
    description: "Search the template vault by category, tag, jurisdiction, or keyword. Read-only.",
    inputSchema: { type: "object", properties: { query: str("Search query.") }, required: ["query"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["find", "--json", "--", String(a.query)]),
  },
  {
    name: "template_vault_get",
    description: "Resolve and return a versioned template's text by reference (e.g. nda/house-mutual). Read-only.",
    inputSchema: { type: "object", properties: { ref: str("Template reference: category/name[@version].") }, required: ["ref"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["get", "--", String(a.ref)]),
  },
  // Template vault — browse, inspect, and compose. Refs are vault references
  // (category/name[@version]), NOT file paths, so they are not safePath'd.
  {
    name: "template_vault_list",
    description: "List templates in the vault, optionally filtered by category / tag / jurisdiction. Read-only.",
    inputSchema: { type: "object", properties: { category: str("Filter by category."), tag: str("Filter by tag."), jurisdiction: str("Filter by jurisdiction.") }, additionalProperties: false },
    handler: (a) => cli("template-vault", ["list", "--json", ...(a.category ? ["--category", String(a.category)] : []), ...(a.tag ? ["--tag", String(a.tag)] : []), ...(a.jurisdiction ? ["--jurisdiction", String(a.jurisdiction)] : [])]),
  },
  {
    name: "template_vault_info",
    description: "Show metadata for a template (category, tags, jurisdiction, versions). Read-only.",
    inputSchema: { type: "object", properties: { ref: str("Template reference.") }, required: ["ref"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["info", "--json", String(a.ref)]),
  },
  {
    name: "template_vault_diff",
    description: "Unified diff between two versions of one template. Read-only.",
    inputSchema: { type: "object", properties: { ref: str("Template reference."), version_a: str("First version."), version_b: str("Second version.") }, required: ["ref", "version_a", "version_b"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["diff", String(a.ref), String(a.version_a), String(a.version_b)]),
  },
  {
    name: "template_vault_history",
    description: "Chronological timeline for a template: versions, swaps, and amendments. Read-only.",
    inputSchema: { type: "object", properties: { ref: str("Template reference.") }, required: ["ref"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["history", "--json", String(a.ref)]),
  },
  {
    name: "template_vault_clauses",
    description: "List the clauses detected in a template. Read-only.",
    inputSchema: { type: "object", properties: { ref: str("Template reference.") }, required: ["ref"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["clauses", String(a.ref)]),
  },
  {
    name: "template_vault_clause_library",
    description: "Find clauses that repeat across the vault (a reusable clause library). Read-only.",
    inputSchema: { type: "object", properties: { threshold: str("Similarity threshold (0-1).") }, additionalProperties: false },
    handler: (a) => cli("template-vault", ["clause-library", ...(a.threshold ? ["--threshold", String(a.threshold)] : [])]),
  },
  {
    name: "template_vault_compare_clauses",
    description: "Compare clauses between two templates (optionally one named clause). Read-only.",
    inputSchema: { type: "object", properties: { a: str("First template reference."), b: str("Second template reference."), clause: str("Optional clause name to compare.") }, required: ["a", "b"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["compare-clauses", ...(a.clause ? ["--clause", String(a.clause)] : []), String(a.a), String(a.b)]),
  },
  {
    name: "template_vault_stats",
    description: "Vault dashboard: template counts, coverage, and last activity. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => cli("template-vault", ["stats", "--json"]),
  },
  {
    name: "template_vault_verify",
    description: "Content-level sha256 integrity check of the vault. Read-only (never rewrites hashes).",
    inputSchema: { type: "object", properties: { strict: { type: "boolean", description: "Fail on any mismatch." } }, additionalProperties: false },
    handler: (a) => cli("template-vault", ["verify", ...(a.strict ? ["--strict"] : [])]),
  },
  {
    name: "template_vault_compose",
    description: "Fork a template into a new derived template in the vault. Writes a new versioned template.",
    inputSchema: { type: "object", properties: { base: str("Base template reference to fork from."), as_ref: str("New template reference to create.") }, required: ["base", "as_ref"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["compose", "--why", "--base", String(a.base), "--as", String(a.as_ref)]),
  },
  {
    name: "template_vault_swap",
    description: "Replace one clause in a template with the same clause from another template. Writes a new version.",
    inputSchema: { type: "object", properties: { target: str("Template reference to modify."), clause: str("Clause name to replace."), from_ref: str("Template reference to take the clause from.") }, required: ["target", "clause", "from_ref"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["swap", "--why", "--clause", String(a.clause), "--from", String(a.from_ref), String(a.target)]),
  },
  {
    name: "template_vault_export",
    description: "Export a template to another format (e.g. .docx) at a workspace path.",
    inputSchema: { type: "object", properties: { ref: str("Template reference."), as: str("Format, e.g. docx."), output: str("Output file path.") }, required: ["ref"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["export", ...(a.as ? ["--as", String(a.as)] : []), ...(a.output ? ["--output", safePath(a.output, "output")] : []), String(a.ref)]),
  },
  {
    name: "contract_vault_query",
    description: "Query the register of signed contracts (read-only): list | find | get | show | stats | history.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "find", "get", "show", "stats", "history"], description: "Read-only action." }, arg: str("Argument for find/get/show/history (query or deal id).") }, required: ["action"], additionalProperties: false },
    handler: (a) => cli("contract-vault", [a.action, "--json", ...(a.arg ? ["--", String(a.arg)] : [])]),
  },
  {
    name: "contract_vault_due",
    description: "Project upcoming renewal / notice / payment deadlines from the signed-contract register.",
    inputSchema: { type: "object", properties: { within: str("Window, e.g. 30d / 90d (default 30d).") }, additionalProperties: false },
    handler: (a) => cli("contract-vault", ["due", ...(a.within ? ["--within", String(a.within)] : []), "--format", "json"]),
  },
  {
    name: "contract_vault_risk",
    description: "Renewal-exposure analysis: missed/imminent auto-renewal notice deadlines and expirations.",
    inputSchema: { type: "object", properties: { within: str("Window, e.g. 30d (default 30d).") }, additionalProperties: false },
    handler: (a) => cli("contract-vault", ["risk", ...(a.within ? ["--within", String(a.within)] : []), "--json"]),
  },
  // Contract vault — obligations, reminders, and register lifecycle.
  {
    name: "contract_vault_obligations",
    description: "Project upcoming date/obligation actions from the register. Read-only.",
    inputSchema: { type: "object", properties: {
      within: str("Window, e.g. 90d."),
      status: { type: "string", enum: ["open", "done", "waived", "all"], description: "Filter by status." },
      type: str("Filter by obligation type."), owner: str("Filter by owner."), as_of: str("As-of date (YYYY-MM-DD)."),
    }, additionalProperties: false },
    handler: (a) => cli("contract-vault", ["obligations", "--json", ...(a.within ? ["--within", String(a.within)] : []), ...(a.status ? ["--status", a.status] : []), ...(a.type ? ["--type", String(a.type)] : []), ...(a.owner ? ["--owner", String(a.owner)] : []), ...(a.as_of ? ["--as-of", String(a.as_of)] : [])]),
  },
  {
    name: "contract_vault_remind",
    description: "Obligations whose reminder window is open right now — a digest for agents/cron. Read-only.",
    inputSchema: { type: "object", properties: { as_of: str("As-of date (YYYY-MM-DD)."), status: { type: "string", enum: ["open", "done", "waived", "all"], description: "Filter by status." }, type: str("Filter by type."), owner: str("Filter by owner.") }, additionalProperties: false },
    handler: (a) => cli("contract-vault", ["remind", "--json", ...(a.as_of ? ["--as-of", String(a.as_of)] : []), ...(a.status ? ["--status", a.status] : []), ...(a.type ? ["--type", String(a.type)] : []), ...(a.owner ? ["--owner", String(a.owner)] : [])]),
  },
  {
    name: "contract_vault_at_risk",
    description: "Renewal exposure: missed / imminent auto-renewal notice deadlines and expirations. Read-only.",
    inputSchema: { type: "object", properties: { within: str("Window, e.g. 30d."), as_of: str("As-of date.") }, additionalProperties: false },
    handler: (a) => cli("contract-vault", ["at-risk", "--json", ...(a.within ? ["--within", String(a.within)] : []), ...(a.as_of ? ["--as-of", String(a.as_of)] : [])]),
  },
  {
    name: "contract_vault_review",
    description: "List register fields needing review (unidentified / LLM-derived / low-confidence). Read-only.",
    inputSchema: { type: "object", properties: { threshold: str("Confidence threshold (0-1).") }, additionalProperties: false },
    handler: (a) => cli("contract-vault", ["review", "--json", ...(a.threshold ? ["--threshold", String(a.threshold)] : [])]),
  },
  {
    name: "contract_vault_verify",
    description: "Integrity check of the register (source sha256 + git state). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => cli("contract-vault", ["verify", "--json"]),
  },
  {
    name: "contract_vault_export",
    description: "Export the register as csv | md | json (for spreadsheets / reports). Returns the export; writes no file. Read-only.",
    inputSchema: { type: "object", properties: { format: { type: "string", enum: ["csv", "md", "json"], description: "Export format." }, expiring_before: str("Only rows expiring before this date."), needs_review: { type: "boolean", description: "Only rows needing review." } }, additionalProperties: false },
    handler: (a) => cli("contract-vault", ["export", ...(a.format ? ["--format", a.format] : ["--format", "json"]), ...(a.expiring_before ? ["--expiring-before", String(a.expiring_before)] : []), ...(a.needs_review ? ["--needs-review"] : [])]),
  },
  {
    name: "contract_vault_ingest",
    description: "Register a contract into the vault from an extract_contract JSON file. Writes to the register.",
    inputSchema: { type: "object", properties: { file: str("Path to an extract_contract JSON file."), counterparty: str("Counterparty name."), name: str("Deal name.") }, required: ["file"], additionalProperties: false },
    handler: (a) => cli("contract-vault", ["ingest", "--json", ...(a.counterparty ? ["--counterparty", String(a.counterparty)] : []), ...(a.name ? ["--name", String(a.name)] : []), safePath(a.file, "file")]),
  },
  {
    name: "contract_vault_obligation",
    description: "Track one obligation's lifecycle (status / owner / recurrence / reminder days). Writes to the register.",
    inputSchema: { type: "object", properties: {
      deal: str("Deal id."), id: str("Obligation id."),
      status: { type: "string", enum: ["open", "done", "waived"], description: "New status." },
      owner: str("Assign an owner."),
      recurrence: { type: "string", enum: ["none", "weekly", "monthly", "quarterly", "semiannual", "annual"], description: "Recurrence." },
      reminders: str("Reminder lead days, e.g. 30."),
    }, required: ["deal", "id"], additionalProperties: false },
    handler: (a) => cli("contract-vault", ["obligation", "--json", ...(a.status ? ["--status", a.status] : []), ...(a.owner ? ["--owner", String(a.owner)] : []), ...(a.recurrence ? ["--recurrence", a.recurrence] : []), ...(a.reminders ? ["--reminders", String(a.reminders)] : []), String(a.deal), String(a.id)]),
  },
  {
    name: "contract_vault_accept",
    description: "Mark register field(s) as manually verified (single, or bulk via a file). Writes to the register.",
    inputSchema: { type: "object", properties: { deal: str("Deal id."), field: str("Field name."), value: str("Verified value."), from_file: str("Path to a bulk-accept file.") }, additionalProperties: false },
    handler: (a) => cli("contract-vault", ["accept", "--json", ...(a.value ? ["--value", String(a.value)] : []), ...(a.from_file ? ["--from", safePath(a.from_file, "from_file")] : []), ...(a.deal ? [String(a.deal)] : []), ...(a.field ? [String(a.field)] : [])]),
  },
  {
    name: "verify_signature",
    description: "Verify a signed PDF matches what was recorded for its request. (Read-only; signing itself stays human-gated behind sign-cli's own MCP.)",
    inputSchema: { type: "object", properties: { request_id: str("The sign request id."), path: str("Path to the signed PDF.") }, required: ["request_id", "path"], additionalProperties: false },
    handler: (a) => cli("sign", ["request", "verify-signed-pdf", "--request-id", String(a.request_id), "--path", safePath(a.path)]),
  },
  {
    name: "verify_receipt",
    description: "Re-verify a portable signing receipt bundle, fully offline. Read-only.",
    inputSchema: { type: "object", properties: { bundle: str("Path to the receipt bundle directory.") }, required: ["bundle"], additionalProperties: false },
    handler: (a) => cli("sign", ["request", "verify-receipt", "--bundle", safePath(a.bundle, "bundle")]),
  },
  {
    name: "audit_show",
    description: "Show the hash-chained audit log for a sign request. Read-only.",
    inputSchema: { type: "object", properties: { request_id: str("The sign request id.") }, required: ["request_id"], additionalProperties: false },
    handler: (a) => cli("sign", ["audit", "show", "--request-id", String(a.request_id)]),
  },
  // ---- escape hatches ----
  {
    name: "catalog",
    description: "Return a CLI's full machine-readable command/flag catalog (`<cli> --catalog json`). Use this to discover the long tail beyond the curated tools.",
    inputSchema: { type: "object", properties: { cli: { type: "string", enum: Object.keys(CLIS), description: "Which suite CLI." } }, required: ["cli"], additionalProperties: false },
    handler: (a) => { if (!CLIS[a.cli]) throw new Error(`unknown cli: ${a.cli}`); return cli(a.cli, ["--catalog", "json"]); },
  },
  {
    name: "run",
    description: "Escape hatch: run any suite CLI with raw arguments (no shell). For commands the curated tools don't cover. Call `catalog` first to learn the flags. Note: signing stays human-gated — only sign-cli's read/verify subcommands are reachable here; request-create/send/sign/approve are rejected and must go through sign-cli's own MCP with its per-signer approval tokens.",
    inputSchema: { type: "object", properties: { cli: { type: "string", enum: Object.keys(CLIS) }, args: { type: "array", items: { type: "string" }, description: "Arguments passed verbatim to the CLI." } }, required: ["cli", "args"], additionalProperties: false },
    handler: (a) => { if (!CLIS[a.cli]) throw new Error(`unknown cli: ${a.cli}`); if (!Array.isArray(a.args)) throw new Error("args must be an array of strings"); return cli(a.cli, a.args.map(String)); },
  },
  {
    name: "suite_status",
    description: "Report which suite CLIs are installed (with versions) and how to install any that are missing. Call this first if a tool reports a CLI isn't installed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const rows = [];
      for (const [key, c] of Object.entries(CLIS)) {
        const r = await exec(c.bin, ["--version"]);
        rows.push(r.notInstalled
          ? { cli: key, bin: c.bin, installed: false, install: c.install }
          : { cli: key, bin: c.bin, installed: true, version: (r.stdout || r.stderr).trim().split("\n")[0] });
      }
      return result(JSON.stringify({ baseDir: BASE_DIR, clis: rows }, null, 2));
    },
  },
];

const TOOLS = TOOLDEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const HANDLERS = Object.fromEntries(TOOLDEFS.map((t) => [t.name, t.handler]));

async function main() {
  const server = new Server(
    { name: "contract-ops-mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const h = HANDLERS[req.params.name];
    if (!h) return result(`unknown tool: ${req.params.name}`, true);
    try {
      return await h(req.params.arguments || {});
    } catch (e) {
      return result(`error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`contract-ops-mcp ${VERSION} ready — base dir: ${BASE_DIR}\n`);
}

// Are we the executed entry point? Compare realpaths on both sides so launching
// through the npm bin symlink (node_modules/.bin/contract-ops-mcp, which is how
// MCP clients and npx invoke us) still matches — argv[1] is the symlink while
// import.meta.url is the realpath Node resolved. A naive string compare misses
// that and the server exits 0 silently. realpathSync also throws if the path is
// gone, so guard it.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) main().catch((e) => { process.stderr.write(`fatal: ${e}\n`); process.exit(1); });

export { TOOLS, HANDLERS, CLIS, safePath, classifyExec, assertSignReadOnly, SIGN_READONLY_COMMANDS };
