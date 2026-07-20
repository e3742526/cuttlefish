# Provider-Neutral Matrix Orchestration

> **CLI exposure note (verified 2026-07-20):** the orchestration command
> handlers documented below exist, but the canonical Cuttlefish binary does not
> currently register their command groups. `cuttlefish --help` therefore omits
> `workers`, `scheduler`, `run`, `queue`, `dual-lane`, and `worktree`. Use the
> authenticated orchestration API/dashboard for live operations; treat the CLI
> examples as blocked until binary registration is repaired.

Status: implemented as a provider-neutral foundation with durable
scheduler-state, provider-adapter contract modules, opt-in live-adapter
plumbing, coordinator planning, observe surfaces, and the first opt-in live run
modes. The live modes are daemon-gated by `orchestration.enabled` and route
through the existing Cuttlefish session path. Git worktree execution is implemented
for isolated implementation lanes plus diff-only review bundles. Live
cross-family reviewer policy is implemented with fail-closed same-family
fallback and structured explanations. Dual-lane competition is implemented for
explicit OpenAI/Anthropic lane runs with deterministic comparison reports and a
human selection gate. Board-originated ticket dispatch is scheduler-aware when
`orchestration.enabled: true`. Durable JSONL telemetry, `cuttlefish scheduler stats`,
and optional empirical-routing tie-breaks are implemented. The operations
dashboard exposes safe controls for failed-continuation retry, explicit
dual-lane winner selection/apply, global and per-task queue pause/resume,
TTL-bounded holds, raw artifact viewing, recovery requeue, and strict
running-lease stop. Terminal allocation and internal scheduler telemetry
retention are bounded by default. Corrupt orchestration DB recovery remains
conservative: the DB is quarantined, an operator recovery manifest is written,
and Cuttlefish starts with an empty orchestration store rather than reconstructing
from untrusted state; explicit requeue imports parsed records back to paused
queued state only.

## Intent

The matrix layer is the first Cuttlefish-hosted foundation for a later Cuttlefish
scheduler. It models a central scheduler, persistent worker pool, ephemeral
coordinators, exclusive leases, blocked-resource queueing, provider-aware
routing, and deterministic QA gates.

The first slices exist to make scheduler behavior and restart recovery testable
before real provider execution is added. Tests and validation remain the
authority; model confidence does not grant runtime authority.

## Terminology

Use these terms in code and operator-facing orchestration docs:

- Worker: provider/model/tool/workspace capability slot.
- Coordinator: ephemeral task owner requesting capabilities.
- Scheduler: central allocator that grants leases.
- Lease: exclusive permission for one worker to handle one role for one task.
- Allocation: workers assigned to a task.
- Queue: suspended blocked task state.
- ProviderLane: provider or local compute family.
- Capability: named skill or execution capability.

Do not use employee, manager, department, boss, or reportee in the orchestration
module. The existing Cuttlefish org system maps to workers through a gateway-side
bridge so orchestration core vocabulary stays provider-neutral.

## Config Files

The CLI dry-runs load an explicit config directory. Code-level loaders also
support the default operator directory at `~/.cuttlefish/orchestration/`, but the
current CLI commands still require `--config-dir`. See
`docs/orchestration/examples/` for complete examples.

`cuttlefish setup` seeds `~/.cuttlefish/orchestration/` with a default config from
`packages/cuttlefish/template/orchestration/` (a curated five-worker pool whose teams
are all staffable — see "Default config" below). Setup skips files that already
exist, so re-running it backfills older local homes and never overwrites
operator edits.

Required files:

- `workers.yaml`
- `roles.yaml`
- `coordinators.yaml`

Optional file:

- `quotas.yaml`

Worker records describe provider, family, tier, capabilities, tools,
concurrency, cost class, and workspace policy. Roles describe required
capabilities/tools and routing constraints. Coordinator templates define the
minimum viable team for a task class. Quotas bound active provider/family leases.

### Default config

The seeded default (`packages/cuttlefish/template/orchestration/`) is a curated
five-worker pool whose `provider` values are live Cuttlefish engine adapter ids and
whose `family` values are model vendors used for cross-family review:

