# Changelog

All notable changes to **contract-ops-mcp** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to semantic
versioning once it leaves 0.x.

## 0.1.2 — 2026-05-31

### Changed
- `review_nda` now invokes `nda-review-cli review` with `--json` (plus `--why`) and
  returns the parsed structured report (`decision`, `risk_score`, `findings` with
  per-finding `evidence`) — matching the JSON contract of `extract_contract`,
  `lint_contract`, and `compare_versions` instead of returning free text. Requires
  `nda-review-cli >= 0.5.2`.

### Tests / CI
- Added a real-CLI integration test for `review_nda` (asserts the parsed-JSON shape and
  `--why` explainability evidence); the CI integration job now installs
  `nda-review-cli >= 0.5.2` alongside `contract-lint`.

## 0.1.1 — 2026-05-24

### Changed
- Release pipeline now publishes via **npm OIDC Trusted Publishing** (no long-lived
  `NPM_TOKEN`). No change to the server or its tools.

## 0.1.0 — 2026-05-23

### Added
- First release: one MCP (stdio) server for the whole contract-ops suite. Connect once
  (`npx -y contract-ops-mcp`) and an agent gets all nine CLIs as tools.
- **Curated tools** (typed inputs, JSON out): `extract_contract`, `lint_contract`,
  `compare_versions`, `fill_template`, `convert_to_pdf`, `review_nda`,
  `template_vault_find` / `template_vault_get`, `contract_vault_query` /
  `contract_vault_due` / `contract_vault_risk`, and the read-only
  `verify_signature` / `verify_receipt` / `audit_show`.
- **Escape hatches**: `catalog(cli)` (a CLI's full `--catalog json`) and
  `run(cli, args)` for the long tail; `suite_status` reports installed CLIs + versions.
- **Signing is human-gated** — only sign-cli's read/verify ops are exposed; never
  request-create/sign (those stay behind sign-cli's own MCP + per-signer tokens).
- **Filesystem lockdown** via `CONTRACT_OPS_MCP_BASE_DIR`; no-shell `execFile`.
- Discovery-driven: tools ride the suite's uniform `<bin> --catalog json` contract.
