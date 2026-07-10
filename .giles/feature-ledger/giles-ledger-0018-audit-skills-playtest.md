# Feature Ledger: audit-skills-playtest

**feature id:** `audit-skills-playtest`

## Full 010_audit sweep + orchestration playtest (2026-07-10)

**action summary:** Applied 37 applicable `010_audit` skill playbooks (of 41; 4 documented N/A) as read-only, evidence-first code audits across the Cuttlefish daemon, contracts, and web packages, and ran a live orchestration playtest (onboarding, deletion, intra/inter-department delegation, authority conflicts, supervisor tiers). Produced a consolidated findings + playtest report. No product source was modified.

**status:** complete (audit/report only — remediation not applied)

**touched files:**
- `docs/cloud-audit/FULL-AUDIT-PLAYTEST-2026-07-10.md` — new consolidated audit + playtest report (~100 findings, ranked, with file:line evidence)
- (transient, not committed) built `packages/contracts/dist` for test resolution; created + removed a throwaway vitest playtest driver under `packages/cuttlefish/src/__playtest__/` — repo left clean of it

**validation run:**
- `pnpm install` (Node 24.13.0 auto-provisioned via `.pnpmrc use-node-version`; node-pty + better-sqlite3 built clean)
- `pnpm --filter @cuttlefish/contracts build`
- `pnpm exec vitest run` on the scenario-mapped suites — **152 tests PASS** across: `org-manager-route`, `org-delete-route`, `onboarding-policy`, `org-lifecycle`, `org-hierarchy` (onboarding/deletion, 50); `manager-delegation`, `manager-delegation-enforcement`, `delegate`, `org-worker-bridge`, `ticket-dispatch-route`, `ticket-dispatch-idempotency` (intra-dept + supervisor→worker, 40); `org-cross-request-route`, `org-approval-route`, `org-changes` (inter-dept, 12); `manager-auth`, `org-policy`, `queue-cancel-scope`, `approvals` (conflicts/authority, 38); `leader-ack-reconciler`, `orchestration-runtime-manager` (supervisor↔supervisor, 12)
- Bespoke exploratory driver confirmed live: onboarding **accepts and persists** `cliFlags:["--dangerously-skip-permissions", …]` (no dangerous-flag denylist); onboarding **rejects** valid Claude model names (`sonnet`/`haiku`) in a fresh env (static model catalog); malformed onboarding correctly rejected; raw `deleteEmployeeYaml` has no reports-guard (guard is route-only)

**remaining open items (for a future repair pass, not done here):**
- P0 trust-boundary: require gateway auth regardless of bind (F-01); denylist MCP `command` + `cliFlags` on the spawn path (F-02/A-F2/F-10); realpath control-plane write/secret-read blocks covering Bash + `config.yaml` (F-03/G-01/G-06); remove the "example" screening downgrade + fail-closed on missing reviewer + screen ticket/email paths (D-F1/D-F2/G-04/G-07)
- P1 orchestration: reconcile persistent-scheduler/board deltas vs DB or single-writer + DB-authoritative IDs (C-01/I-5); route every execution turn through the mid_pair tier, not just turn 1 (I-2); enforce read_only reviewer at construction (A-F1/I-1); route all `transport_meta` writes through `patchSessionTransportMeta` (I-4); add orchestration health probe + feed back connector-send failures (H1/H3)
- P2: validate model-emitted card URLs / disable remote-image auto-load (G-02/I-3); widen onboarding model catalog; move delete reports-guard into the util; STT checksum + IMAP timeout; a11y + governance-honesty cleanups

**provenance:** original — multi-agent read-only audit of the working tree at commit `93b0366` on branch `claude/audit-skills-playtest-4fngtj`, plus executed vitest playtest. Findings are first-hand (file:line read); runtime effects labelled Likely/Potential per audit calibration. Cloud/remote session — Giles/Dory tooling not invoked (waived per CLAUDE.md); this ledger entry authored per the repo-local feature-ledger requirement.