| Worker | provider / family | Staffs role(s) |
| --- | --- | --- |
| `codexImplementer` | codex / openai | seniorImplementer |
| `codexArchitect` | codex / openai | architect |
| `claudeReviewer` | claude / anthropic | independentReviewer |
| `antigravityReviewer` | antigravity / google | adversarialReviewer (+ backup code_review) |
| `localWorker` | pi / local | qaGate, localTriage |

Every role in every coordinator template can be staffed by a distinct worker;
`orchestration/__tests__/template-config.test.ts` asserts this. Notably,
`architectureChange` needs `independentReviewer` and `adversarialReviewer` as two
different workers in one allocation — `antigravityReviewer` exists so that team is
satisfiable (the earlier roster had only one review-capable worker and blocked).
Each worker is also declared as a governed agent surface in
`governance/agent_registry.yaml` with instructions under
`docs/orchestration/agent-instructions/`.

## CLI

Dry-run and observation commands require an explicit `--config-dir`.
State-observation commands accept `--db-path`; tests and examples should pass a
temp DB path instead of reading live `~/.cuttlefish`. `cuttlefish run` is different: it
requires a running gateway with `orchestration.enabled: true` and sends the task
brief to the daemon-owned scheduler.

```bash
cuttlefish workers list --config-dir docs/orchestration/examples
cuttlefish workers list --config-dir docs/orchestration/examples --json

cuttlefish scheduler allocate docs/orchestration/examples/task-standard.yaml \
  --config-dir docs/orchestration/examples \
  --dry-run

cuttlefish scheduler simulate docs/orchestration/examples/scenario-blocked-resource.yaml \
  --config-dir docs/orchestration/examples \
  --json
cuttlefish scheduler stats --json
cuttlefish scheduler stats --path /tmp/orchestration-telemetry.jsonl

cuttlefish leases list --config-dir docs/orchestration/examples --db-path /tmp/orchestration.db --json
cuttlefish queue list --config-dir docs/orchestration/examples --db-path /tmp/orchestration.db --json
cuttlefish scheduler plan docs/orchestration/examples/task-standard.yaml \
  --config-dir docs/orchestration/examples \
  --db-path /tmp/orchestration.db \
  --json

cuttlefish run --mode single_worker --task docs/orchestration/examples/task-live.yaml
cuttlefish run --mode single_worker_with_review --task docs/orchestration/examples/task-live.yaml --json
cuttlefish run --mode dual_lane --task docs/orchestration/examples/task-live.yaml
cuttlefish run --mode architecture --task docs/orchestration/examples/task-architecture.yaml
cuttlefish run --mode local_heavy --task docs/orchestration/examples/task-local-heavy.yaml
cuttlefish dual-lane select --task-id task-live --coordinator-id task-live-review --winner openai
cuttlefish dual-lane apply --task-id task-live --coordinator-id task-live-review --winner openai
cuttlefish queue pause-task --task-id task-live --coordinator-id task-live-review
cuttlefish holds list --json
cuttlefish artifacts view --task-id task-live --coordinator-id task-live-review --kind diff
cuttlefish continuations list
cuttlefish continuations retry --task-id task-live --coordinator-id task-live-review
cuttlefish recovery notices --json
cuttlefish recovery requeue --manifest ~/.cuttlefish/orchestration-recovery/<manifest>.json --task-id task-live --coordinator-id task-live-review --manager-name <manager>

cuttlefish worktree create docs/orchestration/examples/task-live.yaml --lane seniorImplementer
cuttlefish worktree diff docs/orchestration/examples/task-live.yaml --lane seniorImplementer
cuttlefish worktree cleanup docs/orchestration/examples/task-live.yaml --lane seniorImplementer
```

`scheduler allocate` intentionally requires `--dry-run`. Without it, the command
fails because real provider execution is out of scope for this slice.

`scheduler plan` turns a task brief plus coordinator template into an allocation
plan. It supports `matrix`, `single_worker`, `single_worker_with_review`,
`architecture`, and `local_heavy` planning modes. It may account for persisted
leases/queue when `--db-path` points to an existing orchestration database, but
it does not persist the plan or run any provider.

