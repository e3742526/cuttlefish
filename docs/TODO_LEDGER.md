# TODO Ledger

This ledger is the authoritative list of active documentation/governance TODOs
for this checkout. It intentionally excludes inherited upstream-era TODO notes
and historical planning ideas unless they have been re-opened for Cuttlefish
with current evidence and exit criteria.

Sources: 2026-06-28 six-lens structural audit (STT/PIP/NEG/FSR/ARC/INV prefixes);
2026-06-28 Gemini input/output-path audit (IOP prefix).

| ID | Status | Priority | Area | Brief Description | Evidence | Opened |
|---|---|---|---|---|---|---|
| IOP-CF-002 | open | critical | security | Discord attachment filename not sanitized — path traversal allows arbitrary file write outside TMP_DIR | `connectors/discord/format.ts:13-27` | 2026-06-28 |
| STT-CF-001 | open | critical | state-machine | Org change apply has no pre-state guard — rejected/draft changes can be applied directly | `gateway/api/routes/org.ts:422-438` | 2026-06-28 |
| STT-CF-002 | open | critical | state-machine | `markExternalOutboxDelivered()` has no status gate — failed items can be force-transitioned to delivered | `sessions/registry/external-outbox.ts:118-131` | 2026-06-28 |
| FSR-CF-001 | open | critical | reliability | `config.yaml` is a hard SPF — missing or invalid config hard-crashes with no user-friendly message | `shared/config.ts:93-113` | 2026-06-28 |
| IOP-CF-001 | open | high | security | `isAllowedReadPath` containment bypassed via symlink — symlinks outside fileReadRoots are not resolved before prefix check | `gateway/files/read-security.ts:102-115` | 2026-06-28 |
| IOP-CF-004 | open | high | security | `isServablePath` download containment bypassed via symlink — symlinks in UPLOADS_DIR can serve arbitrary host files | `gateway/files/storage.ts:35-41` | 2026-06-28 |
| STT-CF-003 | open | high | state-machine | `markExternalOutboxFailed()` non-atomic read+write and no state guard — double-call can corrupt terminal state | `sessions/registry/external-outbox.ts:135-151` | 2026-06-28 |
| PIP-CF-001 | open | high | reliability | Slack `this.handler(msg)` called sync without try-catch — exceptions silently drop messages | `connectors/slack/index.ts:204,269` | 2026-06-28 |
| NEG-CF-001 | open | high | concurrency | HR session creation race — concurrent org-change submissions can both create new sessions | `gateway/hr-steward.ts:306` | 2026-06-28 |
| FSR-CF-002 | open | high | reliability | `fs.mkdirSync(cuttlefishHome)` has no try-catch — EACCES produces cryptic crash | `gateway/auth.ts:45` | 2026-06-28 |
| ARC-CF-001 | open | high | architecture | `SessionManager` is a god object (~800 lines) — owns policy, auth, MCP, budget, prompts, and dispatch | `sessions/manager.ts` | 2026-06-28 |
| IOP-CF-003 | open | medium | security | Custom upload path silently overwrites existing files — no existence check before write | `gateway/files/uploads.ts:137-140` | 2026-06-28 |
| PIP-CF-002 | open | medium | reliability | Email ingest stuck in `dispatching` permanently if `onAutoIngest` throws synchronously | `email/service.ts:196-216` | 2026-06-28 |
| PIP-CF-003 | open | medium | reliability | HR critique failure auto-applies low-risk org changes via null critique — failure should enter `error` state | `gateway/hr-steward.ts:137-143` | 2026-06-28 |
| NEG-CF-002 | open | medium | security | Email `allowFrom` trusts raw MIME From header — no SPF/DKIM check; forged From bypasses sender gate | `email/normalize.ts`, `email/service.ts:18-30` | 2026-06-28 |
| NEG-CF-004 | open | medium | reliability | No PID lock file — two daemon instances can share the same SQLite DB | `sessions/registry/core.ts:73-75` | 2026-06-28 |
| FSR-CF-003 | open | medium | reliability | Node.js version below minimum warned but not enforced — daemon child spawns then crashes unclearly | `gateway/lifecycle.ts:53-56` | 2026-06-28 |
| ARC-CF-002 | open | medium | architecture | `HrSteward` mixes domain logic with session dispatch — should separate via event/callback | `gateway/hr-steward.ts` | 2026-06-28 |
| ARC-CF-003 | open | medium | architecture | `gateway/auth.ts` has four responsibilities — admin token, scoped token, PTY token, denylist | `gateway/auth.ts` | 2026-06-28 |
| INV-CF-001 | open | low | invariants | `Approval["type"]` includes `"checkpoint"` but list endpoint silently excludes it — undocumented divergence | `shared/types/operations.ts:32`, `gateway/api/routes/approvals.ts:27` | 2026-06-28 |
| PIP-CF-004 | open | low | reliability | Connector reply failures fire-and-forget with no audit record — swallowed after 2 retries | `gateway/run-web-session.ts` | 2026-06-28 |
| NEG-CF-003 | open | low | operator-ux | `autoIngest: true` + empty `allowFrom` silently disables auto-ingest with no operator warning | `email/service.ts:197-198` | 2026-06-28 |
| NEG-CF-005 | open | low | reliability | No pre-flight node-pty ABI check — first PTY spawn fails with cryptic error | `engines/pty-stream.ts:13-26` | 2026-06-28 |
| ARC-CF-004 | open | low | architecture | Policy mixed with mechanism in connector-send route — extract `authorizeConnectorSend()` as pure function | `gateway/api/routes/connectors.ts:146-157` | 2026-06-28 |
