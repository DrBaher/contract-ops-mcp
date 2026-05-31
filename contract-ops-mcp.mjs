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
import { resolve, sep } from "node:path";

const VERSION = "0.1.1";

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

function safePath(p, label = "path") {
  if (typeof p !== "string" || !p) throw new Error(`${label} is required`);
  const r = resolve(BASE_DIR, p);
  if (r !== BASE_DIR && !r.startsWith(BASE_DIR + sep)) {
    throw new Error(`${label} escapes the allowed base dir (${BASE_DIR}); set CONTRACT_OPS_MCP_BASE_DIR to widen it`);
  }
  return r;
}

const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Run a CLI, no shell. Returns {notInstalled} | {code, stdout, stderr}.
function exec(bin, args, { input } = {}) {
  return new Promise((res) => {
    const child = execFile(
      bin, args,
      { cwd: BASE_DIR, timeout: 180000, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        if (err && (err.code === "ENOENT" || err.errno === -2)) return res({ notInstalled: true });
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        res({ code, stdout: stdout || "", stderr: stderr || "" });
      },
    );
    if (input != null) { try { child.stdin.write(input); child.stdin.end(); } catch { /* ignore */ } }
  });
}

const result = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

// Run a suite CLI and shape stdout into JSON (parsed when the tool used --json).
async function cli(key, args, { input } = {}) {
  const c = CLIS[key];
  const r = await exec(c.bin, args, { input });
  if (r.notInstalled) return result(`${c.bin} is not installed. Install it:  ${c.install}`, true);
  const parsed = tryJson(r.stdout);
  const out = { exitCode: r.code };
  if (parsed !== null) out.result = parsed;
  else if (r.stdout.trim()) out.output = r.stdout.trim();
  if (r.stderr.trim()) out.stderr = r.stderr.trim();
  // Non-zero is meaningful (findings/gates), not necessarily an error — surface it, don't throw.
  return result(JSON.stringify(out, null, 2));
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
      const args = [safePath(a.template, "template"), "--no-llm"];
      if (a.params && Object.keys(a.params).length) return cli("draft", [...args, "--params", "-"], { input: JSON.stringify(a.params) }).catch(() => cli("draft", args));
      return cli("draft", args);
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
    description: "Review an NDA against a house playbook — deterministic scoring with evidence per finding. Returns the review report.",
    inputSchema: { type: "object", properties: { file: str("Path to the NDA."), playbook: str("Path to the house playbook JSON (optional).") }, required: ["file"], additionalProperties: false },
    handler: (a) => cli("nda-review", ["review", "--file", safePath(a.file, "file"), ...(a.playbook ? ["--playbook", safePath(a.playbook, "playbook")] : []), "--why"]),
  },
  {
    name: "template_vault_find",
    description: "Search the template vault by category, tag, jurisdiction, or keyword. Read-only.",
    inputSchema: { type: "object", properties: { query: str("Search query.") }, required: ["query"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["find", String(a.query), "--json"]),
  },
  {
    name: "template_vault_get",
    description: "Resolve and return a versioned template's text by reference (e.g. nda/house-mutual). Read-only.",
    inputSchema: { type: "object", properties: { ref: str("Template reference: category/name[@version].") }, required: ["ref"], additionalProperties: false },
    handler: (a) => cli("template-vault", ["get", String(a.ref)]),
  },
  {
    name: "contract_vault_query",
    description: "Query the register of signed contracts (read-only): list | find | get | show | stats | history.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "find", "get", "show", "stats", "history"], description: "Read-only action." }, arg: str("Argument for find/get/show/history (query or deal id).") }, required: ["action"], additionalProperties: false },
    handler: (a) => cli("contract-vault", [a.action, ...(a.arg ? [String(a.arg)] : []), "--json"]),
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
    description: "Escape hatch: run any suite CLI with raw arguments (no shell). For commands the curated tools don't cover. Call `catalog` first to learn the flags. Note: signing-mutation commands are intentionally not blocked here but remain the user's responsibility.",
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

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { process.stderr.write(`fatal: ${e}\n`); process.exit(1); });

export { TOOLS, HANDLERS, CLIS, safePath };
