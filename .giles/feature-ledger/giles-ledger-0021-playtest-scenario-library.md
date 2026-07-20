# Giles Feature Ledger — Entry 0021

## Feature ID
`playtest-scenario-library`

## Short Action Summary
Authored a standing end-to-end playtest scenario library under `docs/test_scenarios/`, derived from the `agent-skills` `010_audit/audit-playtest-app` skill as methodology baseline (evidence discipline, scenario-card format, severity scale, safety rails). The library scopes coverage to user-facing run-the-app behavior not detectable by the repo's static audits, unit tests, or existing Playwright specs: first-run/lifecycle, chat sessions, org/delegation, kanban, cron, skills, connectors (Slack/WhatsApp/Twilio/IMAP), approvals/orchestration, settings/files/navigation, and CLI robustness. Scenarios are grounded in `README.md`, `docs/USER_MANUAL.md`, and `docs/feature_inventory.md`. No scenarios were executed in this change; this is documentation only. Added an index pointer in `docs/INDEX.md`.

## Touched Files
- `docs/test_scenarios/README.md`
- `docs/test_scenarios/01-first-run-and-lifecycle.md`
- `docs/test_scenarios/02-chat-sessions.md`
- `docs/test_scenarios/03-org-employees-delegation.md`
- `docs/test_scenarios/04-kanban-tickets.md`
- `docs/test_scenarios/05-cron-scheduling.md`
- `docs/test_scenarios/06-skills.md`
- `docs/test_scenarios/07-connectors-email-sms.md`
- `docs/test_scenarios/08-approvals-orchestration.md`
- `docs/test_scenarios/09-settings-files-navigation.md`
- `docs/test_scenarios/10-cli-surface.md`
- `docs/INDEX.md`
- `.giles/feature-ledger/giles-ledger-0021-playtest-scenario-library.md`

## Validation Run
- Documentation-only change; no runtime code touched, so no unit/e2e suites apply.
- Cross-checked every dashboard route, CLI command, and feature named in the scenarios against `docs/USER_MANUAL.md`, `docs/feature_inventory.md`, and `README.md` in this checkout.
- Verified all relative links in `docs/test_scenarios/README.md` resolve to files created in this change.

## Remaining Open Items
- Execute a first full pass against a disposable Cuttlefish home and record results as a playtest report under `docs/audits/`.
- Connector scenarios (file 07) require sandbox credentials; they will be recorded as Not executed until such an environment exists.

## Provenance
- Authored by a cloud/remote agent (no local Giles/Dory access; Giles requirements waived per `AGENTS.md`, ledger entry written voluntarily for continuity). Methodology baseline: `agent-skills` repo, `010_audit/audit-playtest-app/` (SKILL.md, templates, checklists), read directly in-session.
