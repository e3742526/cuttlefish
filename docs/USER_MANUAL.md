# User Manual

## What Cuttlefish Does

Cuttlefish is a local gateway daemon and web dashboard for coordinating professional AI
coding CLIs. It runs external engines such as Claude Code, Codex, Grok,
Antigravity, Pi, Hermes, and Kiro through a shared org/delegation model.

## Who It Is For

- Operators who already use coding-agent CLIs and want one local dashboard.
- Teams experimenting with AI "employees", departments, cron jobs, connectors,
  and controlled delegation.
- Developers who want local orchestration without replacing official engine CLIs.

## Core Concepts

- **Gateway daemon:** local Node process that serves the API and dashboard.
- **Engine:** external CLI Cuttlefish invokes for model work.
- **Employee:** configured persona/role with an engine/model/department.
- **Session:** persisted conversation or work run.
- **Connector:** Slack, WhatsApp, Twilio SMS, or similar integration.
- **Skill:** reusable Markdown playbook synced into agent workflows.
- **Orchestration:** scheduler/runtime for multi-role tasks, leases,
  continuations, holds, worktrees, and dual-lane operations.

## Installation And Setup

Canonical install instructions (Windows, macOS, Linux; npm, archives, source):
**[INSTALL.md](INSTALL.md)**.

1. Install Node.js 24.x. This repo pins Node 24.13.0 via `.nvmrc` and root tooling enforces `>=24 <25`.
2. Install and sign in to at least one engine CLI.
3. Install Cuttlefish:

   - **npm** (after a published release): `npm install -g cuttlefish-cli`
   - **Windows** (source or release zip): `.\scripts\install.ps1 -FromSource -Force` or
     `.\scripts\install.ps1 -FromRelease -Force` from a clone / downloaded script
   - **Source** (all platforms, supported before npm publication): see the root
     README / `INSTALL.md`

4. Initialize the local Cuttlefish home (skipped automatically by `install.ps1` unless `-SkipSetup`):

```bash
cuttlefish setup
```

5. Start the gateway:

```bash
cuttlefish start
```

By default, the dashboard is served by the gateway at `http://localhost:8888`
unless the configured gateway port differs.

## Common Workflows

### Start And Stop

```bash
cuttlefish start
cuttlefish status
cuttlefish stop
cuttlefish restart
```

### Pair Another Browser

```bash
cuttlefish pair
cuttlefish unpair --json
```

From a source checkout, run JSON-producing commands with pnpm's quiet mode so
the script banner does not pollute stdout: `pnpm --silent cuttlefish unpair --json`.

### Instance Model

```bash
cuttlefish list
```

Cuttlefish supports one canonical instance name per active home. The supported
runtime home is `~/.cuttlefish` by default (or the same `CUTTLEFISH_HOME` used
by every lifecycle command) and the default dashboard port is `8888`. Repeated
restart requests coalesce while a detached restart is already in progress. The
inherited `create`, `remove`, and `nuke` surfaces are disabled or limited so
automation cannot silently create additional named instances.

### Manage Skills

```bash
cuttlefish skills find testing
cuttlefish skills add <package>
cuttlefish skills list
cuttlefish skills update
```

`skills add` detects skills already installed in the selected Cuttlefish
instance and reports that state without rerunning the global installer. If an
installer exits nonzero but the requested skill is discovered and recorded,
the command reports the successful final state and retains the installer detail.

### Use The Dashboard

Routes are defined in `packages/web/src/main.tsx`:

- `/`: primary chat workspace
- `/talk`: multi-agent talk sessions
- `/command`: Orchestration Command Center overview dashboard
- `/kanban`: department boards and ticket dispatch
- `/approvals`: human approval/checkpoint queue
- `/archive`: archived sessions
- `/orchestration`: orchestration operations
- `/cron`: scheduled jobs
- `/activity`: runtime log inspection; `/logs` redirects here
- `/limits`: usage/rate-limit visibility
- `/org`: organization and employee configuration
- `/settings`: gateway/engine/connector/email settings
- `/skills`: local skill browsing and management
- `/file`: file viewer

Unknown client paths redirect to `/` so stale deep links recover to the primary
chat workspace instead of leaving an empty dashboard shell.

## Configuration

Cuttlefish reads instance configuration from the active Cuttlefish home, normally
`~/.cuttlefish` or the path set by `CUTTLEFISH_HOME`. Lifecycle commands and
`cuttlefish list` use that same active home.
Engine CLIs keep their own authentication state. Cuttlefish does not replace engine
sign-in flows; run each engine once and authenticate before routing work to it.

### Changing a chat model

The chat composer applies an explicit model or effort selection to the next
queued turn, including when continuing the reusable HR / Org Steward chat.
That HR singleton retains its engine and working directory; start a non-HR chat
when either of those needs to change.

The default COO lane uses Claude Fable 5 at Medium effort. On a configured
automatic fallback, it continues with Claude Opus 4.8 at Max effort; an
employee-specific fallback policy takes precedence for that employee.

### Email inboxes

- Operators can configure up to 3 IMAP inboxes in `/settings`.
- Cuttlefish polls configured inboxes, caches normalized messages plus
  attachments, and can auto-ingest new mail into COO-owned sessions.
- Email is inbound-only in this version. It does not send or reply to email.

### Twilio SMS

Twilio SMS can create or continue a session from an allowlisted phone number
and return the completed response by SMS. Follow [the Twilio SMS setup guide](TWILIO_SMS.md)
to configure credentials, an SMS-capable sender, and the signed inbound webhook.

## Persistence And Files

- Sessions, messages, registry data, queue state, files, archives, approvals, and
  orchestration state are persisted in the active Cuttlefish home.
- Uploaded files are managed by the gateway files API and protected by managed
  storage/read policies.
- Local audit/session/Giles/runtime artifacts in the source checkout are not part
  of runtime persistence and are ignored by Git.

## Error Handling And Recovery

- `cuttlefish status` reports daemon state and useful gateway details.
- Rate-limit and engine-unavailable paths are handled through session metadata and
  configured fallback behavior where supported.
- Orchestration recovery manifests are operator-reviewed; recovery requeue leaves
  work paused until explicitly resumed.
- File reads and downloads are constrained to allowed roots and managed paths.

## Troubleshooting

| Symptom | Likely Cause | Next Step |
|---|---|---|
| Engine not available | CLI missing or not signed in | Run the engine binary directly and authenticate. |
| Dashboard unreachable | Gateway not running or different port | Run `cuttlefish status`; check `gateway.port`. |
| Claude sessions cannot reach models | Claude CLI not logged in | Run `claude`, use `/login`, then restart Cuttlefish. |
| Hermes hidden or failing | `hermes` not on `PATH` or provider credentials missing | See `docs/engines-hermes.md`. |
| Orchestration controls disabled | Runtime disabled or unavailable | Check `orchestration.enabled` and `/orchestration` status. |

## Known Limitations

- Hermes is metered by its configured provider, unlike subscription-wrapped engines.
- Kiro credit usage is an estimate; see `docs/known-diagnostics.md`.
- Historical plan/spec docs may describe earlier intended designs and should not
  override current source, tests, README, or feature inventory.
- E2E Playwright tests were not run in the 2026-06-25 documentation stewardship pass.

## See Also

- `docs/ARCHITECTURE.md`
- `docs/SPECIFICATION.md`
- `docs/IMPLEMENTATION_DIAGRAMS.md`
- `docs/TEST_LEDGER.md`
- `docs/feature_inventory.md`
