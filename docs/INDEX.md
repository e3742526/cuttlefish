# Documentation Index

This index lists operator-facing docs that are maintained in this checkout.
Audit and session logs under `docs/audits/` and `docs/logs/` are local-only
artifacts unless explicitly published.

## Current Operator Docs

- `README.md`: public overview and install/use workflow.
- `CHANGELOG.md`: release/version history, including the failed `v0.1.0`
  pre-release and its non-installable status.
- `docs/INSTALL.md`: operator install matrix (Windows / macOS / Linux; npm,
  Homebrew, GitHub platform archives, source) including `scripts/install.ps1`
  and `scripts/package-windows.ps1`.
- `docs/RELEASING.md`: release contract for the npm package, GitHub platform
  archives, and Homebrew formula; documents the historical failed `v0.1.0`
  pre-release accurately.
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
- `docs/test_scenarios/README.md`: end-to-end playtest scenario library for
  exploratory user-facing test passes (derived from the `audit-playtest-app`
  baseline), plus per-surface scenario files under `docs/test_scenarios/`
  (`01`–`10` core surfaces; `11` model selection/switching; `12` failover;
  `13` inter-agent communication; `14` authorization/approvals; `15`
  stress/adversarial load; `16` autonomous operation and integrity boundaries;
  `17` operations/data lifecycle; `18` orchestration control-plane semantics;
  `19` manager handoff, operator-attention, and delegated-job completion;
  `20` session authority collision, arbitration, and human-notification semantics).
- `docs/test_scenarios/PLAYTEST_EXECUTION.md`: required disposable-state,
  capability-gate, evidence, cleanup, and reporting contract for executing the
  scenario library without overstating partial coverage.
- `docs/TODO_LEDGER.md`: current active documentation/governance TODO ledger.
- `docs/TODO_HISTORY.md`: closed defects and completed TODOs with preserved
  closure evidence.
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
- `docs/TWILIO_SMS.md`: Twilio SMS credential, sender, allowlist, and signed-webhook setup.
- `docs/orchestration/README.md`: provider-neutral matrix orchestration
  foundation, durable scheduler state, adapter contracts, CLI dry-run/observe
  commands, opt-in live run modes, git worktree execution, and orchestration
  HTTP routes.

## Session and Audit Log Summaries

- `docs/audits/072026/2026-07-20-leader-ack-root-cause-repair.md`: root-cause analysis and closure evidence for premature background callbacks, stale manager-synthesis suppression, and stale acknowledgement re-arming; also records the two-contact supervisor policy and cheap executive triage.
- `docs/audits/072026/2026-07-20-test-scenario-library-rigor-audit.md` and
  `docs/logs/session/072026/2026-07-20-test-scenario-library-rigor-expansion.md`:
  full 181-card structural/source audit, 26-card operations/control-plane
  expansion, and the confirmed orchestration CLI registration gap.
- `docs/audits/072026/2026-07-20-scenario-library-playtest.md` and
  `docs/audits/072026/2026-07-20-scenario-library-playtest-repair.md`: fresh
  disposable-home scenario-library playtest, its three confirmed CLI
  lifecycle/instance-reporting/JSON-stream findings, and their live-verified
  repair closure; the unavailable-browser limit remains recorded.
- `docs/audits/072026/2026-07-20-live-playtest-defect-repair.md` and
  `docs/logs/session/072026/2026-07-20-live-playtest-defect-repair.md`:
  repair record for the six confirmed lifecycle, skills, cron, routing, and
  CLI error-handling findings from the supplied live playtest report.
- `docs/audits/072026/2026-07-20-full-scenario-library-playtest.md` and
  `docs/logs/session/072026/2026-07-20-full-scenario-library-playtest.md`:
  225-card library review and disposable-home execution record; confirms
  web-turn accounting, checkpoint replay, orchestration CLI registration, and
  Skills add/idempotency defects while separating blocked browser/fixture work.
- `docs/audits/072026/2026-07-20-documentation-stewardship.md` and
  `docs/logs/session/072026/2026-07-20-documentation-stewardship.md`:
  source-grounded documentation reconciliation, including the active-only TODO
  ledger and the current weekly-schedule test failure.
- `docs/audits/072026/2026-07-20-team-approval-routing-repair.md` and
  `docs/logs/session/072026/2026-07-20-team-approval-routing-repair.md`:
  repair record for authenticated chat-originated org-change proposals and
  operator-only approval resolution.
- `docs/audits/072026/2026-07-20-hr-singleton-model-switch.md` and
  `docs/logs/session/072026/2026-07-20-hr-singleton-model-switch.md`:
  repair record for honoring selectable same-engine model and effort changes
  in the reusable HR chat.
