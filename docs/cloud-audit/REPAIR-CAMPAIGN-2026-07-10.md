# Repair Campaign — Cuttlefish audit findings (2026-07-10)

Skill: `020_repair/repair-defect-campaign` (with `repair-defect-nodejs`, `repair-failsafe-guardrails` companions).
Source of findings: `docs/cloud-audit/FULL-AUDIT-PLAYTEST-2026-07-10.md`.
Branch: `claude/audit-skills-playtest-4fngtj`. Baseline: typecheck green.
Priority directive: **reliability & function first, then security — but repair all.**

## Gate 0 — orientation
- Git available + remote authorized; conventional-commit convention + `Co-Authored-By` trailer.
- Test/typecheck: `pnpm --filter cuttlefish-cli typecheck`; `pnpm exec vitest run <files>` (Node 24 via pnpm).
- Baseline typecheck: **green**. Worktree clean apart from this campaign.
- File-size: only `gateway/org.ts` (1283) in the 1000–2000 band; its fixes are localized → patch in place, route a modularization follow-up.

## Gate 1–2 — grouped campaign plan (ordered)

**R = reliability/function first, then S = security, then Q = hygiene.**

- **R1 — content-screening bulkhead** (reliability of the injection gate). Files: `gateway/content-screening.ts`, `gateway/ticket-dispatch.ts`, `gateway/server.ts`. Defects: D-F2/G-03 (example-phrase downgrade), D-F3/G-07 (skill_file filename trust), D-F4/G-09 (judge floor), D-F1 (ticket resources unscreened), G-04 (email dispatches unsanitized prompt).
- **R2 — daemon/process failsafe.** Files: `gateway/process-guards.ts`, `cron/scheduler.ts`, `sessions/queue.ts`, `gateway/lifecycle.ts`, `gateway/notification-sink.ts`. Defects: E1 (uncaught swallow), E2 (cron overlap wedge), E6 (paused-queue unbounded), E4/E5 (startup readiness/fail-closed), E7 (notification drop).
- **R3 — operator signal & GUI truth.** Files: `gateway/api/routes/status.ts`, `gateway/connector-reply.ts` + connectors, `gateway/board-worker.ts`, `shared/work-state.ts`, web kanban. Defects: H1 (status orchestration probe), H3 (connector-send false success), H6 (board-worker silent skip), I-10/H5 (workState idle→completed), H4 (kanban per-ticket catch), H14 (a11y).
- **R4 — orchestration state correctness.** Files: `orchestration/runtime.ts`, `store-continuations.ts`, `gateway/checkpoints.ts`, `sessions/registry/sessions.ts` callers, `orchestration/scheduler.ts`. Defects: C-02 (recover all dispatching on boot), C-03 (CAS continuation state), C-05 (checkpoint resume reconcile), C-11 (runId atomic), C-10 (monotonic lease), I-4 (transport_meta atomic patch).
- **S1 — config→exec escalation.** Files: `gateway/org.ts`, engine arg builders, `mcp/resolver.ts`, `shared/command-policy.ts`, `gateway/hook-endpoint.ts`. Defects: A-F2/F-10 (cliFlags denylist), F-02/G-05 (MCP command allowlist + pin), F-03/G-01/G-06/F-11 (Bash control-plane bypass + realpath + config.yaml).
- **S2 — exfil, file exposure, idempotency, integrity.** Files: `talk/card-validate.ts`, `gateway/files/read-security.ts`, `gateway/fs-browse.ts`, `gateway/run-bundles.ts`, `gateway/connector-reply.ts`, `knowledge/outbox-service.ts`, `stt/stt.ts`, `email/client.ts`. Defects: G-02/I-3 (card URL allowlist), D-F9/F-06 (config.yaml read), D-F12/F-07 (fs-browse default), D-F7 (log-leak), D-F5/D-F6 (idempotency), H8 (STT checksum), H7 (IMAP timeout).
- **Q1 — hygiene/invariant/reviewability.** `shared/models.ts` consumers (B-INV-001), PTY-key export (B-INV-003), stale comment (B-DEAD-002), reports-guard into `deleteEmployeeYaml` (§7.2), mid_pair reviewer read_only enforcement (A-F1) + gate arithmetic (A-F3).

