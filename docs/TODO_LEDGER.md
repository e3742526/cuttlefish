# TODO Ledger

This ledger is the authoritative list of active documentation/governance TODOs
for this checkout. It intentionally excludes inherited upstream-era TODO notes
and historical planning ideas unless they have been re-opened for Cuttlefish
with current evidence and exit criteria.

Sources: 2026-06-28 six-lens structural audit (STT/PIP/NEG/FSR/ARC/INV prefixes);
2026-06-28 Gemini input/output-path audit (IOP prefix);
2026-06-28 connector-removal verification audit (CON prefix);
2026-06-28 connector-removal follow-up audit (CRF prefix, merged into CON IDs below);
2026-06-29 architecture audit (ARC-CUT prefix);
2026-06-29 defect repair campaign (TST prefix).

| ID | Status | Priority | Area | Brief Description | Evidence | Opened |
|---|---|---|---|---|---|---|
| IOP-CF-002 | closed | critical | security | Discord attachment traversal surface removed by deleting the Discord connector. | `packages/cuttlefish/src/connectors/discord/` removed | 2026-06-28 |
| STT-CF-001 | closed | critical | state-machine | Org change apply now rejects non-approvable states before dispatch. | `gateway/api/routes/org.ts`, `gateway/hr-steward.ts` | 2026-06-28 |
| STT-CF-002 | closed | critical | state-machine | `markExternalOutboxDelivered()` now only transitions rows still in `sending`. | `sessions/registry/external-outbox.ts` | 2026-06-28 |
| FSR-CF-001 | closed | critical | reliability | Daemon config load now exits with a friendly startup error instead of a raw crash. | `gateway/daemon-entry.ts` | 2026-06-28 |
| IOP-CF-001 | closed | high | security | `isAllowedReadPath` now resolves symlinks before root containment checks. | `gateway/files/read-security.ts` | 2026-06-28 |
| IOP-CF-004 | closed | high | security | `isServablePath` now resolves symlinks before managed-storage containment checks. | `gateway/files/storage.ts` | 2026-06-28 |
| STT-CF-003 | closed | high | state-machine | `markExternalOutboxFailed()` is now transactional and status-gated. | `sessions/registry/external-outbox.ts` | 2026-06-28 |
| PIP-CF-001 | closed | high | reliability | Slack handler calls now log synchronous exceptions instead of silently dropping messages. | `connectors/slack/index.ts` | 2026-06-28 |
| NEG-CF-001 | closed | high | concurrency | HR critique session creation now uses a shared promise mutex. | `gateway/hr-steward.ts` | 2026-06-28 |
| FSR-CF-002 | closed | high | reliability | CUTTLEFISH_HOME creation now surfaces a clear permission error. | `gateway/auth.ts` | 2026-06-28 |
| ARC-CF-001 | deferred | high | architecture | Deferred to a dedicated architecture refactor campaign. | `sessions/manager.ts`, `docs/DECISION_LOG.md` | 2026-06-28 |
| IOP-CF-003 | closed | medium | security | Custom upload paths now fail if the target file already exists. | `gateway/files/uploads.ts` | 2026-06-28 |
| PIP-CF-002 | closed | medium | reliability | Email auto-ingest now routes synchronous throws into the async error path. | `email/service.ts` | 2026-06-28 |
| PIP-CF-003 | closed | medium | reliability | HR critique failures now mark the request `error` instead of auto-applying. | `gateway/hr-steward.ts`, `shared/types/org-change.ts` | 2026-06-28 |
| NEG-CF-002 | closed | medium | security | Email auto-ingest now records Authentication-Results and skips SPF/DKIM failures. | `email/normalize.ts`, `email/service.ts`, `email/store.ts` | 2026-06-28 |
| NEG-CF-004 | closed | medium | reliability | Daemon startup now acquires a lock file and refuses a second live instance. | `gateway/lifecycle.ts` | 2026-06-28 |
| FSR-CF-003 | closed | medium | reliability | Node version fallback now logs at error severity with an explicit remediation message. | `gateway/lifecycle.ts` | 2026-06-28 |
| ARC-CF-002 | deferred | medium | architecture | Deferred to a dedicated architecture refactor campaign. | `gateway/hr-steward.ts`, `docs/DECISION_LOG.md` | 2026-06-28 |
| ARC-CF-003 | deferred | medium | architecture | Deferred to a dedicated architecture refactor campaign. | `gateway/auth.ts`, `docs/DECISION_LOG.md` | 2026-06-28 |
| INV-CF-001 | closed | low | invariants | Listable approval types are now explicit in code and documented at the list route. | `shared/types/operations.ts`, `gateway/api/routes/approvals.ts` | 2026-06-28 |
| PIP-CF-004 | closed | low | reliability | Fire-and-forget connector reply deliveries now log failed relay attempts. | `gateway/run-web-session.ts` | 2026-06-28 |
| NEG-CF-003 | closed | low | operator-ux | Email polling now warns when auto-ingest is enabled without any allowlist. | `email/service.ts` | 2026-06-28 |
| NEG-CF-005 | closed | low | reliability | Daemon startup now probes `node-pty` and logs a clear warning when PTY support is unavailable. | `gateway/daemon-entry.ts`, `engines/pty-stream.ts` | 2026-06-28 |
| ARC-CF-004 | deferred | low | architecture | Deferred to a dedicated architecture refactor campaign. | `gateway/api/routes/connectors.ts`, `docs/DECISION_LOG.md` | 2026-06-28 |
| CON-CF-001 | closed | P1 | connector-cleanup | Discord and Telegram sections were removed from the web settings UI, defaults were retargeted to Slack, and the regression test was updated. | `packages/web/src/routes/settings/settings-connectors-section.tsx`, `packages/web/src/routes/settings/settings-constants.ts`, `packages/web/src/routes/settings/settings-connectors-section.test.tsx` | 2026-06-28 |
| CON-CF-002 | closed | P1 | compatibility | Legacy `connectors.discord`/`connectors.telegram` config keys are now stripped during config load so startup continues with supported connectors only. | `packages/cuttlefish/src/shared/config.ts`, `packages/cuttlefish/src/shared/__tests__/config.test.ts` | 2026-06-28 |
| CON-CF-003 | closed | P2 | connector-cleanup | Stale Discord/Telegram comments and dead type references were removed from backend session helpers and the web sidebar/settings surfaces. | `packages/cuttlefish/src/sessions/manager.ts`, `packages/cuttlefish/src/sessions/rate-limit-handler.ts`, `packages/cuttlefish/src/shared/config.ts`, `packages/web/src/components/chat/sidebar-session-helpers.ts`, `packages/web/src/routes/settings/settings-constants.ts` | 2026-06-28 |
| INV-CF-CRF-003 | closed | P2 | invariants | `notifications.connector` now validates against configured connector inventory, and `notifications.channel` without an explicit connector now fails unless the default Slack target is actually configured. | `packages/cuttlefish/src/shared/config-schema.ts`, `packages/cuttlefish/src/shared/__tests__/config.test.ts` | 2026-06-28 |
| ARC-CUT-001 | open | medium | architecture | Orchestration domain imports the gateway API aggregate and session-dispatch layer — creates a boundary violation and a real module cycle. | `orchestration/run-mode.ts:5-6`, `orchestration/dual-lane.ts:4`, `gateway/api.ts:23-33` — source-evidenced by 2026-06-29 architecture audit | 2026-06-29 |
| ARC-CUT-002 | open | medium | architecture | `runWebSession()` is a gateway god object owning turn execution, org hierarchy escalation, stall leadership, rate-limit fallback, connector reply, TTS, and knowledge export. | `gateway/run-web-session.ts` — source-evidenced by 2026-06-29 architecture audit | 2026-06-29 |
| TST-CUT-001 | closed | medium | testing | Pre-existing test failures in `ticket-dispatch-route.test.ts` (4 tests) and `route-hardening.test.ts` (2 tests). Resolved 2026-06-29: makeReq() upgraded to Readable stream mock with valid JSON body; worker.yaml fixture added with persona field; delete test payload fixed with tickets:[]; ctx mock given emit:vi.fn(). 216 test files / 1706 tests pass. | `packages/cuttlefish/src/gateway/__tests__/ticket-dispatch-route.test.ts`, `packages/cuttlefish/src/gateway/__tests__/route-hardening.test.ts` | 2026-06-29 |
| RDC-001 | closed | P0 | correctness | Model alias `opus`/`haiku` rewritten to ids absent from the shipped registry → 400 "unknown model"; broke the default claude model via CLI/UI. Alias resolution is now registry-aware; haiku target corrected. | `sessions/session-patch.ts` (commit bbbb511) | 2026-06-30 |
| RDC-002 | closed | P1 | correctness | Employee create silently dropped the validated `execution` profile; mid_pair→solo downgrade left stale reviewer fields. Carried through on create; replaced wholesale on update. | `gateway/org.ts` (commit 9a1366b) | 2026-06-30 |
| RDC-003 | closed | P1 | data-integrity | `deleteSession`/`deleteSessions` orphaned `approvals` and left dangling email session links. Approvals now deleted; cached emails unlinked (preserved). | `sessions/registry/sessions.ts` (commit f67ef2f) | 2026-06-30 |
| RDC-004 | closed | P2 | correctness | Non-finite SQL LIMIT (`Number('abc')=NaN`) crashed SQLite with a datatype mismatch. Coerced to default in `listArtifacts` + `listExternalOutboxItems`. | `sessions/registry/files.ts`, `sessions/registry/external-outbox.ts` (commit a96460b) | 2026-06-30 |
| RDC-005 | closed | P2 | state-integrity | `mergeTransportMeta` preserve-list drifted; newer server-owned keys clobbered by inbound messages. Promoted to `SESSION_OWNED_TRANSPORT_META_KEYS` + added drifted keys. | `sessions/manager-helpers.ts` (commit e452a12) | 2026-06-30 |
| RDC-006 | closed | P2 | invariants | Web `OrgChangeType`/`OrgChangeStatus` drifted from backend (missing `change_execution`, `error`). Synced. | `packages/web/src/lib/api-hr.ts` (commit d0a25cf) | 2026-06-30 |
| RDC-007 | closed | P2 | performance | O(n²) BFS via `Array.shift()` in two hot loops → head-index cursor (behavior-preserving). | `talk/graph.ts`, `gateway/org-hierarchy.ts` (commit ca263c4) | 2026-06-30 |
| RDC-R01 | closed | medium | data-integrity | Enforced FK approvals.session_id→sessions(id) ON DELETE CASCADE + enabled PRAGMA foreign_keys=ON (was OFF). Upgrade migration rebuilds the table with a pre-flight orphan delete; legacy JSON import skips orphans. Full enforcement (operator choice). | `sessions/registry/schema.ts`, `migrations.ts`, `core.ts`, `registry-approvals.ts` (commit 866ca4f) | 2026-06-30 |
| RDC-R02 | open | low | maintainability | `gateway/org.ts` is 1121 lines (1000-2000 band) and carries a literal `\x00` control-char regex that makes grep/rg treat it as binary. Route to a dedicated modularization run. | `gateway/org.ts` | 2026-06-30 |
| RDC-R03 | open | low | security-infra | CI/infra posture: no secret scanning; unpinned GitHub Actions; `bump-formula` broad `contents:write`; docker-compose floating `latest` tag. | `.github/workflows/`, `docker-compose.yml` | 2026-06-30 |
| RDC-R04 | closed | medium | reliability | Reliability batch resolved. R04a: connector reply-delivery failures now logged not silently dropped (963a1db). R04b: rate-limit fallback engineOverride reverted when the fallback engine throws (9f59a88). R04c: recovery preserves retry_count so the retry cap survives recovery cycles (60685f2). R04d: concurrent session-create dedupe = verified-not-a-defect (sync check+create with no await/yield in a single-process daemon — no interleaving window). | `sessions/manager.ts`, `sessions/rate-limit-handler.ts`, `orchestration/recovery-requeue.ts` | 2026-06-30 |