- `docs/audits/072026/2026-07-20-coo-fable-default.md` and
  `docs/logs/session/072026/2026-07-20-coo-fable-default.md`:
  alignment of the virtual COO, default configuration, and Fable-to-Opus
  fallback policy.

- `docs/logs/session/072026/2026-07-20-fleetview-workers-dataview.md`:
  implementation and validation record for shareable Workers DataView URLs,
  derived presence, the accessible inspector, and built-browser coverage.

- `docs/audits/072026/2026-07-16-full-audit-repair-campaign.md`:
  current-source full repository audit; records twelve confirmed P1–P3
  findings, their repair dispositions, final regression evidence, and explicit
  residual validation limits.
- `docs/logs/session/072026/2026-07-16-full-audit-repair-campaign.md`:
  staged repair-campaign record for the full audit, including locality gates,
  adversarial reviews, commit boundaries, and final closure checks.
- `docs/logs/session/072026/2026-07-13-deferred-backlog-repair-campaign.md`:
  repair-campaign record for the reopened architecture, scheduler-integrity,
  work-state, and Workers DataView backlog items.
- `docs/logs/session/072026/2026-07-13-hr-human-only-routing-repair.md`:
  repair evidence for making HR / Org Steward human-only after the Program
  Manager playtest, including live rejection probes and full validation.
- `docs/logs/session/072026/2026-07-12-program-manager-live-playtest.md`:
  live Program Manager role playtest covering manual department-manager
  delegation from simple through complex scenarios; records the confirmed HR
  singleton parent-link failure and cleanup evidence.
- `docs/logs/session/072026/2026-07-12-agent-skills-audit-sweep.md`:
  extended current-branch MCP agent-skills audit summary; records ten confirmed
  baseline residuals, their local repair closure, and static-only UI/Giles limits.
- `docs/logs/session/072026/2026-07-12-agent-skills-defect-repair-campaign.md`:
  governed eight-stage repair record for all ten findings, including final
  regression evidence and local commit references.
- `docs/logs/session/072026/2026-07-12-twenty-scenario-live-playtest.md`:
  July 2026 live playtest summary — twenty gateway scenarios covering solo,
  review, failover, Grok recovery, and manager delegation; durable findings and
  repair plan are kept in the paired local audit record.
- `docs/logs/session/072026/2026-07-12-twenty-scenario-defect-repair.md`:
  repair-campaign record for the delegation-scope and review-lifecycle findings
  from that playtest.
- `docs/logs/session/062026-session-summary.md`: June 2026 durable session summary —
  multi-role execution, security hardening, kanban improvements, Qdrant, email,
  orchestration, and D1–D8 defect repair campaign (model alias, crash masking, UI fixes).

## FleetView Implementation Status

- `docs/plans/2026-07-10-fleetview-ux-implementation-plan.md`: the reference
  roadmap for the FleetView web dashboard. Phases 0–6 each have an implemented,
  scoped slice; remaining UX backlog and validation limits are deliberately
  deferred and recorded in their corresponding Giles feature-ledger entries.

## Historical Design And Planning Archives

## Historical Audit Baselines

- `docs/cloud-audit/AUDIT-BASELINE-2026-06-30.md`
- `docs/cloud-audit/AUDIT-SWEEP-2026-07-01.md`
- `docs/cloud-audit/FORK-READINESS-2026-06-30.md`
- `docs/cloud-audit/FULL-AUDIT-PLAYTEST-2026-07-10.md`
- `docs/cloud-audit/PLAYTEST-THEME-2026-07-01.md`
- `docs/cloud-audit/REPAIR-CAMPAIGN-2026-07-10.md`
- `docs/cloud-audit/SECURITY-FINDINGS-2026-06-30.md`
- `docs/cloud-audit/SECURITY-FINDINGS-audit-security-2026-07-02.md`
- `docs/cloud-audit/SYSTEM-EVALUATION-2026-07-04.md`

These are historical audit inputs. They retain their original observations and do
not override the canonical operator documentation or the active TODO ledger.

- `docs/plans/`: early Cuttlefish design, implementation, auth UX,
  security-hardening, and chat-redesign planning archives.
- `docs/superpowers/specs/`: feature design specs.
- `docs/superpowers/plans/`: detailed implementation plans.

Historical archives are not current operator workflow documentation. They may
describe superseded experiments and should not override `README.md`,
`docs/USER_MANUAL.md`, `docs/SPECIFICATION.md`, `docs/ARCHITECTURE.md`, or
`docs/feature_inventory.md`.