`cuttlefish run` accepts task YAML containing allocation fields plus `prompt`. The CLI
does not open the scheduler DB directly; it posts the task to
`POST /api/orchestration/run` with the gateway token. The daemon allocates on
its single runtime scheduler, creates normal Cuttlefish sessions with lease metadata in
`transportMeta`, heartbeats the lease on the existing 5s session heartbeat, and
releases leases in `finally` after each role turn settles.
For `single_worker_with_review`, JSON output includes `reviewPolicy.explanations`.
Text output prints the reviewer policy decision so same-family fallback or a
blocked reviewer is not silent. If any leased role session errors, the live run
returns `ok: false, state: "failed"` with the session evidence preserved.
`dual_lane` runs allocate OpenAI and Anthropic implementation roles atomically
using `openaiRole` and `anthropicRole` task fields, defaulting to
`openaiImplementer` and `anthropicImplementer`. Both lanes receive the identical
prompt in separate managed git worktrees. Successful runs return
`state: "selection_required"` with a deterministic comparison report and raw
prompt/output/diff artifacts. Dual-lane operator actions use the strict run
identity `taskId + coordinatorId`. Use `cuttlefish dual-lane select --task-id <id>
--coordinator-id <id> --winner openai|anthropic` to explicitly choose the
retained lane and archive then remove the loser lane. Use `cuttlefish dual-lane apply
--task-id <id> --coordinator-id <id> --winner openai|anthropic` to apply the
winner patch to the base repo as unstaged changes only; dirty base worktrees,
missing winner worktrees, empty patches, and patch conflicts are refused.
`cuttlefish continuations list` inspects durable blocked/failed continuation records
through the live gateway. `cuttlefish continuations retry` re-attempts a continuation
only when it is already in `failed` state; queued continuations remain
scheduler-owned and resume on resource events.
`architecture` requires architect, implementer, independent reviewer,
adversarial reviewer, and QA roles in the resolved task/template and runs those
roles through the same session, lease, telemetry, queue, pause/resume, retry,
and persistence paths as other live modes. `local_heavy` is limited to
local/near-zero or low-cost non-editing roles; roles requiring `repo_edit` or
`coding` are rejected before allocation.

`cuttlefish recovery notices` lists recent corrupt orchestration DB recovery manifests
from `~/.cuttlefish/orchestration-recovery/`. `cuttlefish recovery requeue` imports one
operator-selected recovered continuation from a manifest by `taskId +
coordinatorId`, keeps it queued, and adds a per-task pause so it cannot dispatch
until explicitly resumed.

`cuttlefish worktree create|diff|cleanup` uses the live `config.yaml`
`orchestration.worktreeRoot` and `orchestration.maxWorktrees` settings. The
helpers operate only on directories with Cuttlefish's managed worktree marker.

`cuttlefish scheduler stats` reads append-only orchestration telemetry from
`~/.cuttlefish/logs/orchestration-telemetry.jsonl` by default, or from `--path <file>`.
`--json` returns `{ totals, byProvider, byFamily, byRole, byWorker,
skippedLines }`. Malformed JSONL lines are skipped and counted.

## API

Gateway routes under `/api/orchestration/` inherit the existing `/api/*`
gateway token gate.

- `GET /api/orchestration/status`
- `GET /api/orchestration/workers`
- `GET /api/orchestration/leases`
- `GET /api/orchestration/queue`
- `GET /api/orchestration/allocations`
- `GET /api/orchestration/continuations`
- `GET /api/orchestration/telemetry/summary`
- `GET /api/orchestration/worktrees`
- `GET /api/orchestration/dual-lane`
- `GET /api/orchestration/holds`
- `GET /api/orchestration/artifacts/:taskId/:kind?coordinatorId=<id>`
- `POST /api/orchestration/queue/pause`
- `POST /api/orchestration/queue/resume`
- `POST /api/orchestration/queue/pause-task`
- `POST /api/orchestration/queue/resume-task`
- `POST /api/orchestration/holds`
- `POST /api/orchestration/holds/:id/extend`
- `POST /api/orchestration/holds/:id/cancel`
- `POST /api/orchestration/leases/stop`
- `POST /api/orchestration/continuations/retry`
- `POST /api/orchestration/run`
- `POST /api/orchestration/dual-lane/select`
- `POST /api/orchestration/dual-lane/apply`
- `POST /api/orchestration/recovery/requeue`

