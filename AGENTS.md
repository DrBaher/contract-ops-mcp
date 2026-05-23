# Agents

`contract-ops-mcp` is itself an agent surface: an MCP (stdio) server that exposes the nine contract-ops CLIs as tools. This file is the contract for an agent (or its operator) driving it.

## Discovery
- Call **`suite_status`** first — it reports which CLIs are installed, their versions, and the install command for any that are missing. A tool whose CLI isn't installed returns a clear install hint (not a crash).
- Beyond the curated tools, **`catalog(cli)`** returns that CLI's full `<bin> --catalog json` (`{name, bin, version, description, commands|flags, exitCodes}`), and **`run(cli, args)`** executes any command. Don't hardcode the long tail — discover it.

## Output contract
- Every tool returns a single text block of **JSON**: `{ exitCode, result | output, stderr? }`. `result` is the parsed CLI JSON when the underlying command emitted JSON; otherwise `output` is the text.
- **Branch on `exitCode`, not on prose.** Exit codes are NOT uniform across the suite — e.g. `compare_versions` uses `0` clean / `2` substantive drift / `3` cosmetic / `4` moved; `lint_contract` uses `0` clean / `1` findings; `extract_contract` `1` = low-signal (still valid JSON). A non-zero exit is often a *finding/gate result*, not a failure — the JSON is still returned. Tool errors (bad input, missing CLI, path escape) set `isError: true`.

## Safety boundaries (important)
- **Signing is human-gated and cannot be performed through this server.** Only read/verify ops are exposed (`verify_signature`, `verify_receipt`, `audit_show`). To request or apply a signature, use [sign-cli](https://github.com/DrBaher/sign-cli)'s own MCP server, which gates the human gesture behind a per-signer, single-use approval token the agent never holds.
- **File access is confined to `CONTRACT_OPS_MCP_BASE_DIR`** (default: cwd). Curated tools reject paths that escape it. The `run` escape hatch passes args verbatim (no shell) but is the operator's responsibility.
- All CLIs are local-first and run on the host with the user's permissions — no network on the default paths (opt-in `--llm` tiers excepted, via the shared `~/.config/contract-ops/llm.json`).

## Typical loop
1. `suite_status` → confirm the tools you need are available.
2. `extract_contract` foreign paper → JSON; or `template_vault_get` + `fill_template` to author.
3. Gate before signing: `lint_contract` (defects within the doc) and `compare_versions` (drift between versions).
4. Hand off to a human for signing (sign-cli MCP); afterward `verify_signature` / `audit_show` and track deadlines with `contract_vault_due` / `contract_vault_risk`.
