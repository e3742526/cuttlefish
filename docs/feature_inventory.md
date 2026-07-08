# Feature Inventory

## Web UI

### Dashboard route shell
- `packages/web/src/main.tsx`
- The public dashboard is a Vite React app served by the gateway daemon.
- Implemented routes are:
  - `/` for the primary chat workspace; `/chat` redirects to `/`.
  - `/command` for the command-center overview.
  - `/talk` for multi-agent talk sessions.
  - `/kanban` for department ticket boards and dispatch controls.
  - `/orchestration` for matrix orchestration operations.
  - `/cron` for scheduled job management.
  - `/logs` for runtime log inspection.
  - `/limits` for usage/rate-limit visibility.
  - `/org` for organization and employee configuration.
  - `/settings` for gateway, engine, connector, and feature configuration.
  - `/skills` for local skill browsing/management.
  - `/file` for file viewing.
- `/redesign` is development-only and is not part of the public operator surface.

### Kanban ticket live session inspector
- `packages/web/src/components/kanban/ticket-detail-panel.tsx`
- `packages/cuttlefish/src/gateway/api/routes/org.ts`
- `packages/cuttlefish/src/gateway/orphaned-ticket-reconciler.ts`
- In-progress tickets can show a live session summary in the detail panel:
  - session status
  - engine and model
  - accumulated session cost
  - relative last-activity heartbeat
  - latest transcript tail (capped to 8 messages)
  - link to open the full live chat view
- This is session-level liveness only. It reflects the gateway session state and transcript, not process-level CPU/PID health.
- The gateway now performs a deterministic orphaned-ticket reconciliation when a
  department board is read, so stale `in_progress` tickets are demoted to
  `blocked` immediately instead of waiting for the periodic sweep.
- Completed tickets no longer surface old `idle` sessions as if they were still
  live; only active or failure-relevant session state remains inspectable from
  the board.

### Kanban recycle bin
- `packages/cuttlefish/src/gateway/board-service.ts`
- `packages/web/src/routes/kanban/page.tsx`
- Deleted kanban tickets move into a recycle bin instead of being purged immediately.
- The retention window defaults to 3 days and is configurable from 0 to 7 days in the kanban UI.
- `0` means immediate purge.
- Tickets remain restorable from the "Recently deleted" section until their retention window expires.

### Kanban optimistic save protection
- `packages/cuttlefish/src/gateway/board-service.ts`
- `packages/web/src/routes/kanban/page.tsx`
- Web board saves send each ticket's last observed `updatedAt` as `baseUpdatedAt`.
- The gateway rejects stale ticket updates or stale deletion attempts with HTTP `409`
  and `reason: "board-conflict"` instead of overwriting newer server state.
- Running board-linked tickets preserve active `sessionId` and `source` metadata across
  fresh saves so a stale layout cannot silently move a dispatched ticket back to `todo`.
- Date fields `createdAt`, `updatedAt`, and `baseUpdatedAt` are now guarded at
  serialization time; missing or invalid timestamps fall back to `Date.now()` to
  prevent "Invalid Date" / `"Invalid time value"` errors on save.

### Kanban ticket card time display
- `packages/web/src/components/kanban/ticket-card.tsx`
- `packages/web/src/components/kanban/create-ticket-modal.tsx`
- Relative-time display (`relativeTime()`) now guards against `undefined` or non-finite
  timestamps, rendering `?` instead of `NaNmo ago`.
- The create-ticket modal now shows a "Title is required" helper text and accessible
  button label when the submit button is disabled due to an empty title field.

### Usage limits empty state
- `packages/web/src/routes/limits/page.tsx`
- The `/limits` page now renders an explicit "No engine data yet" empty state when the
  daemon has not yet collected any usage snapshots, instead of showing a blank page.

### Matrix orchestration operations dashboard
- `packages/web/src/routes/orchestration/page.tsx`
- `packages/web/src/lib/orchestration-api.ts`
- `/orchestration` shows real orchestration status, workers, running leases,
  blocked queue items, durable continuations, dual-lane selection manifests,
  managed worktrees, and telemetry/cost summaries.
- Dashboard actions are deliberately limited to safe backend actions: retry a
  continuation only when it is `failed`, select or apply a dual-lane winner,
  pause/resume the global queue or one queued task, create/extend/cancel
  TTL-bounded holds, view raw prompt/output/diff artifacts, requeue explicitly
  selected recovery records, and stop a running lease through its mapped Cuttlefish
  session interruption path.
- Disabled action controls explain the state boundary. Dual-lane apply refuses
  dirty base worktrees, missing winner worktrees, empty patches, and patch
  conflicts; it applies only unstaged base-repo changes.

### Organization agent create/edit panel
- `packages/web/src/routes/org/page.tsx`
- `packages/web/src/components/org/employee-create-form.tsx`
- `packages/web/src/components/org/employee-editor.tsx`
- `packages/web/src/components/org/employee-node.tsx`
- `/org` can now open a right-side "Add agent" form that creates a new org
  employee YAML file through the gateway.