The GET routes return status, configured workers, scheduler state, bounded
telemetry summaries, managed worktree summaries, and sanitized dual-lane
manifest summaries. Raw prompt, model output when available, diff, and patch
apply artifacts are returned only through the explicit artifact route. Headers,
secrets, and env values are not returned. When the daemon runtime exists,
scheduler-state routes read that shared instance; otherwise they use the old
no-daemon/test fallback that opens a scheduler for read-only inspection.
`GET /api/orchestration/status` also includes `recoveryNotices`, a bounded list
of recent corrupt-DB recovery manifests with paths and operator guidance
metadata only, and `expiredLeaseHandling`, the last best-effort session
interruption outcomes for leases that expired before normal release.

`POST /api/orchestration/run` executes `single_worker`,
`single_worker_with_review`, `dual_lane`, `architecture`, and `local_heavy`
tasks through the existing session runner. It does not create dashboard
controls. When an implementation worker has
`workspacePolicy: isolated_worktree` and the resolved task `cwd` is inside a git
repo, the run path creates a task/lane-scoped worktree and passes that path as
the session `cwd`. Reviewer turns do not run in that worktree; they receive a
generated diff bundle directory containing `patch.diff` and `metadata.json`.
`POST /api/orchestration/dual-lane/select` explicitly selects the winning lane,
archives the loser diff/metadata, and removes the loser worktree.
`POST /api/orchestration/dual-lane/apply` applies a selected or
selection-required winner patch to the base repo as unstaged changes only.
Non-supported methods return `405`.
Run responses include structured `reviewPolicy.explanations` when reviewer
family policy selects, falls back, or blocks a reviewer. Blocked live runs
persist a durable continuation and auto-resume on later resource availability.
Failed continuations remain inspectable and can be retried explicitly through
the continuation routes. Manual retry does not target still-queued
continuations, which continue to resume only on scheduler resource events.
Manual failed-continuation retry applies live engine headroom before creating a
new lease. Orchestration-backed ticket dispatch also applies live headroom before
exact-worker allocation for both manual and board-worker dispatch.
`POST /api/orchestration/queue/pause` persists a global queue pause reason in
the orchestration DB. While paused, release/expiry/retry events leave queued
continuations dormant. `POST /api/orchestration/queue/resume` clears that state
and resumes through the normal live-headroom-aware retry path.
`POST /api/orchestration/queue/pause-task` and
`POST /api/orchestration/queue/resume-task` persist and clear a queue pause for
one `taskId + coordinatorId`; resume retries only that matching queued task.
`POST /api/orchestration/holds`, `extend`, and `cancel` require `managerName`.
Managers can hold workers in their hierarchy; executives can hold any worker.
`POST /api/orchestration/leases/stop` resolves a running lease to its mapped
Cuttlefish session via `transportMeta.orchestrationLease.leaseId`. If the session is
running and its engine is interruptible, the route interrupts the engine,
clears that session queue, marks the session `interrupted`, and leaves lease
release to the run/session `finally` path. If the mapped session is already
terminal, the route releases the lease immediately. Missing mappings or
non-interruptible engines return `409` and leave the lease running.

## Retention And Recovery

Allocations stay `allocated` while any lease is running. Once all leases are
terminal, an allocation becomes `completed` when all leases were released or
`expired` when no lease is running and at least one lease expired. Terminal
allocations are retained for 24 hours by default and capped at 1,000 newest
terminal records. Running allocations are never pruned. Internal scheduler
telemetry is retained for 24 hours and capped at 2,000 newest events. The
append-only JSONL run telemetry file is retained for 90 days or 10,000 newest
valid records by default, and is compacted on runtime boot/reaper ticks rather
than on every append.

If the orchestration SQLite DB is corrupt, Cuttlefish moves the DB plus any WAL/SHM
sidecars to quarantine paths, writes a recovery manifest under
`~/.cuttlefish/orchestration-recovery/`, emits `store_corrupt_recovered` telemetry
with the manifest path, and starts with an empty orchestration DB. Operators
must inspect the manifest and quarantined files manually if recovery is needed.
Recovery manifests and quarantined DB sidecars are pruned on runtime boot/reaper
ticks after 30 days or beyond the newest 100 notice groups.

## Smoke Test

`scripts/orchestration-smoke.mjs` is opt-in:

