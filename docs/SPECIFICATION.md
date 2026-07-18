# Cuttlefish Specification

## Scope

Cuttlefish is a local gateway daemon and dashboard for orchestrating professional AI
coding CLIs. It wraps existing engine CLIs behind one daemon, adds routing,
organization/delegation, connectors, scheduling, skills, file handling, and
operator dashboards.

## Non-Scope

- Cuttlefish is not a model provider and does not implement its own model reasoning loop.
- Cuttlefish does not replace official engine authentication flows.
- Cuttlefish does not make local-only audit/session/Giles artifacts part of the public source tree by default.

## Actors / Users

- `operator`: human running `cuttlefish setup`, `cuttlefish start`, and the dashboard.
- `engine CLI`: external tool such as Claude Code, Codex, Grok, Antigravity, Pi, Hermes, or Kiro.
- `employee`: configured org persona that selects an engine/model/role.
- `connector user`: user interacting through Slack, Twilio SMS, WhatsApp, or similar connectors. Discord and Telegram connectors were removed (`DEC-20260628-006`); they are no longer part of the connector surface.
- `manager/executive`: org role authorized for orchestration/hold operations.

## Core Entities

- `Session`: persisted conversation/work unit with messages, engine state, metadata, media, blocks, and cost context.
- `Engine`: CLI-backed execution adapter with model/effort capability metadata.
- `Employee`: YAML org role with persona, department, rank, engine, model, and reporting metadata.
- `Ticket`: kanban board item that may dispatch into a Cuttlefish session.
- `Orchestration task`: scheduler-owned work request with roles, leases, continuations, holds, worktrees, telemetry, and optional dual-lane artifacts.
- `Artifact`: uploaded, downloaded, generated, input, or manually attached file
  metadata with managed storage constraints, hash/source metadata, and optional
  producing run identity.
- `Run attachment`: normalized run-scoped resource reference for a file, folder,
  URL, or prior artifact, with access mode and intended-use metadata.
- `Human checkpoint`: run-scoped pause-for-decision record with decision intent,
  rationale, affected resources/actions, decision options, approver metadata,
  notes, and resulting action.
- `Run bundle`: a portable exported directory for one completed run containing
  session state, summary, copied artifacts, filtered logs, manifest, and error
  data.
- `External knowledge envelope`: provider-neutral, versioned event record for
  optional downstream export and lookup.

## Functional Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| REQ-CLI-001 | Provide CLI commands for setup, start, stop, restart, status, pairing, single-instance inspection, skills, migration, and orchestration. | verified | `packages/cuttlefish/bin/cuttlefish.ts` |
| REQ-WEB-001 | Serve a Vite/React dashboard with chat, talk, kanban, cron, logs, limits, org, settings, skills, file, and orchestration surfaces. | verified | `packages/web/src/main.tsx`, `docs/feature_inventory.md` |
| REQ-ENGINE-001 | Dispatch work through installed engine CLIs rather than internal model providers. | verified | `README.md`, `packages/cuttlefish/src/engines/*` |
| REQ-CLAUDE-001 | Run Claude Code through the official CLI/PTTY path for subscription-friendly turns. | verified | `README.md`, Claude engine tests |
| REQ-FILES-001 | Preserve managed upload/read/download/delete behavior through stable `/api/files` routes. | verified | `packages/cuttlefish/src/gateway/__tests__/files-facade-seam.test.ts` |
| REQ-ARTIFACTS-001 | Maintain a local artifact registry for files created, consumed, downloaded, or attached during Cuttlefish runs, including hash, source, run, tag, validation, and bundle-manifest metadata. | verified | `packages/cuttlefish/src/gateway/__tests__/artifact-registry.test.ts` |
| REQ-ATTACH-001 | Provide a standard run-resource attachment contract for files, folders, URLs, and prior artifacts, including access mode, intended use, producing-run metadata, and run-scoped persistence. | verified | `packages/cuttlefish/src/gateway/__tests__/run-attachments.test.ts` |
| REQ-CHECKPOINT-001 | Provide a generic human checkpoint/approval-gate primitive that can pause a run, record the decision trail, and resume or stop the run after human input. | verified | `packages/cuttlefish/src/gateway/__tests__/checkpoints.test.ts` |
| REQ-KNOWLEDGE-001 | Provide a provider-neutral external knowledge seam with a durable local outbox and versioned exported events for checkpoint decisions and completed session summaries. | verified | `packages/cuttlefish/src/gateway/__tests__/checkpoints.test.ts`, `packages/cuttlefish/src/sessions/__tests__/external-outbox.test.ts` |
| REQ-KNOWLEDGE-002 | Keep external knowledge export optional and non-authoritative: default installs must work with no downstream service, and sink/read-provider failures must not block primary user workflows. | verified | `packages/cuttlefish/src/knowledge/__tests__/outbox-service.test.ts`, `packages/cuttlefish/src/gateway/__tests__/knowledge-routes.test.ts` |
| REQ-BUNDLE-001 | Export a completed run as a portable bundle containing run state, summary, copied artifacts, filtered logs, manifest, and error data without bundling unrelated workspace files. | verified | `packages/cuttlefish/src/gateway/__tests__/run-bundles.test.ts` |
| REQ-ORCH-001 | Route `/api/orchestration/*` through the canonical API router and support status/control surfaces. | verified | `packages/cuttlefish/src/gateway/api.ts`, `api-orchestration-routing.test.ts` |
| REQ-GOV-001 | Keep local generated governance/runtime artifacts out of the public tracked source tree. | verified | `.gitignore`, `docs/STRUCTURE_COMPLIANCE.md` |