- The create/edit surfaces cover agent id, display name, department, reports-to,
  level (`manager`, `senior`, `junior` mapped to internal `employee` rank),
  engine/model/effort, including the local `ollama`, `kilo`, and `aider` engine options, optional same-engine fallback model, persona,
  CLI flags, always-notify behavior, and backend support for the machine-readable
  security gate fields `approvalPolicy`, `reviewTriggers`, and
  `securityReviewer`, including the looser `notify` runtime policy that allows
  risky-but-reviewed Bash actions to continue with a session notification
  instead of a human checkpoint.
- Employee, manager, and executive org-map cards also expose a compact quick-chat affordance that opens the main chat workspace, using the existing employee preselection deep-link for non-executive employees.
- `/org` department tabs expose an inline rename action for a selected department. `PATCH /api/org/departments/:name` updates matching employee YAML `department` fields, renames the department directory when there is no target collision, and emits org/board refresh events.
- The create/edit surfaces now include multi-role execution configuration when the `features.multiRoleEmployeeExecution` feature flag is enabled: execution tier (`solo` or `mid_pair`), max internal passes, max child sessions, max wall-clock time, max tool calls, max estimated cost, reviewer loss policy, and reviewer tool profile.
- The edit surface additionally exposes per-role sub-agent selection (`packages/web/src/components/org/role-agent-config.tsx`) for the implementer and reviewer roles: engine/model/effort overrides with inherit-from-employee defaults (e.g. routing simple review work to a cheaper model), plus an ordered failover chain of up to 5 targets per role where each target is either a backup agent (engine + model) or a defer-to-external-agent entry referencing another org employee. The detail panel summarizes the configured per-role plan.
- `packages/web/src/components/org/employee-detail.tsx` displays an execution profile summary in the detail panel when a profile is configured.
- Fresh-install seed personas place Parliamentarian and Senior Security Officer in `compliance`, HR / Org Steward as the `personnel` department manager, and Assistant in `general`. HR / Org Steward advises on organizational planning, agent coordination patterns, and model/budget/resource fit while remaining a review/advisory role rather than a runtime orchestrator or resource manager. New manager-hire guidance defaults managers to the COO/root reporting line unless the user explicitly says otherwise.

### Workspace profiles
- `packages/cuttlefish/src/gateway/workspace-profiles.ts`
- `packages/cuttlefish/src/gateway/api/routes/session-write.ts`
- `packages/web/src/components/chat/chat-pane.tsx`
- Operators can define named workspace/product profiles in `config.yaml` under `workspaces.profiles`.
- Supported profile fields are `id`, `label`, `cwd`, `instructions`, and optional default `employee`.
- `GET /api/workspace-profiles` returns sanitized profile summaries for the dashboard.
- `POST /api/sessions` accepts `workspaceProfile`; the gateway validates the configured cwd against `workspaces.roots`, uses it as the session working directory unless an explicit `cwd` is supplied, injects the profile instructions into the first engine prompt, and records `transportMeta.workspaceProfile` for traceability.
- The chat composer shows a workspace profile picker for new chats when profiles are configured. Profile authoring remains config-backed in this version.

### Cross-department service requests
- `packages/cuttlefish/src/gateway/api/routes/org.ts`
- Employees can declare services with `provides: [{ name, description }]` in their org YAML.
- `GET /api/org/services` returns active service providers, deduped by service name with higher-rank providers winning ties.
- `POST /api/org/cross-request` accepts `{ fromEmployee, service, prompt, parentSessionId? }`, resolves the active provider for the service, creates a provider-owned web session with a cross-service brief, dispatches it on the provider's configured engine/model, and returns `{ sessionId, provider, route, managers, service }`.
- The created session records `transportMeta.crossRequest` with the requester, service, provider, route, and manager chain for traceability.

