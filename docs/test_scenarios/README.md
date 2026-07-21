# Cuttlefish Playtest Scenario Library

End-to-end, user-facing test scenarios for exercising Cuttlefish like a real
operator would — through the CLI and the web dashboard, against a running
gateway. This library is the standing plan for exploratory playtest passes;
each pass executes these scenario cards and records results.

## Provenance and baseline

The methodology is derived from the `audit-playtest-app` skill
(`agent-skills` repo, `010_audit/audit-playtest-app/`): discover the app,
act like a curious/impatient/occasionally mistaken user, exercise happy
paths, invalid and boundary inputs, persistence, interruption, and recovery,
and report every issue with reproduction steps, severity, and user impact.
That skill's evidence discipline applies verbatim here:

- **Confirmed** issues are observed by running the app. **Suspicions** are
  inferred from code or docs. Label every finding as one or the other.
- Never claim a scenario was executed if it was only inferred. If the
  gateway could not be launched, say so and report what blocked it.
- Capture exact inputs, screen/route, visible error text, console/gateway
  log output, and observed state for every issue.

## Scope: what this library covers, and what it deliberately does not

This library targets behavior that is **only detectable by running the app
and using it as a user** — the gaps left by the repo's other audit and test
surfaces:

| Already covered elsewhere | Where | Excluded here |
|---|---|---|
| Static security posture, secrets, dependency hygiene | `010_audit` security audits, `scripts/validate-*`, secret-scan CI | Yes |
| Unit/integration correctness of modules | package test suites (`docs/TEST_LEDGER.md`) | Yes |
| Chat scroll behavior, nav-rail drag-and-drop, dashboard title | `e2e/*.spec.ts` Playwright specs | Yes |
| Architecture/code-structure drift | architecture/seam audits, router file contract | Yes |
| Design/visual quality | design-webapp style audits | Yes |

What remains — and what these scenarios cover — is the **lived operator
experience**: first-run setup, daemon lifecycle, session persistence across
restarts, delegation chains, cron firing, engine unavailability, interrupted
workflows, settings persistence, connector round-trips, approval gates,
model selection and switching, configured failover, inter-agent communication,
authorization boundaries, autonomous-authorization safety, context-history
selection, durable ingest/export boundaries, local voice recovery, load/stress
seams, error-message clarity, and cross-screen state consistency.

## Safety rails (binding for every pass)

- Run against a **disposable Cuttlefish home** (`CUTTLEFISH_HOME` pointed at
  a temp directory, or a fresh `~/.cuttlefish` on a test machine) — never an
  operator's live org, sessions, or connector credentials.
- Use test credentials/workspaces only for connector scenarios (Slack
  sandbox workspace, Twilio test credentials, throwaway IMAP inbox). If no
  test credentials exist, mark connector scenarios **Not executed —
  environment unavailable** rather than skipping silently.
- No real personal data. No malicious payloads or exploitation — invalid
  input here means *safe-but-wrong* (letters in number fields, empty
  required fields, oversized text, wrong file types).
- Engine scenarios need at least one signed-in engine CLI. Prefer the
  cheapest configuration available (e.g. a local Ollama model) so a full
  pass does not burn subscription/token budget.
- Everything written during a pass stays in the disposable home; clean up
  afterward.

## How to run a pass

1. **Environment**: Node 24.x (`.nvmrc` pins 24.13.0), pnpm 10+, at least
   one signed-in engine CLI. From a source checkout:
   `pnpm install && pnpm setup && pnpm cuttlefish start`, dashboard at
   `http://localhost:8888` (or configured `gateway.port`).
2. **Order**: execute files in numeric order — lifecycle first (nothing else
   works without a running gateway), then the primary chat happy path to
   confirm core value, then the remaining surfaces, then cross-cutting
   seams. Within a file, run scenarios top to bottom; later cards often
   depend on state created by earlier ones (dependencies are listed in
   preconditions).
3. **Record**: for each card, fill in *Actual result*, *Status*
   (Pass / Fail / Blocked / Not applicable / Not executed), *Confirmation*
   (Confirmed / Suspicion), and any issues found with reproduction steps.
   Keep the library itself clean — record results in the pass report, not
   by editing the cards.
4. **Report**: produce a playtest report (per the baseline skill's
   `templates/playtest-report.md` shape): what was run, how, scenarios
   executed vs. skipped and why, issues with severity, and recommended next
   passes. Durable summaries belong under `docs/audits/` per `AGENTS.md`.

## Scenario card format