```bash
node scripts/orchestration-smoke.mjs
CUTTLEFISH_ORCHESTRATION_SMOKE=1 node scripts/orchestration-smoke.mjs
```

Without `CUTTLEFISH_ORCHESTRATION_SMOKE=1`, it prints a skip message and exits 0.
When enabled, it requires a running daemon with `orchestration.enabled: true`,
uses `CUTTLEFISH_GATEWAY_URL`/`CUTTLEFISH_GATEWAY_TOKEN` or the existing gateway info file,
and posts one `single_worker` smoke task to `/api/orchestration/run`.

## Web Dashboard

`/orchestration` is an observe-first operations dashboard. It reads the API
routes above and shows runtime status, workers, running leases, blocked queue
items, durable continuations, dual-lane selection manifests, managed worktrees,
and telemetry/cost summaries.

The mutating dashboard actions are:

- retry a continuation whose state is exactly `failed`;
- select `openai` or `anthropic` for a dual-lane manifest whose state is exactly
  `selection_required`;
- apply a dual-lane winner as unstaged base repo changes;
- pause or resume the global orchestration queue or one queued task;
- create, extend, cancel, and list TTL-bounded holds;
- view raw prompt, output, and diff artifacts;
- requeue selected recovered continuations from recovery notices;
- stop a running lease through the mapped Cuttlefish session interruption path.

## Org Board Dispatch

When `orchestration.enabled: true`, manual kanban ticket dispatch and the
background board worker allocate an exact scheduler role for the selected org
assignee or department manager before creating/running the board session. The
gateway-side bridge reads `scanOrg()` output, synthesizes deterministic
workers/roles in memory, and never writes org YAML or user orchestration YAML.

Board tickets stay the durable backlog. Board-originated dispatch uses an
immediate allocation path: if the exact org worker is busy or quota-constrained,
Cuttlefish does not create a scheduler queue item. The ticket remains `todo` and the
dispatch returns/logs `orchestration-busy`. If orchestration is enabled but the
runtime or org-worker mapping is unavailable, dispatch returns/logs
`orchestration-unavailable` or `orchestration-worker-unmapped` and does not fall
back to legacy direct dispatch. When orchestration is disabled, manual dispatch
and board-worker dispatch retain the legacy direct path.

Board-linked sessions keep their existing `employee`, `model`, `effortLevel`,
board metadata, ticket status, and idempotent retry behavior. The scheduler
lease metadata is added to `session.transportMeta.orchestrationLease`, so the
existing run heartbeat renews the lease while the session runs. Ticket dispatch
owns release: setup failures release immediately, and launched runs release in a
`finally` handler after `dispatchWebSessionRun()` settles.

Kanban board saves use per-ticket optimistic concurrency. The web client sends
the last observed server `updatedAt` as `baseUpdatedAt`, and the gateway rejects
stale board updates or stale active-ticket deletions with HTTP `409` and
`reason: "board-conflict"`. This prevents an operator layout loaded before a
background dispatch from silently moving a running ticket back to `todo` or
dropping its `sessionId`.

## Scheduler Behavior

- Required roles allocate atomically: all required leases are created, or no
  leases are created and the task enters `blocked_resource`.
- Optional roles are attempted after required roles and may be skipped.
- Workers are matched by required capabilities, required tools, allowed family,
  family constraint, max concurrency, and provider/family quota.
- Default routing is deterministic: preferred tier/cost first when configured,
  otherwise lower cost class first, then lexical worker id.
- Opposite-family reviewers compare against already selected implementer roles.
- Same-family reviewer fallback is forbidden by default. Setting
  `orchestration.sameFamilyReviewerFallback: true` lets live review allocation
  use a same-family reviewer only after no qualified opposite-family reviewer is
  available. Opposite-family candidates still win when present.
- Setting `orchestration.empiricalRouting: true` makes the runtime read durable
  telemetry at boot and compute per-worker scores. Scores are deterministic
  tie-breakers only: they run after hard constraints and explicit tier/cost
  preferences, and cannot bypass capability, quota, family, lease, or cost
  ordering rules.
- Reviewer selection and blocked-reviewer allocation return structured
  explanations with candidate ids, implementer families, the selected worker
  when any, and the policy decision.
- Queued tasks do not keep a model running. They resume only when the scheduler
  is asked to retry after a resource event such as release or expiry.