### Multi-role employee execution
- `packages/cuttlefish/src/gateway/employee-execution.ts`
- `packages/cuttlefish/src/shared/types/operations.ts`
- `packages/cuttlefish/src/gateway/api/routes/session-write.ts`
- `packages/cuttlefish/src/gateway/org.ts`
- `packages/cuttlefish/src/gateway/run-web-session.ts`
- Employees can now carry an `execution` config block defining a multi-role execution profile.
- Execution tiers: `solo` (default, unchanged behavior) and `mid_pair` (implementer + reviewer pair).
- `mid_pair` spawns an internal implementer session and a separate reviewer session at depth 1.
- An execution depth guard (`isExecutionDepthBlocked`) prevents role sessions from recursively spawning additional profiles.
- Internal roles (`implementer`, `reviewer`) are runtime-only — they are never org members.
- The reviewer receives a read-only tool profile by default and cannot directly mutate repo contents.
- Reviewer loss policies (`block`, `replace_then_block`, `replace_then_degrade`, `degrade`) control fallback behavior when a reviewer cannot be allocated.
- Role failover is deterministic: `resolveRoleFailoverTargets` resolves each role's `fallbackChain` in configured order, dedupes engine+model rungs, drops the primary rung, self-referential/unknown external-agent targets, and unavailable engines up front, and is capped at `MAX_ROLE_FALLBACK_CHAIN` (5). Under a `replace_then_*` loss policy the mid-pair orchestrator walks the reviewer's full resolved chain — bounded by the child-session budget and wall-clock deadline — before terminally resolving to block or degrade-to-solo; revision passes apply the same failover to the implementer role.
- Failover chain entries may defer to an external org agent (`{ employee: name }`), resolving that employee's engine/model/effort at dispatch time; `execution.roles` payloads are structurally validated on create/update (unknown keys, chain cap, employee XOR engine+model, self/unknown employee references rejected).
- All execution-profile sessions carry `executionDepth`, `executionTier`, `profileId`, and `internalRole` in `transportMeta` for traceability.
- Feature gated: `features.multiRoleEmployeeExecution: true` must be set in daemon config.
- The mid-pair reviewer's verdict is host-validated (`validateReviewResult`); invalid output triggers exactly one in-place JSON repair retry (same reviewer session, bounded by the wall-clock deadline) before the reviewer loss policy applies, and the recorded degraded reason distinguishes "unparseable after retry" from an engine loss.
- The mid-pair reviewer receives deterministic changed-file/diff context (bounded `git diff HEAD` of the implementer workspace via `session.cwd`, built by `gateway/review-context.ts`); when no diff can be produced it degrades to summary-only and records the reason.
- Degraded/fallback/review-context state is surfaced on the API `executionRunState` (from parent-session `transportMeta`): `degraded`/`degradedReason`, the now-populated `fallbackActive`, and `reviewContext` (`diff` | `summary_only`) + `reviewContextReason`.
- Fidelity gaps:
  - Mid-pair review flow is wired at the session-write and org-execution layers, and degraded/fallback/review-context state is now surfaced on `executionRunState`; the web UI to display review status is still deferred.
  - The mid-pair path passes an inline bounded diff rather than the orchestration path's full disk-backed review bundle (`patch.diff` + `metadata.json` via `createReviewBundle`); reviewer allocation still uses the configured `reviewerToolProfile`.
  - Follow-up messages, queue replay, and notification dispatch still bypass the mid-pair orchestrator (documented in `mid-pair-orchestrator.ts`).

### Kanban ticket resource context and manual-only dispatch
- `packages/web/src/routes/kanban/page.tsx`
- `packages/web/src/components/kanban/create-ticket-modal.tsx`
- `packages/web/src/components/kanban/ticket-detail-panel.tsx`
- `packages/cuttlefish/src/gateway/ticket-dispatch.ts`
- `packages/cuttlefish/src/gateway/board-worker.ts`
- Department-board tickets can now store one local directory (`resourcePath`)
  or one http(s) URL (`resourceUrl`) that is attached when the ticket runs,
  reusing the session run-resource attachment system rather than a kanban-only
  path.
- Tickets can also set `manualOnly: true`, exposed in the UI as a manual-only
  toggle, which prevents background board-worker auto-dispatch while still
  allowing explicit human `Run now`.

### Remote access pairing code panel
- `packages/web/src/components/auth/remote-access-panel.tsx`
- The settings remote-access panel controls pairing codes and shows paired browsers.
- The "Create pairing code" button is hidden when gateway authentication is disabled
  (`authRequired: false`), replaced by an explanatory note.
- When authentication is enabled but the session is not on the local dashboard
  (`canBootstrapLocal: false`), the button renders as disabled with a hint directing
  the operator to create codes from the local Mac dashboard.

### Session model alias expansion
- `packages/cuttlefish/src/sessions/session-patch.ts`
- The session create and session-patch API now accept short Claude model aliases:
  `sonnet` → `claude-sonnet-4-6`, `opus` → `claude-opus-4-8`,
  `haiku` → `claude-haiku-4-5-20251001`. Aliases are expanded before registry
  validation so callers using convenience names receive a valid session instead of
  an "unknown model" rejection.
- Only the `claude` engine is affected; other engines pass the model string through unchanged.

### Agent process crash session status
- `packages/cuttlefish/src/engines/pi.ts`
- `packages/cuttlefish/src/sessions/manager-helpers.ts`
- When a Pi agent process exits with a non-zero code or a signal without producing
  a result, the session now transitions to `interrupted` status (not `idle`) with
  a `lastError` value prefixed `"Interrupted:"`.
- This matches the daemon restart recovery path (`recoverStaleSessions`) which uses
  the same `"Interrupted:"` prefix convention. Operator-visible session state now
  correctly distinguishes unexpected crashes from normal completion.

### Settings orchestration controls
- `packages/web/src/routes/settings/page.tsx`
- `packages/web/src/routes/settings/settings-config-sections.tsx`
- `/settings` now exposes first-class orchestration runtime controls including
  the enable toggle plus config/db/worktree paths, max worktrees, same-family
  reviewer fallback, and empirical routing.

### Settings email inbox controls
- `packages/web/src/routes/settings/page.tsx`
- `packages/web/src/routes/settings/settings-config-sections.tsx`
- `/settings` now exposes operator configuration for up to 3 IMAP inboxes,
  including host/port/TLS, credentials, folder, polling cadence, unread-only,
  and auto-ingest toggles.

## CLI

