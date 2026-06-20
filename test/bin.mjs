// Bug #1 regression: the bin must start when launched through a SYMLINK, the way
// npm's bin shim (node_modules/.bin/contract-ops-mcp) — and therefore every MCP
// client and `npx` — actually invokes it. Through a symlink, process.argv[1] is
// the link path while import.meta.url is the realpath Node resolved; the old
// `import.meta.url === \`file://${process.argv[1]}\`` guard compared those raw
// and was false, so main() never ran and the process exited 0 with no output.
//
// The existing smoke/integration tests only ever launch the module by its real
// path (args: [".../contract-ops-mcp.mjs"]), so they never exercised the resolved
// bin — the same blind spot that let the SignWell findings ship. This closes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE = join(dirname(fileURLToPath(import.meta.url)), "..", "contract-ops-mcp.mjs");

// Launch `node <path>`, capture stderr, resolve once the readiness line appears
// or the process exits — whichever comes first.
function launch(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => { done({ ready: /ready/.test(stderr), stderr, exited: false }); child.kill("SIGKILL"); }, 5000);
    child.stderr.on("data", (d) => {
      stderr += d;
      if (/ready/.test(stderr)) { clearTimeout(timer); done({ ready: true, stderr, exited: false }); child.kill("SIGKILL"); }
    });
    child.on("exit", (code) => { clearTimeout(timer); done({ ready: /ready/.test(stderr), stderr, exited: true, code }); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

test("starts when launched through a bin symlink (not just the real path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cops-bin-"));
  const link = join(dir, "contract-ops-mcp");
  symlinkSync(MODULE, link);
  try {
    const r = await launch(link);
    assert.ok(r.ready, `server never announced readiness via the symlink — stderr: ${JSON.stringify(r.stderr)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("still starts when launched by its real path", async () => {
  const r = await launch(MODULE);
  assert.ok(r.ready, `server never announced readiness via the real path — stderr: ${JSON.stringify(r.stderr)}`);
});