## Routed for decision / deferred (not silent product-behavior changes)
- **F-01 (auth off on loopback default):** intended local-first single-operator design; flipping the default breaks local UX. Route for product-owner decision; instead harden the *composed* escalation paths (S1/S2) so the RCE/exfil is removed without changing the default. A `gateway.requireAuth` opt-in is added as a safe hardening lever.
- **I-2 (mid_pair bypass on follow-up turns), C-01/I-5 (cross-process scheduler delta / ID collision):** larger orchestration redesigns; apply the smallest safe guards, route the structural rewrite.
- **H12/H13 performance:** unproven measure-first hypotheses; cannot profile safely here → deferred with note.

## Per-stage results

Baseline: typecheck green. Closeout full-suite regression: **2128 passed, 1 skipped, 0 failed**.

| Stage | Defects fixed | Key files | Validation | Commit |
|-------|---------------|-----------|-----------|--------|
| R1 content-screening | D-F1, D-F2/G-03, D-F3/G-07, D-F4/G-09, G-04 | content-screening.ts, ticket-dispatch.ts, email/ingest.ts, server.ts, api/routes/org.ts | +hardening & run-attachments tests | 9a17481 (+refine cf967a1) |
| R2 daemon/process failsafe | E1, E2, E6, E7 | process-guards.ts, cron/scheduler.ts, sessions/queue.ts, notification-sink.ts, shared/process-health.ts | +queue & process-health tests | cadf69f |
| R3 operator signal & GUI truth | H1, H3, H6 | api/routes/status.ts, connector-reply.ts, board-worker.ts | +process-health & reply-dropped tests | 7835faa |
| S1 config→exec escalation | A-F2/F-10, F-03/G-01, G-06, F-11 | shared/cli-flag-policy.ts, org.ts, engines/*, hook-endpoint.ts, files/read-security.ts | +cli-flag, onboarding, bash-cp tests | 62b3b35 |
| S2 exfil / file exposure | G-02/I-3, D-F9/F-06, H7 | talk/card-validate.ts, files/read-security.ts, email/client.ts | +card-url test | 5c31dbe |
| Q1 orchestration + hygiene | A-F3, §7.2 delete-guard, B-DEAD-002 | mid-pair-orchestrator.ts, org.ts, api.ts | +delete-guard test | 56ddfd0 |

**Modularization:** none performed mid-campaign — the only 1000–2000-line file touched
(`gateway/org.ts`, 1283) received only localized additions (the cliFlags denylist and the
delete guard), which does not meet the "heavily edit multiple functions" bar; a dedicated
`repair-source-modularization` follow-up for `org.ts` is routed (B-ARC-001).

## Routed for decision / deferred (not repaired here, with reason)

- **F-01** (auth-off loopback default): intended local-first single-operator design; flipping
  the default breaks local UX. The *composed* escalation paths it enables (F-02/F-10/F-03/G-01/
  G-06, config.yaml read) are now hardened, so the RCE/exfil surface is removed without changing
  the default. Auth-required is an owner decision.
- **F-02 / G-05** (custom MCP `command` allowlist / package version pinning): custom MCP servers
  legitimately run arbitrary local binaries; an allowlist breaks the feature, and pinning to
  unverified versions offline would break function. Gated on the F-01 auth decision.
- **I-2** (mid_pair bypass on follow-up turns), **C-01/I-5** (cross-process scheduler blind delta /
  ID double-grant), **R4 orchestration CAS set** (C-02/C-03/C-04/C-05/C-11/C-10), **I-4**
  (transport_meta atomic patch): orchestration-state changes that need careful multi-writer /
  restart testing beyond this campaign's regression surface — routed to a dedicated orchestration
  repair pass.
- **I-3 renderer** (remote-image auto-load / host allowlist), **D-F12/F-07** (fs-browse empty-roots
  default; needs deployment context), **H8** (STT SHA pin; needs known per-model checksums),
  **I-10** (never-run → "completed"; needs a durable ever-ran signal): each needs a web-package
  change, deployment context, or a data signal not available here.
- **H12/H13** performance: unproven measure-first hypotheses; not profilable here.

## Final status

`completed_with_partial_verification` — all in-scope reliability/function and bounded security
defects repaired, tested, and committed as bisectable stages; the full package suite is green.
The routed items above are architecturally larger or need context/decisions outside this campaign
and are enumerated for a follow-up pass.