### Provider-neutral matrix orchestration dry-runs and observe surfaces
- `packages/cuttlefish/src/orchestration/*`
- `packages/cuttlefish/src/cli/orchestration.ts`
- `packages/cuttlefish/bin/cuttlefish.ts`
- `cuttlefish workers list --config-dir <dir> [--json]` loads explicit matrix worker config and prints available workers.
- `cuttlefish scheduler allocate <task-file> --config-dir <dir> --dry-run [--json]` validates a task request and performs fake-worker allocation only.
- `cuttlefish scheduler simulate <scenario-file> --config-dir <dir> [--json]` runs deterministic allocation/release/heartbeat/expiry scenario steps against in-memory scheduler state.
- `cuttlefish scheduler plan <task-file> --config-dir <dir> [--db-path <path>] [--json]` expands a coordinator template into an observe-only allocation plan.
- `cuttlefish leases list --config-dir <dir> [--db-path <path>] [--json]` lists durable orchestration leases when a DB exists.
- `cuttlefish queue list --config-dir <dir> [--db-path <path>] [--json]` lists durable blocked-resource queue items when a DB exists.
- `cuttlefish queue pause-task|resume-task --task-id <id> --coordinator-id <id> [--json]` pauses or resumes one queued task through the live gateway.
- `cuttlefish run --mode single_worker|single_worker_with_review|dual_lane|architecture|local_heavy --task <file> [--json]` posts a live task brief to the running gateway; the daemon must have `orchestration.enabled: true`.
- `cuttlefish dual-lane select --task-id <id> --coordinator-id <id> --winner openai|anthropic [--json]` explicitly selects a completed dual-lane winner, archives the loser diff/metadata, and removes the loser worktree.
- `cuttlefish dual-lane apply --task-id <id> --coordinator-id <id> --winner openai|anthropic [--json]` applies the selected or selection-required winner patch to the base repo as unstaged changes only.
- `cuttlefish holds list|create|extend|cancel` manages TTL-bounded orchestration holds with manager-scoped authorization.
- `cuttlefish artifacts view --task-id <id> --coordinator-id <id> --kind diff|prompt|output [--json]` displays raw dual-lane artifacts for authenticated operators.
- `cuttlefish continuations list [--json]` lists durable blocked/failed continuation records through the running gateway.
- `cuttlefish continuations retry --task-id <id> --coordinator-id <id> [--json]` re-attempts a previously failed live continuation through the running gateway.
- `cuttlefish scheduler stats [--path <file>] [--json]` summarizes append-only orchestration run telemetry by provider, family, role, worker, and disposition.
- `cuttlefish recovery notices [--json]` lists recent corrupt orchestration DB recovery manifests.
- `cuttlefish recovery requeue --manifest <path> --task-id <id> --coordinator-id <id> --manager-name <name> [--json]` imports one parsed recovered continuation as queued and task-paused; it never dispatches automatically.
- `scripts/orchestration-smoke.mjs` is an opt-in live-daemon smoke script; without `CUTTLEFISH_ORCHESTRATION_SMOKE=1`, it prints a skip message and exits 0.
- `cuttlefish worktree create <task-file> [--lane <name>] [--json]` creates a managed git worktree for a task/lane when the task cwd is inside a git repo.
- `cuttlefish worktree diff <task-file> [--lane <name>] [--json]` prints the diff for a managed task/lane worktree.
- `cuttlefish worktree cleanup <task-file> [--lane <name>] [--json]` removes a managed task/lane worktree.
- Dry-run/list/plan commands remain inert and explicit-path based. `cuttlefish run` is opt-in live execution through the daemon-owned scheduler and existing Cuttlefish session path.
- `single_worker_with_review` run output includes reviewer-family policy explanations. Same-family reviewer fallback is forbidden by default and only enabled by `orchestration.sameFamilyReviewerFallback: true`.
- Live run output can now end in `ok: false, state: "failed"` when any leased role session errors; blocked runs remain `state: "blocked_resource"`.
- Fidelity gaps:
  - A SQLite store, persistent scheduler wrapper, and daemon runtime now exist for leases, allocations, queue items, and telemetry events.
  - Provider-adapter contract modules now exist for `stub`, `manual`, `local_echo`, `mock`, and experimental opt-in live adapter parity tests for existing Cuttlefish engine ids via an injected engine map. The default registry used by dry-runs remains inert-only, and production live orchestration does not route through the live adapter factory.
  - Live orchestration allocation applies usage-aware headroom before creating leases, filtering unavailable, exhausted, or below-threshold engines while simulation mode stays deterministic.
  - Worktree execution is task/lane-scoped: implementation lanes can run in isolated git worktrees, reviewers inspect generated diff bundles instead of the implementation tree, and the runtime reaper removes abandoned managed worktrees plus review bundles older than 24 hours.
  - Dual-lane mode allocates OpenAI and Anthropic implementer roles atomically, sends both lanes an identical prompt in isolated worktrees, returns a deterministic comparison report, requires explicit human selection keyed by `taskId + coordinatorId`, records raw prompt/output/diff artifacts, and can apply the selected patch as unstaged base-repo changes only.
  - Board-originated ticket dispatch is scheduler-aware when `orchestration.enabled: true`: manual dispatch and the board worker allocate an exact synthesized org worker role before session launch and release the lease after the run settles.
  - Durable telemetry is appended to `~/.cuttlefish/logs/orchestration-telemetry.jsonl` for scheduler-owned live runs, dual-lane selection outcomes, and scheduler-owned board/manual ticket dispatch. Prompts, raw model output, raw diffs, cwd/worktree paths, credentials, headers, and env are not logged.
  - `orchestration.empiricalRouting: true` lets runtime startup use decayed historical telemetry scores as a deterministic worker tie-break after hard constraints and explicit tier/cost preferences.
  - Runtime reload/shutdown paths preserve active orchestration work, replay deferred org/config refresh after drain, recover stale `dispatching` continuations, and release owned leases before closing persistent state.
  - Allocation lifecycle and retention are bounded: running allocations remain protected, terminal allocations default to 24-hour retention with a 1,000-record cap, internal scheduler telemetry defaults to 24-hour retention with a 2,000-event cap, append-only JSONL run telemetry is compacted to 90 days or 10,000 records, and recovery notices/quarantine sidecars are compacted to 30 days or 100 groups.
  - `architecture` mode requires architect, implementer, independent reviewer, adversarial reviewer, and QA roles in the resolved request. `local_heavy` rejects editing/coding roles and restricts allocation to local, near-zero, or low-cost workers.
  - The public CLI dry-runs and plans do not write the durable store; list commands read existing durable state only.
  - The `/orchestration` dashboard exposes failed-continuation retry, explicit dual-lane selection and apply, global and per-task queue pause/resume, raw artifact viewing, holds, recovery requeue, and strict running-lease stop.