- Lease validation rejects missing, expired, released, foreign-worker,
  foreign-task, and foreign-coordinator leases.

## Runtime Policy Config

The live daemon runtime reads these optional `config.yaml` keys:

```yaml
orchestration:
  enabled: true
  sameFamilyReviewerFallback: false
  empiricalRouting: false
```

`sameFamilyReviewerFallback` and `empiricalRouting` default to `false`. Both are
boolean only; invalid types are rejected by config validation.

## Durable State

`packages/cuttlefish/src/orchestration/store.ts` is the durable store facade for a
dedicated SQLite database at `~/.cuttlefish/orchestration.db` by default.
`store-schema.ts` owns WAL setup, migrations, and corrupt-DB quarantine;
`store-snapshot.ts` owns scheduler snapshot load/save/delta SQL; and
`store-continuations.ts` owns live continuation and queue-control SQL. Tests
pass explicit temp database paths and do not write live `~/.cuttlefish`.

`packages/cuttlefish/src/orchestration/persistent-scheduler.ts` hydrates a
`MatrixScheduler` from stored rows, persists mutations with incremental
upserts/deletes, and expires stale leases deterministically on hydrate. The
daemon constructs one runtime scheduler when `orchestration.enabled: true`,
starts an expiry/retry timer, and prepares the scheduler before shutdown by
stopping new queued resumes, marking in-flight continuations failed, and releasing
running leases before closing the store. Plain CLI inspection still uses explicit
temp paths or read-only fallbacks. On config or org reload, the gateway keeps an
active runtime bound and defers replacement until active leases, queued work, and
dispatching continuations drain; the deferred refresh is replayed by the status
reconciler after drain. Stale `dispatching` continuations from a prior daemon are
recovered on boot so they cannot keep the runtime permanently active.

## Durable Telemetry

Orchestration live turns append one JSON line per scheduler-owned run to
`~/.cuttlefish/logs/orchestration-telemetry.jsonl` with file mode `0600` when the file
is created. Records cover `single_worker`, review turns, resumed queued runs,
dual-lane lane turns, explicit dual-lane selection outcomes, and M9
scheduler-owned manual/board ticket dispatch.

Telemetry fields are intentionally narrow: task/coordinator/session/lease/worker
ids, provider, family, model, role, mode, source, cost, latency, tokens, changed
file count, added test count, nullable QA/review counters, disposition, and
timestamp. Cuttlefish does not log prompts, model output, raw diffs, cwd/worktree
paths, credentials, headers, or environment values. Worktree metrics are counts
derived from diffs, not file paths.

Worker scores are derived from historical dispositions when
`orchestration.empiricalRouting: true`: completed and selected work improves the
score; failed, blocked, discarded, blocker-heavy, or regression-heavy records
degrade it. Runtime empirical routing uses decayed scoring with a 14-day
half-life and ignores records older than 90 days; future timestamps are treated
as age zero. Corrupt telemetry lines do not block runtime startup; they are
skipped and counted. Runtime score loading reads a bounded tail of the JSONL log,
while CLI stats can still read an explicit full file. Hot-path run telemetry
append avoids per-record fsync stalls but keeps private append-only JSONL records.
Orchestration control events also append hash-chained `audit.jsonl` records for
queue pause/resume, per-task pause/resume, holds, artifact records, dual-lane
apply attempts, and recovery requeue imports.

## Worktrees

Implementation workers with `workspacePolicy: isolated_worktree` run in a
managed git worktree rooted at `orchestration.worktreeRoot` (default:
`~/.cuttlefish/worktrees`). `orchestration.maxWorktrees` bounds the number of managed
worktrees that can exist at once. If the resolved task `cwd` is not inside a git
repo, Cuttlefish logs a downgrade and uses the current shared-cwd behavior.

For `single_worker_with_review`, the reviewer receives a generated diff-only
bundle outside the repository/worktree after the implementer lease has been
released. The bundle contains `patch.diff` plus `metadata.json`, so the patch
remains inspectable without handing the reviewer the implementation tree as its
session `cwd`. The implementation worktree is cleaned up at task end. If
cleanup is missed, the runtime's existing boot/timer reaper removes managed
worktrees whose task no longer has a running lease and removes review bundles
older than 24 hours.

