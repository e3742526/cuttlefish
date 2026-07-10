# Documentation Index

This index lists operator-facing docs that are maintained in this checkout.
Audit and session logs under `docs/audits/` and `docs/logs/` are local-only
artifacts unless explicitly published.

## Current Operator Docs

- `README.md`: public overview and install/use workflow.
- `docs/USER_MANUAL.md`
- `docs/QDRANT_SETUP.md`: maintained user manual for setup, workflows,
  persistence, recovery, and troubleshooting.
- `docs/ARCHITECTURE.md`: current architecture summary, component map,
  persistence map, boundaries, risks, and extension points.
- `docs/SPECIFICATION.md`: source-grounded product specification with
  requirement IDs and validation requirements.
- `docs/IMPLEMENTATION_DIAGRAMS.md`: Mermaid diagrams for runtime, docs, and API
  routing.
- `docs/feature_inventory.md`: implemented CLI/API/UI surfaces and fidelity gaps.
- `docs/TEST_LEDGER.md`: current validation evidence and test coverage map.
- `docs/TODO_LEDGER.md`: current active documentation/governance TODO ledger.
- `docs/DECISION_LOG.md`: accepted and deferred documentation/governance
  decisions.
- `docs/DOC_MAINTENANCE.md`: documentation update contract for future changes.
- `docs/DOCUMENTATION_INVENTORY.md`: inventory of canonical, current,
  historical, local-only, and generated documentation surfaces.
- `docs/STRUCTURE_COMPLIANCE.md`: documentation structure and retention-policy
  compliance report.
- `docs/UPSTREAM_DIFF_BASELINE.md`: source-grounded comparison between this
  checkout and the configured upstream baseline.
- `docs/LOG_ARCHIVE.md`: raw-log retention policy and durable summary index.
- `docs/agent/mermaid-diagram-guidance.md`: local guidance for Mermaid diagrams
  in architecture and workflow docs.
- `docs/polish/polish-report.md`: latest code-polish stewardship report and
  linked baseline artifacts.
- `docs/known-diagnostics.md`: accepted non-actionable diagnostics that future
  audits should not re-report unless explicitly scoped.
- `docs/script-surface-map.md`: authoritative classification of npm scripts and CLI
  subcommands by destructiveness, interactivity, and suitability for automated sweeps;
  supersedes any generated surface-metadata that conflicts with it.
- `docs/engines-hermes.md`: Hermes engine behavior and caveats.
- `docs/orchestration/README.md`: provider-neutral matrix orchestration
  foundation, durable scheduler state, adapter contracts, CLI dry-run/observe
  commands, opt-in live run modes, git worktree execution, and orchestration
  HTTP routes.

## Session and Audit Log Summaries

- `docs/logs/session/062026-session-summary.md`: June 2026 durable session summary —
  multi-role execution, security hardening, kanban improvements, Qdrant, email,
  orchestration, and D1–D8 defect repair campaign (model alias, crash masking, UI fixes).

## Active Proposals

- `docs/plans/2026-07-10-fleetview-ux-implementation-plan.md`: current (proposed,
  not yet implemented) UX/UI implementation plan for the FleetView web dashboard —
  taxonomy, layout, interaction, state-contract, and phased roadmap. Unlike the
  rest of `docs/plans/`, this is an active proposal, not a historical archive;
  move it to the archive set once implemented or superseded.

## Historical Design And Planning Archives

- `docs/plans/`: early Cuttlefish design, implementation, auth UX,
  security-hardening, and chat-redesign planning archives.
- `docs/superpowers/specs/`: feature design specs.
- `docs/superpowers/plans/`: detailed implementation plans.

Historical archives are not current operator workflow documentation. They may
describe superseded experiments and should not override `README.md`,
`docs/USER_MANUAL.md`, `docs/SPECIFICATION.md`, `docs/ARCHITECTURE.md`, or
`docs/feature_inventory.md`.