## API

### Email inbox inspection and COO auto-ingest
- `packages/cuttlefish/src/email/*`
- `packages/cuttlefish/src/gateway/api.ts`
- `packages/cuttlefish/src/gateway/api/routes/status.ts`
- Cuttlefish now supports inbound IMAP inbox polling for up to 3 configured
  inboxes.
- New mail is normalized into a cached email store, attachments are persisted
  through the existing artifact/file registry, and auto-ingest opens or reuses
  a COO-owned session keyed by inbox/thread identity.
- Auto-ingest is **fail-closed**: an inbox drives an agent run only when it sets
  `autoIngest: true` explicitly (untrusted external mail must be opted in, not
  defaulted on). A per-inbox `maxMessageBytes` caps raw message size. The message
  lifecycle is `cached -> dispatching -> ingested | error`, where `dispatching` is a
  durable pre-dispatch claim so a crash/replay never re-runs the agent (at-most-once);
  a message stuck in `dispatching` surfaces as degraded inbox health.
- `GET /api/email/inboxes` lists configured inboxes plus health.
- `POST /api/email/inboxes/:id/check` performs an immediate authenticated poll
  for one inbox.
- `GET /api/email/inboxes/:id/messages?limit=N` lists cached messages for one
  inbox.
- `GET /api/email/messages/:messageId` returns one cached normalized message.
- This is inbound-only in the current implementation. SMTP send/reply,
  threading replies back to providers, and mailbox mutation are not part of the
  shipped surface.

### Artifact registry routes
- `packages/cuttlefish/src/gateway/api/routes/artifacts.ts`
- `packages/cuttlefish/src/sessions/registry/files.ts`
- Uploaded files, downloaded files, session attachments, and explicitly
  registered local outputs are persisted in the SQLite file/artifact registry
  with artifact id, path, MIME/type, size, SHA256, created time, producing run id
  when known, source URL/path, tags, notes, and artifact kind.
- Supported artifact kinds are `generated`, `input`, `downloaded`, and `manual`.
- `GET /api/artifacts` lists registry entries with optional `runId`, `kind`,
  `tag`, `q`, `sourceUrl`, `sourcePath`, and `limit` filters.
- `GET /api/artifacts/:id` returns one artifact plus current on-disk existence
  and its `/api/files/:id` download URL.
- `POST /api/artifacts/register` records an existing local file as an artifact,
  computes its SHA256, and stores optional run/source/tags/notes metadata.
- `PATCH /api/artifacts/:id` updates mutable metadata fields without moving the
  file.
- `POST /api/artifacts/validate` checks expected artifact ids and paths against
  registry records and current disk existence.
- `GET /api/artifacts/bundle?runId=<id>` returns an exportable run-bundle
  manifest for artifacts produced by one run. It does not package bytes into an
  archive in this implementation.

### Session run-resource attachments
- `packages/cuttlefish/src/gateway/run-attachments.ts`
- `packages/cuttlefish/src/gateway/api/routes/session-write.ts`
- Sessions now support normalized run-resource attachments for local files,
  folders, URLs, and previously registered artifacts.
- Attachment metadata includes path or URL, artifact id when known, local-file
  SHA256 when available, `read_only` vs `writable` access, intended use, and
  producing run id when known.
- `POST /api/sessions` and `POST /api/sessions/:id/message` accept legacy
  attachment id arrays plus richer `resources` objects; normalized attachments
  are persisted on the session and reused for handoffs/subsequent turns.
- `GET /api/sessions/:id/resources` lists the session's normalized run resources.
- `POST /api/sessions/:id/resources` attaches resources to an existing run
  without sending a prompt.
- Engine dispatch still receives exact local file paths when available, while
  the prompt also includes a structured "Attached resources" block for folders,
  URLs, access mode, intended use, artifact linkage, and producing-run context.

### Human checkpoints and approval gates
- `packages/cuttlefish/src/gateway/checkpoints.ts`
- `packages/cuttlefish/src/gateway/api/routes/checkpoints.ts`
- `packages/cuttlefish/src/gateway/api/routes/approvals.ts`
- Cuttlefish now exposes a generic human-checkpoint primitive on top of the existing
  approval store, so runs can pause for explicit human decisions without
  inventing producer-specific pause flows.