For `dual_lane`, OpenAI and Anthropic lanes always require managed git
worktrees; non-git cwd downgrade is rejected instead of silently sharing a
workspace. The runtime reaper protects dual-lane worktrees while a selection is
pending or after a winner is selected. Explicit selection archives the loser
lane's diff and metadata under `~/.cuttlefish/tmp/orchestration-dual-lane/<task>/`
and removes the loser worktree. The selected winner worktree remains for manual
inspection/integration.

## Provider Adapters

`packages/cuttlefish/src/orchestration/adapter/` defines the provider-neutral adapter
contract. Adapters receive lease validation through an injected function, so the
adapter layer can validate against either `MatrixScheduler` or
`PersistentMatrixScheduler` without importing the store.

The default adapter registry remains inert and registers only:

- `local_echo` and `mock`: validate the lease, then run the deterministic
  `MockEngine`.
- `manual`: validates the lease, then returns `manual_required`.
- `stub`: validates the lease, then returns `unsupported_operation`.

`real-adapter.ts` plus `createLiveProviderAdapterRegistry` are experimental,
opt-in parity infrastructure. They are not the production orchestration
execution contract. If explicitly constructed by tests or future experiments,
live adapters receive the gateway's existing engine `Map` as a dependency and
register only existing Cuttlefish engine ids (`claude`, `codex`, `antigravity`,
`grok`, `hermes`, `pi`, `kiro`) that are present in the injected map; unknown
providers still fail closed with `adapter_not_found`.

Live adapter behavior is intentionally narrow:

- `startTask` validates the lease first, then requires `EngineRunOpts.sessionId`
  and delegates to the injected engine.
- `cancel` uses the captured session id and `InterruptibleEngine.kill` when the
  engine supports interruption.
- `streamOutput` registers a callback against the live run's stream tee.
- Claude workers reject explicit headless bypass flags and rely on the gateway's
  injected interactive PTY engine.

This is not a live scheduler mode. No route, CLI command, dashboard control, or
daemon startup path calls the live adapter factory; production live
orchestration continues through the daemon-owned scheduler and existing Cuttlefish
session path.

## Usage-Aware Routing

`packages/cuttlefish/src/orchestration/routing-headroom.ts` provides an opt-in
`engineHasHeadroom(worker, config)` predicate and a worker filter helper. It
reuses the existing `usage-status.ts` engine limit snapshots and the
`boardWorker.usage.minRemainingPercent` default. Known live engines are filtered
when unavailable, exhausted, or below the configured remaining-percent floor.
Inert providers such as `local_echo` are allowed through so dry-runs and
simulation remain deterministic.

## Failure Modes

- Invalid config fails during schema validation with a clear path-specific
  message.
- Unknown roles fail allocation before provider execution can exist.
- Provider quota exhaustion blocks the whole required allocation instead of
  reserving a partial team.
- Lease heartbeat renews `leaseExpiresAt` with a sliding TTL, so long turns do
  not free a worker mid-run while the 5s heartbeat is alive.
- Lease expiry releases worker capacity deterministically when `expireLeases`
  runs, when the persistent wrapper hydrates stale leases, or when the runtime
  reaper fires.
- Corrupt DB recovery quarantines the DB and surfaces recovery telemetry instead
  of silently presenting an ordinary empty state.
- Adapter start rejects invalid leases before any inert engine can run.
- Same-family reviewer fallback is never implicit. If fallback is disabled and
  only same-family reviewers qualify, allocation returns `blocked_resource` with
  a `same_family_fallback_forbidden` explanation.
- Observe-only API routes reject mutating HTTP methods and return existing
  workers/leases/queue/allocations only.
- Durable scheduler state, adapter contracts, opt-in live adapters, headroom
  predicates, daemon runtime ownership, first live run modes, git worktree
  isolation, live cross-family reviewer policy, dual-lane competition,
  board-worker integration, and durable telemetry aggregation are implemented.
  Dashboard controls for failed-continuation retry, dual-lane selection/apply,
  global and per-task queue pause/resume, holds, artifacts, recovery requeue,
  and strict lease stop are implemented.

## Later Milestones

- Optional per-human identity integration beyond the existing gateway auth
  boundary and explicit `managerName` authorization field.
