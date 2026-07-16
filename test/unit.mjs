// Pure-function unit tests for the two server-internal guards:
//   - classifyExec: timeout/signal/maxBuffer must NOT collapse to exitCode 1
//     (finding #2). Driven with synthetic execFile-style errors so it's
//     deterministic and fast (no 180s spawn).
//   - assertSignReadOnly: the human-gated-signing allowlist (finding #1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyExec, assertSignReadOnly } from "../contract-ops-mcp.mjs";

// --- finding #2: termination is distinguishable from a real exit code ---

test("classifyExec: clean exit → exitCode 0", () => {
  const r = classifyExec(null, "out", "");
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, undefined);
  assert.equal(r.killed, undefined);
});

test("classifyExec: real non-zero exit is preserved (not masked as a kill)", () => {
  const err = Object.assign(new Error("exit 2"), { code: 2 });
  const r = classifyExec(err, "", "boom");
  assert.equal(r.exitCode, 2);
  assert.equal(r.timedOut, undefined);
  assert.equal(r.killed, undefined);
  assert.equal(r.maxBufferExceeded, undefined);
});

test("classifyExec: a genuine exit(1) I/O error stays exitCode 1 (no false timeout)", () => {
  const err = Object.assign(new Error("io"), { code: 1 });
  const r = classifyExec(err, "", "");
  assert.equal(r.exitCode, 1);
  assert.equal(r.timedOut, undefined);
});

test("classifyExec: 180s timeout (SIGTERM kill) → exitCode null + timedOut, NOT 1", () => {
  // execFile's timeout path: killed:true, signal:"SIGTERM", code:null.
  const err = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", code: null });
  const r = classifyExec(err, "partial", "");
  assert.equal(r.exitCode, null, "must not be a numeric exit code");
  assert.equal(r.timedOut, true);
  assert.equal(r.killed, "SIGTERM");
  assert.notEqual(r.exitCode, 1, "regression: timeout used to collapse to 1");
});

test("classifyExec: SIGKILL → killed marker, not exitCode 1", () => {
  const err = Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL", code: null });
  const r = classifyExec(err, "", "");
  assert.equal(r.exitCode, null);
  assert.equal(r.killed, "SIGKILL");
  assert.equal(r.timedOut, undefined);
});

test("classifyExec: maxBuffer overflow → maxBufferExceeded, not exitCode 1", () => {
  const err = Object.assign(new Error("stdout maxBuffer exceeded"), {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM",
  });
  const r = classifyExec(err, "", "");
  assert.equal(r.exitCode, null);
  assert.equal(r.maxBufferExceeded, true);
  assert.equal(r.timedOut, undefined, "maxBuffer is not a timeout");
});

test("classifyExec: ENOENT → notInstalled (unchanged)", () => {
  const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT", errno: -2 });
  assert.deepEqual(classifyExec(err, "", ""), { notInstalled: true });
});

// --- finding #1: human-gated-signing allowlist ---

const allowed = (args) => assert.doesNotThrow(() => assertSignReadOnly(args), `should allow: sign ${args.join(" ")}`);
const blocked = (args) => assert.throws(() => assertSignReadOnly(args), /human-gated|not a read-only/i, `should block: sign ${args.join(" ")}`);

test("assertSignReadOnly: read/verify ops pass", () => {
  allowed(["request", "verify-signed-pdf", "--request-id", "r", "--path", "x"]);
  allowed(["request", "verify-receipt", "--bundle", "x"]);
  allowed(["request", "show", "--request-id", "r"]);
  allowed(["request", "list"]);
  allowed(["request", "diff", "--before", "a", "--after", "b"]);
  allowed(["audit", "show", "--request-id", "r"]);
  allowed(["audit", "verify", "--request-id", "r"]);
  allowed(["pdf", "inspect", "--pdf", "x"]);
  allowed(["pdf", "stamp", "verify", "--pdf", "x"]);
  allowed(["signer", "list"]);
  allowed(["signer", "policy", "try", "--spec", "x"]);
  allowed(["--catalog", "json"]);
  allowed(["--help"]);
});

test("assertSignReadOnly: lifecycle-mutating ops are blocked", () => {
  blocked(["request", "create", "--title", "t"]);
  blocked(["request", "sign", "--request-id", "r", "--token", "t"]);
  blocked(["request", "send", "--request-id", "r"]);
  blocked(["request", "send-embedded"]);
  blocked(["request", "cancel", "--request-id", "r", "--yes", "true"]);
  blocked(["request", "run-email"]);
  blocked(["request", "from-template", "--template-id", "x"]);
  blocked(["request", "bulk", "--csv", "x"]);
  blocked(["request", "receipt", "--request-id", "r", "--out", "o"]); // writes a signed bundle
  blocked(["sign", "--request-id", "r", "--token", "t"]);
  blocked(["approve", "--request-id", "r", "--token", "t"]);
  blocked(["signer", "decline"]);
  blocked(["signer", "reissue-token"]);
  blocked(["signer", "policy", "run", "--spec", "x"]);     // applies state
  blocked(["signer", "policy", "run-all"]);
  blocked(["pdf", "stamp", "--pdf", "x", "--out", "y"]);   // writes a PDF (only `pdf stamp verify` reads)
  blocked(["db", "rotate-keys"]);
  blocked(["db", "backup"]);
  blocked(["audit", "anchor"]);                            // contacts a TSA + writes
  blocked(["audit", "timestamp"]);
});