- Checkpoints record the decision needed, why it is needed, affected files,
  artifacts, and actions, allowed human options (`approved`, `rejected`,
  `deferred`, `revised`), approver identity when available, timestamp,
  decision notes, and resulting action.
- `POST /api/checkpoints` creates a checkpoint for a session and, by default,
  pauses the session in `waiting` with a visible notification trail.
- `GET /api/checkpoints` and `GET /api/checkpoints/:id` expose the checkpoint
  queue and history.
- `POST /api/checkpoints/:id/decision` records a human decision and either
  keeps the run paused, stops it, records the outcome only, or resumes the
  session with a stored or supplied prompt.
- Claude interactive Bash `PreToolUse` hooks now reuse this checkpoint flow for
  risky commands. Commands that are review-gated are denied at hook time,
  recorded as durable checkpoints with the blocked command and trigger
  categories, and generate review context for `senior-security-officer` by
  default.
- Existing fallback approvals continue to work through `/api/approvals/*`, but
  the underlying store now captures decision notes and resulting actions for the
  broader checkpoint model too.
- The `/approvals` web UI (`packages/web/src/routes/approvals/page.tsx`) has been
  significantly enhanced:
  - Pending approvals and checkpoints are shown in a unified list with compact list items.
  - Decided items display a colored `DecisionBadge` (`approved` / `rejected` / `deferred` / `revised`) inline.
  - The detail panel is now scrollable and renders structured approval content, artifact lists, and file/action context.
  - Board-assignee validation now returns an error when a ticket is assigned to an unknown employee (not just a cross-department employee).
  - The page renders correctly inside a scrollable layout region.

### External knowledge export and lookup
- `packages/cuttlefish/src/knowledge/*`
- `packages/cuttlefish/src/gateway/api/routes/knowledge.ts`
- `packages/cuttlefish/src/sessions/registry/external-outbox.ts`
- Cuttlefish now exposes a provider-neutral external knowledge seam that stays
  fully optional for public installs.
- Checkpoint decisions and completed session summaries are exported as durable,
  versioned envelopes through a local SQLite `external_outbox` first.
- Supported sinks are:
  - `noop` for compatibility/default no-op delivery
  - `jsonl` for local append-only envelope capture under `~/.cuttlefish/knowledge/outbox.jsonl`
  - `webhook` for generic downstream POST batches
- Supported read providers are:
  - `none` for disabled/default empty responses
  - `webhook` for generic provider-backed search/context lookups
- `GET /api/knowledge/outbox` lists stored outbox items.
- `POST /api/knowledge/outbox/flush` runs one best-effort relay pass.
- `POST /api/knowledge/search` and `POST /api/knowledge/context` proxy
  provider-neutral lookup requests when a read provider is configured.
- Local SQLite/session state remains authoritative; no downstream service is
  required for core Cuttlefish workflows.

### Exportable run bundles
- `packages/cuttlefish/src/gateway/run-bundles.ts`
- `packages/cuttlefish/src/gateway/api/routes/session-write.ts`
- `POST /api/sessions/:id/bundle` exports a completed session into a portable
  run bundle under managed Cuttlefish runtime storage.
- Each bundle includes `run.json`, `summary.md`, `artifacts/`, `logs/`,
  `manifest.json`, and `errors.json`.
- `run.json` captures the serialized session, messages, attachments, approvals,
  and checkpoints at export time.
- `summary.md` provides a human-readable overview of the run, prompt, resource
  attachments, checkpoints, and exported artifact counts.
- `artifacts/` copies only files produced by the run or explicitly attached as
  concrete files; folder attachments remain references in metadata and are not
  recursively copied.
- `logs/gateway.log` contains only session-relevant log lines filtered from the
  gateway log, so the bundle does not expose unrelated workspace activity.
- `manifest.json` inventories the bundle files, hashes, sizes, and high-level
  counts, forming the base contract for later import/replay work.

### Provider-neutral matrix orchestration observe routes
- `packages/cuttlefish/src/gateway/api/orchestration-routes.ts`
- `GET /api/orchestration/status` returns enabled/runtime-bound state, degraded
  reason, queue pause state, active counts, recent corrupt-DB recovery notices,
  and recent expired-lease interruption diagnostics.
- `GET /api/orchestration/workers` returns configured workers.
- `GET /api/orchestration/leases` returns existing durable orchestration leases.
- `GET /api/orchestration/queue` returns blocked-resource queue items, per-task pause records, missing roles, and resume triggers.
- `GET /api/orchestration/holds` returns active and inactive TTL-bounded hold records.
- `GET /api/orchestration/allocations` returns existing durable allocations.
- `GET /api/orchestration/continuations` returns durable blocked/failed continuation records.
- `GET /api/orchestration/telemetry/summary` returns bounded, summarized
  telemetry without raw records.
- `GET /api/orchestration/worktrees` returns managed worktree metadata without
  diffs.
- `GET /api/orchestration/dual-lane` returns sanitized dual-lane manifest summaries.
- `GET /api/orchestration/artifacts/:taskId/:kind?coordinatorId=<id>` returns bounded raw
  prompt, output, diff, or patch-apply artifact content for one run identity.
