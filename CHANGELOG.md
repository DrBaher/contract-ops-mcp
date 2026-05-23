# Changelog

All notable changes to **contract-ops-mcp** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to semantic
versioning once it leaves 0.x.

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
