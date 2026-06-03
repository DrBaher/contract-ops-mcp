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

test("assertSignReadOnly: a leading global value-flag cannot smuggle a mutation past the gate", () => {
  blocked(["--provider", "local", "request", "create", "--title", "t"]);
  blocked(["--profile", "prod", "sign", "--request-id", "r", "--token", "t"]);
  // ...but a global flag in front of a real read op is still allowed
  allowed(["--provider", "local", "request", "show", "--request-id", "r"]);
});

test("assertSignReadOnly: empty args are blocked (no command = nothing read-only to run)", () => {
  blocked([]);
});