- `POST /api/orchestration/continuations/retry` re-attempts a failed continuation through the live runtime.
- `POST /api/orchestration/queue/pause` persists a global queue pause with an optional reason.
- `POST /api/orchestration/queue/resume` clears the global queue pause and retries queued work through live headroom.
- `POST /api/orchestration/queue/pause-task` and `POST /api/orchestration/queue/resume-task` persist and clear one queued task pause keyed by `taskId + coordinatorId`.
- `POST /api/orchestration/holds`, `POST /api/orchestration/holds/:id/extend`, and `POST /api/orchestration/holds/:id/cancel` manage TTL-bounded holds with `managerName` authorization.
- `POST /api/orchestration/leases/stop` interrupts the Cuttlefish session mapped to a running lease, or releases immediately when the mapped session is terminal.
- `POST /api/orchestration/run` executes `single_worker`, `single_worker_with_review`, `dual_lane`, `architecture`, and `local_heavy` tasks through the daemon runtime.
- `POST /api/orchestration/dual-lane/select` selects a completed dual-lane winner keyed by `taskId + coordinatorId` and archives/discards the loser lane.
- `POST /api/orchestration/dual-lane/apply` applies a selected or selection-required winner patch keyed by `taskId + coordinatorId` to the base repo as unstaged changes only.
- `POST /api/orchestration/recovery/requeue` imports one parsed recovered continuation from an explicit recovery manifest by `taskId + coordinatorId` and leaves it task-paused until resumed.
- Run responses include `reviewPolicy.explanations` for reviewer selection, explicit same-family fallback, and blocked reviewer allocation.
- Blocked live runs persist a durable continuation keyed by task/coordinator and auto-resume on later resource availability.
- These routes inherit the existing `/api/*` gateway token gate; unsupported methods on each path return `405`.
- Fidelity gaps:
  - GET routes observe state only; POST controls require an enabled live runtime.
  - The run route allocates leases, creates sessions, heartbeats leases on the existing 5s runner interval, passes isolated worktree cwd values to eligible implementation sessions, hands reviewers diff bundles, and releases leases on terminal paths.
  - If no orchestration runtime exists, state routes retain the no-daemon/test fallback; the run route fails instead of opening its own live scheduler.
  - Corrupt orchestration DB recovery quarantines the DB/WAL/SHM sidecars, writes an operator manifest under `~/.cuttlefish/orchestration-recovery/`, includes the manifest path in `store_corrupt_recovered` telemetry, and starts from an empty trusted store. Explicit requeue imports only parsed continuation/hold records and leaves work paused.
  - Lease stop does not release a running lease directly; the mapped run/session `finally` path remains release owner after interruption.
  - Runtime employee mutation and hold creation/extension/cancellation require `managerName`; managers can affect their hierarchy and executives can affect anyone.

### Kanban ticket dispatch scheduler bridge
- `packages/cuttlefish/src/gateway/org-worker-bridge.ts`
- `packages/cuttlefish/src/gateway/ticket-dispatch.ts`
- `packages/cuttlefish/src/gateway/board-worker.ts`
- `packages/cuttlefish/src/gateway/orchestration-runtime-factory.ts`
- When `orchestration.enabled: true`, manual ticket dispatch and the background board worker allocate an exact in-memory org-derived scheduler role before creating/running the board-linked session.
- Exact-worker dispatch applies live engine headroom before creating the lease,
  so unavailable, exhausted, or below-threshold engines do not get leased.
- A busy exact worker returns `orchestration-busy` and leaves the ticket in `todo`; no orchestration queue item is created because the board is already the durable backlog.
- Missing runtime or missing org-worker mapping returns `orchestration-unavailable` or `orchestration-worker-unmapped` and does not fall back to legacy direct dispatch.
- The manual dispatch route maps scheduler-specific failures to HTTP `409`.
- When orchestration is disabled, ticket dispatch keeps the legacy direct dispatch behavior.

### Internal session notification delivery
- `packages/cuttlefish/src/sessions/notification-sink.ts`
- `packages/cuttlefish/src/gateway/notification-sink.ts`
- Gateway-owned session callbacks use an injected in-process notification sink for
  parent-session, attached-talk, rate-limit, completion, and connector notifications.
- The direct sink avoids localhost loopback HTTP calls and repeated config file parsing
  on gateway hot paths. Callback helpers retain the old loopback path as a fallback
  for non-gateway and compatibility contexts.

### Kiro headless engine and estimated credit gauge
- Known diagnostic note: `docs/known-diagnostics.md` records the Kiro quota
  endpoint and Kiro-to-AWS routing gaps as accepted non-actionable diagnostics
  for future audits unless explicitly scoped.
- `kiro` is a registered headless engine. Work turns spawn:
  - `kiro-cli chat --no-interactive --trust-all-tools --model <model> [--effort <level>] [--resume-id <engineSessionId>] <prompt>`