Each scenario uses this condensed card (a trimmed version of the baseline
skill's `templates/scenario-card.md`):

```
### <ID> — <Name>
- Goal: what the user is trying to accomplish
- Category: happy path / invalid input / boundary / empty state /
  interruption / persistence / delete-undo / settings / navigation /
  recovery / files / concurrency
- Preconditions: required state, data, config
- Steps: numbered user actions (click, type, run command)
- Expected: what a correct app does
- Observe: seams and secondary effects to watch for
- Variations: additional input/order permutations to run under the same card
```

Severity scale for findings (from the baseline skill): **Critical** (crash,
data corruption, lost work, blocked primary workflow, irreversible action
without warning) · **High** (major workflow fails, wrong saved data, broken
relaunch state, unrecoverable without technical help) · **Medium**
(secondary workflow fails, unclear errors, stuck UI, non-persisting
settings) · **Low** (confusing label, glitch, awkward navigation) ·
**Note** (observation or product question).

## Rigor gates for every executed card

The fields above describe the workflow; these gates make the result
reproducible. Apply them to every card without duplicating them in each file:

1. Record the build commit, Cuttlefish version, OS/browser, active
   `CUTTLEFISH_HOME`, configured port, engine/model, and relevant feature flags.
2. Give every created entity a unique run marker and record its durable id.
   Do not use titles, model self-identification, or visual position as identity.
3. Capture start/end wall-clock times, HTTP/CLI exit status, visible UI state,
   and the corresponding durable/API state. A UI-only observation is not enough
   for persistence, authorization, or exact-once claims.
4. Bound every wait. Use two expected polling/scheduling intervals plus 30
   seconds unless the card states another limit; a timeout is a Fail with the
   last observed state, never an indefinite wait.
5. Run the named negative or control branch. If a card contains independent
   variations, report each as Pass/Fail/Blocked/Not executed; do not mark the
   whole card Pass while silently omitting a required branch.
6. Prove absence with a second surface: for example, no duplicate means one
   durable row/id *and* one UI entity after refresh; no side effect means a
   before/after filesystem or database snapshot, not merely an empty screen.
7. Restore changed flags/configuration and stop all spawned processes. Record
   cleanup failures and retain only the minimum redacted evidence needed for
   the report.

## Files

| File | Surface | Core question |
|---|---|---|
| [`01-first-run-and-lifecycle.md`](01-first-run-and-lifecycle.md) | setup, daemon start/stop/restart/status, first launch | Can a new operator get from clone to working dashboard, and does the daemon lifecycle behave? |
| [`02-chat-sessions.md`](02-chat-sessions.md) | `/` chat workspace, sessions, engines/models | Does the primary value proposition work, survive restarts, and fail legibly? |
| [`03-org-employees-delegation.md`](03-org-employees-delegation.md) | `/org`, employee YAML, hierarchy, delegation, `/talk` | Can the user build and run an org, and does delegation actually flow? |
| [`04-kanban-tickets.md`](04-kanban-tickets.md) | `/kanban` boards, dispatch, recycle bin | Do tickets move, dispatch, delete, and restore correctly? |
| [`05-cron-scheduling.md`](05-cron-scheduling.md) | `/cron`, hot reload, schedules | Do scheduled jobs fire, reload, and report failures? |
| [`06-skills.md`](06-skills.md) | `cuttlefish skills` CLI, `/skills` route | Does the skill lifecycle (find/add/list/update/use) work end to end? |
| [`07-connectors-email-sms.md`](07-connectors-email-sms.md) | Slack, WhatsApp, Twilio SMS, IMAP inboxes | Do inbound messages become sessions, and do allowlists/reloads behave? |
| [`08-approvals-orchestration.md`](08-approvals-orchestration.md) | `/approvals`, human checkpoints, `/orchestration`, recovery | Do gates hold, resume, and recover as the operator expects? |
| [`09-settings-files-navigation.md`](09-settings-files-navigation.md) | `/settings`, `/file`, uploads, `/limits`, `/activity`, `/archive`, cross-screen consistency | Do settings persist, files stay within policy, and screens agree with each other? |
| [`10-cli-surface.md`](10-cli-surface.md) | `cuttlefish` CLI beyond lifecycle: `pair`/`unpair`, `list`, JSON output, bad args | Is the CLI robust to real terminal usage and misuse? |
| [`11-model-selection-and-switching.md`](11-model-selection-and-switching.md) | composer/session model+effort, aliases, employee defaults, HR singleton profile rules | Does model selection stay honest across sessions, restarts, and HR constraints? |
| [`12-failover-and-fallback.md`](12-failover-and-fallback.md) | same-engine fallback, multi-role failover chains, reviewer loss policies, orchestration headroom | When a rung fails, does configured fallback fire visibly and stay scoped? |
| [`13-inter-agent-communication.md`](13-inter-agent-communication.md) | manager fan-out, `/talk`, cross-department services, mid-pair review, HR exclusion | Do agents communicate, attribute, and bound depth without cross-wiring? |
| [`14-authorization-and-approvals.md`](14-authorization-and-approvals.md) | operator-only org-change approval, checkpoint vocabulary, pairing auth modes, scoped tokens | Who can approve, pair, and act — and what must fail closed? |
| [`15-stress-and-adversarial.md`](15-stress-and-adversarial.md) | concurrency caps, stampedes, restart-under-load, path policy, export, budgets, hard-kill recovery, history bloat, clock jump, unicode org storm (SX-01–SX-32) | Does the gateway stay coherent when the operator is impatient or the environment is hostile? |
| [`16-autonomous-and-integrity.md`](16-autonomous-and-integrity.md) | autonomous authorization/dispatch, context selection, email claim recovery, artifact/knowledge integrity, local voice | Do the highest-risk trust boundaries fail closed, stay scoped, and remain observable? |
| [`17-operations-and-data-lifecycle.md`](17-operations-and-data-lifecycle.md) | readiness, migration, home isolation, board retention/reconciliation, resource and transfer integrity, Kiro usage | Do operator-facing lifecycle and durable-data boundaries remain truthful through change and recovery? |
| [`18-orchestration-control-plane.md`](18-orchestration-control-plane.md) | scheduler dry-runs, plans, live leases, queue controls, dual-lane apply, worktrees, recovery | Does the orchestration control plane stay inert when observing and exact when mutating? |
| [`19-manager-handoff-attention-lifecycle.md`](19-manager-handoff-attention-lifecycle.md) | delegated handoff, supervisor acknowledgement, operator attention, aggregate job state | Can managers recover complete worker evidence, contact the right supervisor twice, surface real decisions, and show when nested work is finished? |
| [`20-session-authority-collision-and-arbitration.md`](20-session-authority-collision-and-arbitration.md) | session/room authority collisions, prioritized messages, arbitration, deconfliction, board-independent attention, grouped agent chats, mentions/topics | When authorized agents and supervisors disagree, does the app freeze safely, choose one accountable winner, keep the sidebar coherent, and route room messages without widening authority? |

### Suggested pass shapes

| Pass | Files | Intent |
|---|---|---|
| Smoke / first day | 01 → 02 → 10 | Gateway up, one chat works, CLI is sane |
| Core product | 01 → 05, 08 → 09 | Org, tickets, cron, gates, settings |
| Model & resilience | 11, 12 | Selection honesty and failover under real engine pain |
| Multi-agent | 03, 13 | Delegation, talk, cross-dept, mid-pair |
| Authz | 08, 14 | Gates plus who is allowed to resolve them |
| Stress | 15 (after a green smoke) | Load, races, restart-under-load, environmental seams |
| Trust & recovery | 16 (after 01, 02, 14) | Autonomous scope plus durable handoff and local-model failure boundaries |
| Operations & data | 17 (after 01, 04, 09, 10) | Migration, readiness, retention, transfer, and durable-resource truth |
| Orchestration control plane | 18 (after 01, 08, 12) | Scheduler/queue/lease/dual-lane/recovery semantics |
| Manager handoff regression | 19 (after 02, 08, 13, 14) | Child-result visibility, acknowledgement timing, attention, delegated authority, and job completion |
| Authority collision & attention | 20 (after 13, 14, 19) | Same-target conflicts, COO/Parliamentarian arbitration, message priority, deconfliction, and durable human indicators |
| Full library | 01 → 20 numeric order | Release or major-regression playtest |

Files 11–20 deliberately deepen themes that appear lightly in 01–10 (for
example `CH-03` model switch, `CH-08` rate limits, `ORG-06` delegation,
`AP-01` gates, `ST-07` pairing). Prefer the deeper file when the pass is
about that theme; do not edit older cards to remove overlap — record
results once and cross-reference.

## Required coverage checklist

A pass is complete only when every category below has at least one executed
scenario (or an explicit not-applicable/blocked note):

- [ ] First launch / initial empty state
- [ ] Primary happy-path workflow (chat → response)
- [ ] Primary workflow with invalid input
- [ ] Save / persistence behavior
- [ ] Delete, cancel, or undo behavior
- [ ] Settings or preferences persistence
- [ ] Navigation across all dashboard routes
- [ ] Close and relaunch (daemon restart) behavior
- [ ] Interrupted or stopped workflow
- [ ] File upload / viewing, run-bundle export
- [ ] Error recovery (engine unavailable, rate limit, crash)
- [ ] Edge or boundary input
- [ ] Model / engine selection and mid-session switching
- [ ] Configured failover or fallback path
- [ ] Inter-agent communication (delegation, talk, or cross-request)
- [ ] Authorization boundary (operator vs scoped agent / pairing)
- [ ] Concurrency or load stress (multi-session, cap, or stampede)
- [ ] Autonomous authorization boundary (dual consensus, exact project, kill switch)
- [ ] Context-history selection boundary (synthetic vs native-resume engine)
- [ ] Durable external handoff degradation (email, artifact, or knowledge)
- [ ] Local voice acquisition or explicit unavailable-environment result
- [ ] Migration check/apply/failure recovery and custom-home isolation
- [ ] Liveness/readiness/operator-status separation under dependency failure
- [ ] Retention/reconciliation boundary (ticket, lease, telemetry, or recovery record)
- [ ] Orchestration observation is inert; mutation is explicit and attributable
- [ ] Queue, lease, dual-lane, or recovery-manifest control-plane transition
- [ ] Manager handoff lifecycle (full direct-child evidence, two supervisor contacts, bounded escalation)
- [ ] Operator-attention and delegated-job terminal state visible in both API and UI
- [ ] Same-target authority collision freezes before side effects and resolves to one accountable winner
- [ ] Agent-to-human FYI/reply/approval indicators remain visible without requiring a Kanban board
