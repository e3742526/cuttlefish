# Architecture

## Architecture Summary

Cuttlefish is a pnpm/Turborepo TypeScript monorepo with two primary packages:

- `packages/cuttlefish`: CLI, gateway daemon, engine adapters, connectors, session registry, orchestration runtime, and static web serving.
- `packages/web`: Vite/React dashboard served by the daemon after build.

The intended architecture is "a bus, not a brain": Cuttlefish coordinates external AI
coding CLIs and adds routing, scheduling, connectors, persistence, and UI without
owning model reasoning.

## Component Map

- CLI entrypoint: `packages/cuttlefish/bin/cuttlefish.ts`
- Gateway lifecycle/server: `packages/cuttlefish/src/gateway/`
- API router: `packages/cuttlefish/src/gateway/api.ts`
- Engine adapters: `packages/cuttlefish/src/engines/`
- Sessions and persistence: `packages/cuttlefish/src/sessions/`
- Orchestration: `packages/cuttlefish/src/orchestration/`
- Connectors: `packages/cuttlefish/src/connectors/`
- Web dashboard: `packages/web/src/`
- Operator docs/governance: `docs/`, `AGENTS.md`, `governance/`, `schemas/`

## Data / Persistence Map

- Instance home: `~/.cuttlefish`; local Cuttlefish is intentionally single-instance.
- Config/org/skills/templates: initialized and migrated from package templates.
- Sessions/messages/files/artifacts/queue/archive/approval state: SQLite-backed registry modules.
- Optional external knowledge export state: SQLite-backed `external_outbox`
  rows plus optional JSONL append output under `~/.cuttlefish/knowledge/`.
- Uploaded and attached artifacts: managed gateway storage with façade seam tests,
  SHA256 metadata, source/run annotations, validation helpers, and run-bundle
  manifest export.
- Run-scoped resource attachments: persisted in session `transportMeta`, exposed
  through session APIs, and normalized into exact file paths plus structured
  prompt context at dispatch time.
- Human checkpoints: persisted in the approval/checkpoint registry, surfaced via
  dedicated checkpoint APIs, and able to pause or resume session execution with
  a durable human-decision trail.
- Provider-neutral external knowledge seam: checkpoint decisions and completed
  session summaries can be exported as durable, versioned envelopes through
  `noop`, `jsonl`, or generic `webhook` sinks; a generic read provider is
  optional and never authoritative for core Cuttlefish behavior.
- Run bundles: generated on demand from session state, copied run-linked
  artifacts, filtered logs, and derived summaries into managed runtime export
  directories suitable for handoff and future replay/import work.
- Orchestration telemetry/recovery/worktrees: managed under Cuttlefish runtime paths and bounded retention policies.

## Workflows

### Local operator flow

1. Install `cuttlefish-cli`.
2. Sign in to at least one engine CLI.
3. Run `cuttlefish setup`.
4. Run `cuttlefish start`.
5. Use the dashboard at the configured gateway host/port.

### Web/API flow

1. Browser loads the Vite/React dashboard served by the gateway.
2. UI calls `/api/*` routes through `handleApiRequest()`.
3. The API router delegates to route-family modules.
4. Route handlers call sessions, engines, connectors, files, or orchestration services.
5. Events stream back to the UI through gateway WebSocket/session channels.

### Engine turn flow

1. A session selects an engine/model/effort.
2. Gateway builds prompt/context and attachments.
3. Engine adapter invokes the external CLI.
4. Stream deltas are normalized and persisted.
5. Final message, blocks, media, cost/context, and metadata update the session.

## Dependency Boundaries

- Web UI should call API/client libraries, not persistence internals.
- Gateway route modules should route/validate/translate, not own business logic.
- Session registry modules own persistence semantics.
- Engine adapters own CLI invocation and stream normalization.
- Orchestration runtime owns leases, continuations, holds, worktrees, and telemetry.
- Local generated artifacts stay outside the tracked source tree.
- Run attachment normalization lives in the gateway service layer; routes
  translate request shapes and session storage keeps the durable run-level
  resource roster.
- Human checkpoint semantics live in the gateway service layer so route modules
  only translate inputs/outputs while the shared approval store keeps the
  durable decision history.
- External knowledge sink/read-provider semantics also live in focused gateway
  and knowledge service modules so route files stay thin and downstream mapping
  remains outside Cuttlefish core.
- Run bundle export also lives in the gateway service layer so copy/filter rules
  stay centralized and session routes remain thin action adapters.

## Extension Points

- Add engines through `packages/cuttlefish/src/engines/` and model registry/config support.
- Add connectors under `packages/cuttlefish/src/connectors/`.
- Add dashboard routes in `packages/web/src/main.tsx` and route modules.
- Add orchestration controls through `orchestration-routes.ts`, web API helpers, and contract tests.
- Add artifact workflows through `api/routes/artifacts.ts` while keeping file
  persistence semantics in `sessions/registry/files.ts`.
- Add skills through the `cuttlefish skills` CLI and instance `skills.json`.

## Known Architecture Risks

- Historical docs still contain old Next.js assumptions and are explicitly historical.
- Orchestration is broad and should keep façade/contract tests around routing seams.
- Public tooling directories need a policy decision before further public hardening.
- React test warnings indicate UI test hygiene work remains.

## Diagrams

See `docs/IMPLEMENTATION_DIAGRAMS.md`.

## Decision Records

See `docs/DECISION_LOG.md`.
