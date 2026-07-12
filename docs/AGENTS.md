# docs/ subtree — AGENTS

Read and follow the repository-root `AGENTS.md` first (canonical, single
source of truth). This file only adds artifact-placement rules for the
`docs/` subtree and must not weaken the root; on any conflict, the root wins.
Loaded automatically by tools that read per-directory `AGENTS.md` (e.g.
Codex) when writing under `docs/`; advisory for other tools.

## Where each artifact goes (do not scatter)

- **Durable audit summary** → `docs/audits/` as `YYYY-MM-DD-<slug>.md`.
  NOT at the repo root and NOT in `logs/audits/`.
- **Human-authored session / handoff / activity log** →
  `docs/logs/session/<MMYYYY>/<YYYY-MM-DD>-<slug>.md` (e.g. `072026`).
  NOT in top-level `logs/` and NOT mixed into `docs/audits/`.
- **Unresolved defects / findings** → a session note under the repo's
  session-notes location; do not create a new top-level ledger file.

Keep the durable record current: update the month's summary and link new
operator docs from the docs index. Do not write generated compliance
artifacts or machine state under `docs/`.