## Non-Functional Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| REQ-NFR-001 | Preserve public import paths during modularization. | verified | modularization reports/tests |
| REQ-NFR-002 | Run under Node 24 according to repo and contributor docs. | verified | `.nvmrc`, `package.json`, `.github/CONTRIBUTING.md` |
| REQ-NFR-003 | Avoid committing secrets and local runtime state. | verified | `AGENTS.md`, `.gitignore`, tracked secret scan |
| REQ-NFR-004 | Keep docs source-grounded and mark historical material separately from current behavior. | verified | `AGENTS.md`, `docs/DOCUMENTATION_INVENTORY.md` |

## Persistence / Data Contract

- Runtime user state lives under `~/.cuttlefish`; local Cuttlefish is intentionally single-instance.
- Sessions, messages, queue items, files/artifacts, archives, approvals,
  optional external-knowledge outbox rows, and orchestration state use
  SQLite-backed registries and related managed file paths.
- Optional external knowledge export can also append generic JSONL envelopes to
  `~/.cuttlefish/knowledge/outbox.jsonl`.
- Generated web output is copied into `packages/cuttlefish/dist/web` during build but remains untracked.
- Local audit/session/Giles/runtime artifacts are ignored unless explicitly published as curated summaries.

## Interfaces

- CLI: `cuttlefish` command tree in `packages/cuttlefish/bin/cuttlefish.ts`.
- Web dashboard: routes in `packages/web/src/main.tsx`.
- HTTP API: routed through `packages/cuttlefish/src/gateway/api.ts`.
- Orchestration API: `packages/cuttlefish/src/gateway/api/orchestration-routes.ts`.
- Files API: `packages/cuttlefish/src/gateway/files.ts` façade and sibling modules.
- Artifact API: `packages/cuttlefish/src/gateway/api/routes/artifacts.ts`.
- Run attachment API: `packages/cuttlefish/src/gateway/api/routes/session-write.ts`, `packages/cuttlefish/src/gateway/run-attachments.ts`.
- Checkpoint API: `packages/cuttlefish/src/gateway/api/routes/checkpoints.ts`, `packages/cuttlefish/src/gateway/checkpoints.ts`.
- Run bundle export API: `packages/cuttlefish/src/gateway/api/routes/session-write.ts`, `packages/cuttlefish/src/gateway/run-bundles.ts`.
- External knowledge API: `packages/cuttlefish/src/gateway/api/routes/knowledge.ts`.

## Validation Requirements

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `giles repo-check /home/ericl/Work/vscode/public_share/cuttlefish --format pretty`
- `pnpm build` before release or CI validation
- `pnpm test:e2e` when changing browser flows or navigation behavior

## Acceptance Criteria

- Root README links canonical docs and current architecture diagrams.
- CLI/API/UI public surfaces have a current inventory.
- Tests and validation evidence are recorded in `docs/TEST_LEDGER.md`.
- Active docs/TODOs are centralized and historical notes are marked historical.

## Open Specification Questions

- Should public tooling directories `.claude/` and `.agents/` remain tracked? `.fissure/` is local-only tooling and is ignored.
- Should the repo adopt Giles default tracked summaries under `docs/logs/session/`, or keep the current repo-local tracked-summary paths?

## Version History

- 2026-06-25: Initial source-grounded specification created by documentation stewardship pass.
- 2026-06-26: Added artifact registry requirement and API surface.
- 2026-06-26: Added run-resource attachment requirement and session API surface.
- 2026-06-26: Added generic human checkpoint requirement and API surface.
- 2026-06-26: Added exportable run-bundle requirement and session API surface.
- 2026-06-26: Added provider-neutral external knowledge outbox, sink/read seam, and knowledge API surface.
- 2026-07-18: Corrected the `connector user` actor description to match the current `packages/cuttlefish/src/connectors/` set (Slack, Twilio SMS, WhatsApp); removed stale Discord/Telegram references per `DEC-20260628-006`.
