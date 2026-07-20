# Documentation Inventory

| Path | Type | Status | Owner/Authority | Last Evidence | Action |
|---|---|---|---|---|---|
| `README.md` | public overview | canonical | maintainers | reconciled 2026-07-20 | Keep current; link durable docs and diagrams. |
| `docs/INDEX.md` | docs index | canonical | `AGENTS.md` docs rules | reconciled 2026-07-20 | Keep aligned with tracked docs and local-record index entries. |
| `docs/USER_MANUAL.md` | user manual | current | doc stewardship | reconciled 2026-07-20 | Maintain with CLI/UI changes. |
| `docs/SPECIFICATION.md` | specification | current | doc stewardship | reconciled 2026-07-20 | Keep requirements source-grounded. |
| `docs/ARCHITECTURE.md` | architecture | current | doc stewardship | reconciled 2026-07-20 | Update with gateway/runtime changes. |
| `docs/IMPLEMENTATION_DIAGRAMS.md` | diagrams | current | doc stewardship + Mermaid policy | created 2026-06-25 | Keep diagrams simple and evidenced. |
| `docs/TEST_LEDGER.md` | test evidence | current | CI + local validation | reconciled 2026-07-20 | Update after material test-suite changes. |
| `docs/TODO_LEDGER.md` | active TODO ledger | current | doc stewardship | reconciled 2026-07-20 | Keep only active Cuttlefish items with source and exit criteria. |
| `docs/TODO_HISTORY.md` | closure history | current | doc stewardship | created 2026-07-20 | Preserve completed Cuttlefish defects/TODOs and their closure evidence. |
| `docs/DECISION_LOG.md` | decisions | current | maintainers | created 2026-06-25 | Add accepted/superseded decisions as they land. |
| `docs/DOC_MAINTENANCE.md` | docs maintenance contract | current | `AGENTS.md` docs rules | created 2026-06-25 | Follow before releases. |
| `docs/STRUCTURE_COMPLIANCE.md` | structure report | current | repo contract + Giles | reconciled 2026-07-20 | Re-run after retention-policy changes or a Giles refresh. |
| `docs/UPSTREAM_DIFF_BASELINE.md` | upstream diff report | current | git diff against configured upstream baseline | created 2026-06-25 | Refresh after upstream syncs or public release cuts. |
| `docs/LOG_ARCHIVE.md` | log archive index | current | repo local-log convention | reconciled 2026-07-20 | Index local raw paths and Cuttlefish audit artifacts. |
| `docs/feature_inventory.md` | feature/API inventory | current | documentation rules | reconciled 2026-07-20 | Keep current with public surfaces. |
| `docs/test_scenarios/README.md` | playtest scenario library index | current | playtest / QA stewardship | extended 2026-07-20 | Keep file table and coverage checklist aligned with scenario cards. |
| `docs/test_scenarios/01-*.md` … `10-*.md` | core surface scenario cards | current | playtest / QA stewardship | baseline library | Do not silently rewrite executed cards mid-pass; add new files for new themes. |
| `docs/test_scenarios/11-model-selection-and-switching.md` | model selection scenarios | current | playtest / QA stewardship | added 2026-07-20 | Exercise composer/session model honesty, aliases, HR singleton rules. |
| `docs/test_scenarios/12-failover-and-fallback.md` | failover scenarios | current | playtest / QA stewardship | added 2026-07-20 | Exercise same-engine fallback, role chains, loss policies, orchestration headroom. |
| `docs/test_scenarios/13-inter-agent-communication.md` | inter-agent scenarios | current | playtest / QA stewardship | added 2026-07-20 | Exercise delegation, talk, cross-dept services, mid-pair, HR exclusion. |
| `docs/test_scenarios/14-authorization-and-approvals.md` | authz/approvals scenarios | current | playtest / QA stewardship | added 2026-07-20 | Exercise operator-only resolution, pairing auth modes, scoped tokens, checkpoint vocabulary. |
| `docs/test_scenarios/15-stress-and-adversarial.md` | stress scenario cards | current | playtest / QA stewardship | extended 2026-07-20 (SX-01–SX-32) | Concurrency caps, stampedes, restart-under-load, path/export/budget seams, hard-kill, history bloat, clock jump, unicode org storm. |
| `docs/script-surface-map.md` | script safety map | current | documentation rules | reconciled 2026-07-20 | Update when scripts/CLI commands change. |
| `docs/known-diagnostics.md` | accepted diagnostics | current | audit rules | inspected 2026-06-25 | Keep scoped to accepted non-actionable diagnostics. |
| `docs/engines-hermes.md` | engine-specific manual | current | source/tests | inspected 2026-06-25 | Update when Hermes contract changes. |
| `docs/orchestration/README.md` | orchestration design/ops | current | source/tests | inspected 2026-06-25 | Keep aligned with orchestration routes/CLI. |
| `docs/plans/` | historical plans | historical | maintainers | root plan docs moved here 2026-06-26 | Preserve; do not treat as current truth. |
| `docs/plans/2026-07-10-fleetview-ux-implementation-plan.md` | FleetView UX/UI roadmap | current implementation reference | Giles ledgers 0011–0017 | phases 0–6 landed 2026-07-10 | Retain as the reference roadmap; phase-ledger entries record scoped implementation and residual backlog. |
| `docs/superpowers/` | historical specs/plans | historical | maintainers | inventory scan 2026-06-26 | Preserve only when useful; obsolete onboarding demo workflow docs were removed during Cuttlefish cleanup. |
| `docs/audits/` | raw audit details | local-only | `AGENTS.md` audit retention | present on disk, ignored | Do not publish raw details unless explicitly selected. |
| `docs/logs/` | raw session logs | local-only | `AGENTS.md` session retention | present on disk, ignored | Do not publish raw details unless explicitly selected. |
| `.github/CONTRIBUTING.md` | contributor guide | current after patch | maintainers | updated 2026-06-25 | Keep Vite/gateway workflow accurate. |
| `packages/cuttlefish/README.md` | npm package README | current | package maintainers | inspected 2026-06-25 | Keep synchronized with root README where useful. |