test("assertSignReadOnly: a mutating flag on an allowlisted read subcommand is blocked", () => {
  // The gap: the command prefix is read-only, but a flag turns it into a write.
  blocked(["request", "show", "--request-id", "r", "--repair"]);
  blocked(["audit", "verify", "--request-id", "r", "--apply"]);
  blocked(["signer", "policy", "try", "--spec", "x", "--write"]);
  blocked(["request", "rerun-policy", "--request-id", "r", "--force"]);
  blocked(["request", "list", "-y"]);
  blocked(["audit", "scan", "--set=foo"]);            // --flag=value form
  blocked(["request", "show", "--request-id", "r", "--token", "t"]);
  blocked(["request", "show", "--anchor"]);
});

test("assertSignReadOnly: benign flags on read subcommands still pass", () => {
  allowed(["request", "rerun-policy", "--request-id", "r"]);
  allowed(["audit", "search", "--request-id", "r", "--json"]);
  allowed(["request", "show", "--request-id", "r"]);
});

test("assertSignReadOnly: a leading global value-flag cannot smuggle a mutation past the gate", () => {
  blocked(["--provider", "local", "request", "create", "--title", "t"]);
  blocked(["--profile", "prod", "sign", "--request-id", "r", "--token", "t"]);
  // ...but a global flag in front of a real read op is still allowed
  allowed(["--provider", "local", "request", "show", "--request-id", "r"]);
});

test("assertSignReadOnly: empty args are blocked (no command = nothing read-only to run)", () => {
  blocked([]);
});

// --- NDA drafting & negotiation tools (added for review + negotiation support) ---
import { TOOLS } from "../contract-ops-mcp.mjs";

test("negotiation tools are exposed with well-formed schemas", () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  const expected = [
    "nda_setup", "generate_redlines", "draft_nda",
    "negotiate_status", "negotiate_review", "negotiate_diff", "negotiate_analyze", "negotiate_validate",
    "negotiate_init", "negotiate_counter", "negotiate_accept", "negotiate_finalize",
  ];
  for (const n of expected) {
    assert.ok(byName[n], `missing tool: ${n}`);
    assert.equal(byName[n].inputSchema.type, "object", `${n} schema not an object`);
    assert.equal(byName[n].inputSchema.additionalProperties, false, `${n} must forbid extra props`);
    assert.ok(byName[n].description.length > 20, `${n} needs a real description`);
  }
  // the three signing acts must be described as commitments (so the harness/agent knows)
  for (const n of ["negotiate_init", "negotiate_counter", "negotiate_accept"]) {
    assert.match(byName[n].description, /sign/i, `${n} should flag that it signs`);
  }
  // finalize must NOT apply an e-signature (legal signature stays human)
  assert.match(byName.negotiate_finalize.description, /legal SIGNATURE stays with the human|hand off/i);
});

test("vault browse/compose + obligations tools are exposed with well-formed schemas", () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  const expected = [
    "template_vault_list", "template_vault_info", "template_vault_diff", "template_vault_history",
    "template_vault_clauses", "template_vault_clause_library", "template_vault_compare_clauses",
    "template_vault_stats", "template_vault_verify", "template_vault_compose", "template_vault_swap", "template_vault_export",
    "contract_vault_obligations", "contract_vault_remind", "contract_vault_at_risk", "contract_vault_review",
    "contract_vault_verify", "contract_vault_export", "contract_vault_ingest", "contract_vault_obligation", "contract_vault_accept",
  ];
  for (const n of expected) {
    assert.ok(byName[n], `missing tool: ${n}`);
    assert.equal(byName[n].inputSchema.type, "object", `${n} schema not an object`);
    assert.equal(byName[n].inputSchema.additionalProperties, false, `${n} must forbid extra props`);
  }
  // writes must read as writes, reads as read-only, in their descriptions
  for (const n of ["template_vault_compose", "template_vault_swap", "contract_vault_ingest", "contract_vault_obligation", "contract_vault_accept"]) {
    assert.match(byName[n].description, /write/i, `${n} should say it writes`);
  }
  for (const n of ["template_vault_list", "contract_vault_obligations", "contract_vault_remind"]) {
    assert.match(byName[n].description, /read-only/i, `${n} should say read-only`);
  }
});

// --- completeness: every exposed tool is well-formed (guards against a new
//     tool shipping with a malformed/missing schema, and covers the legacy
//     tools that had no direct test) ---
test("every tool has a well-formed schema and a real description", () => {
  assert.ok(TOOLS.length >= 50, `expected the full tool set, got ${TOOLS.length}`);
  const seen = new Set();
  for (const t of TOOLS) {
    assert.equal(typeof t.name, "string");
    assert.ok(t.name.length > 0 && !seen.has(t.name), `duplicate/empty tool name: ${t.name}`);
    seen.add(t.name);
    assert.ok(typeof t.description === "string" && t.description.length > 20, `${t.name}: weak description`);
    assert.ok(t.inputSchema && t.inputSchema.type === "object", `${t.name}: inputSchema must be an object`);
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name}: must forbid extra props`);
    // every declared property must itself be a typed schema (no bare/empty props)
    for (const [k, v] of Object.entries(t.inputSchema.properties ?? {})) {
      assert.ok(v && (v.type || v.enum), `${t.name}.${k}: property needs a type or enum`);
    }
    // required entries must exist in properties
    for (const r of t.inputSchema.required ?? []) {
      assert.ok(t.inputSchema.properties?.[r], `${t.name}: required "${r}" not in properties`);
    }
  }
  // the seven previously-untouched tools are now covered by the loop above
  for (const legacy of ["convert_to_pdf", "audit_show", "verify_receipt", "template_vault_find", "template_vault_get", "contract_vault_query", "contract_vault_risk"]) {
    assert.ok(seen.has(legacy), `legacy tool missing from TOOLS: ${legacy}`);
  }
});