- Session continuity is wired through Kiro's `--resume-id` flag. For fresh sessions, Cuttlefish attempts a bounded `kiro-cli chat --list-sessions --format json` lookup and stores the newest returned session id when available.
- Kiro stdout is ANSI-stripped and the `Credits: X.XX - Time: ...` / `Credits: X.XX • Time: ...` footer is removed from the assistant answer. The footer value is accumulated in `~/.cuttlefish/usage/kiro-credits.json`.
- The Kiro usage gauge is an estimate, not an authoritative provider quota. It uses `engines.kiro.creditBudget` and `engines.kiro.billingAnchorDay` to calculate remaining percentage, state, and reset time. If Kiro reports credit exhaustion during an actual turn, the normal usage-limit recovery path treats it as a blocking limit even if the local estimate was stale.
- Fidelity gaps:
  - Kiro credit usage depends on the CLI footer text; if Kiro changes that footer, the local ledger may stop updating until the parser is updated.
  - No stable local Kiro quota endpoint is wired, so the gauge cannot verify account-side credit balance.
  - This source tree does not contain a scheduler/provider map architecture for routing Kiro to AWS. No Kiro-to-AWS provider mapping was added.

### Context manager MVP
- Internal prompt/context assembly can run in `context.managerMode: off | shadow | on`, with `CUTTLEFISH_CONTEXT_MANAGER` as an environment override.
- `off` is the default and preserves existing behavior. `shadow` logs structured context metadata without changing engine input. `on` applies managed Cuttlefish-history selection only for synthetic-history engines: Ollama, Kilo, and Aider.
- Native-resume engines such as Claude, Codex, and Grok remain unmodified in `on` mode; they still rely on their CLI-owned session/thread state.
- V1 metadata includes estimated before/after tokens, model context limit, reserved response/safety budget, slot usage, dropped/summarized records, and an empty retrieved-memory placeholder. No persistent memory, vector retrieval, or MCP memory dependency is added.

### Smart manager delegation discipline
- Employee sessions with one or more direct reports receive a default-on manager delegation discipline block in their runtime context. The block requires a delegate-vs-inline decision before substantive work, lists concise direct-report specialties, and distinguishes smart delegation from delegation just for appearances.
- Runtime execution also enforces strong specialty matches before the manager model runs: when a manager prompt matches one or more direct-report specialties, the gateway creates child sessions for those reports, records the enforced prompt hash in `transportMeta`, and leaves the manager session ready to synthesize the existing child-completion callbacks. Child-result callback turns and explicit no-delegation prompts are exempt.
- Runtime execution logs a debug-only `manager_delegation` telemetry record for eligible manager sessions with child-session counts before and after the engine run or enforced delegation.
- Manual live behavior can be sampled with `node packages/cuttlefish/scripts/delegation-live-harness.mjs --employee <manager-slug>` against a running gateway. The harness is not part of CI because it depends on live model behavior and local credentials.

### `GET /api/org/departments/:name/tickets/:id/session`
- Best-effort ticket-to-session resolver for the kanban panel.
- Returns `200 { found:false }` when no live or recent matching session can be resolved.
- When a match exists, returns compact session state plus the latest transcript tail (capped to 8 messages).
- Matching prefers the most recently active session and resolves by:
  - `session.transportMeta.boardTicketId === ticket.id`
  - persisted `ticket.sessionId` matching the session id or engine session id
  - channel/session keys containing the ticket id

## Runtime Paths

### Live Cuttlefish path context
- `packages/cuttlefish/src/shared/paths.ts`
- Runtime path exports remain import-compatible, but they now refresh from a shared
  path context instead of being fixed permanently at first module evaluation.
- Tests and runtime helpers can call `setCuttlefishHomeForTest(<path>)` or
  `refreshCuttlefishPaths()` to redirect `CUTTLEFISH_HOME`-derived paths without a module reset.
- `getCuttlefishPaths()` returns an explicit snapshot for code that should avoid reading
  mutable module bindings directly.
### Command Center overview
- `packages/web/src/routes/command/page.tsx`
- `packages/web/src/hooks/use-command-center.ts`
- `packages/cuttlefish/src/gateway/api/routes/status.ts`
- `/command` is an executive summary page showing linked counts for agents, running agents, tickets, and cron jobs.
- The manager panel exposes direct-chat launch buttons that reuse the existing chat deep-link shape `/?employee=<slug>` instead of a new messaging flow.
- The agent usage panel rolls up per-agent session activity for day/week/month windows from persisted session fields: session count, accumulated cost, total turns, and summed `lastContextTokens` as an observed token-volume proxy.
- Ticket status counts are board-derived and link back to `/kanban`; cron count links to `/cron`; agent counts link to `/org`.

### Security-patch pass (2026-07-08)
- `packages/cuttlefish/src/gateway/api/routes/session-write.ts`
- `POST /api/sessions` can now return `429 { error, retryAfterMs }` before creating a
  session row when the gateway-wide concurrent-run cap is exhausted. New config field
  `sessions.maxConcurrentRuns` (default 12) sets the cap.
- Inbound email that fails untrusted-content screening now opens a human-review
  checkpoint instead of always auto-dispatching the agent turn; see the checkpoints UI.
- `PATCH /api/org/employees/:name` with `managerName` set now returns `403` when a
  session-scoped caller claims a manager identity other than its own bound employee.
- An employee's `execution.maxToolCalls` (if configured) is now enforced per engine
  session via the internal hook endpoint instead of being silently ignored.
