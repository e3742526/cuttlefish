# 01 — First Run and Daemon Lifecycle

The gateway daemon is the substrate for everything else. These scenarios
confirm a new operator can get from a fresh checkout to a working dashboard,
and that the daemon lifecycle (start/stop/restart/status, port conflicts,
relaunch persistence) behaves. Run these first; every later file assumes a
running gateway.

All scenarios use a disposable Cuttlefish home. Where a scenario says
"fresh home", delete/point away from any prior test home before starting.

---

### LC-01 — Fresh install to first dashboard load (primary happy path)
- Goal: a brand-new operator follows only the README quickstart and reaches a usable dashboard.
- Category: happy path / first launch
- Preconditions: fresh clone, Node 24.x, pnpm 10+, one signed-in engine CLI, fresh home.
- Steps:
  1. `pnpm install`
  2. `pnpm setup` — watch output for engine probing and home initialization.
  3. `pnpm cuttlefish start`
  4. Open `http://localhost:8888` (or confirm the auto-open landed there).
- Expected: setup reports the detected engines; start reports success and the dashboard URL; the chat workspace at `/` loads with a sensible empty state (no raw errors, no spinner that never resolves).
- Observe: does setup's output tell the operator what to do next? Is the signed-in engine actually listed in the dashboard's engine picker? Are engines whose binary is missing hidden (not shown broken)?
- Variations: run `pnpm setup` a second time (idempotency — must not clobber the initialized home); run with **zero** engines installed and confirm the failure message explains the "install + sign in an engine" prerequisite rather than failing obscurely.

### LC-02 — First-launch empty states across all routes
- Goal: see what a new user sees before any data exists.
- Category: empty state / navigation
- Preconditions: LC-01 completed, no sessions/tickets/cron jobs created yet.
- Steps: visit every route in turn: `/`, `/command`, `/talk`, `/kanban`, `/approvals`, `/archive`, `/activity`, `/orchestration`, `/cron`, `/limits`, `/org`, `/settings`, `/skills`, `/file`.
- Expected: each route renders an intentional empty state (e.g. the `/limits` empty state is an implemented feature) — no blank white screens, unhandled exceptions, infinite loaders, or developer placeholder text.
- Observe: redirects work (`/chat` → `/`, `/logs` → `/activity`); an unknown route (e.g. `/redesign`, `/nonsense`) lands somewhere sane, not a broken shell.
- Variations: hard-refresh (F5) on each deep route — client-side routes must survive direct load, not only in-app navigation.

### LC-03 — `--version` is not signed in (documented gotcha)
- Goal: reproduce the README's "most common fresh-install gotcha" and judge whether the failure is legible.
- Category: recovery / error clarity
- Preconditions: an engine CLI installed but **not** authenticated (e.g. `claude` never `/login`-ed), fresh home.
- Steps:
  1. `pnpm setup && pnpm cuttlefish start`
  2. Start a chat session routed to the unauthenticated engine; send a message.
- Expected: the session fails with a user-visible explanation pointing at engine sign-in (per the troubleshooting table: "run `claude`, use `/login`, then restart"), not a silent hang or a generic error.
- Observe: does the session end up in a clear failed/crashed status (the agent-process-crash status surface) or does it look forever "running"? Is the fix discoverable from the dashboard alone?

### LC-04 — Stop, restart, status honesty
- Goal: lifecycle commands report and change state truthfully.
- Category: happy path / recovery
- Preconditions: gateway running.
- Steps:
  1. `pnpm cuttlefish status` — confirm it says running with correct port/details.
  2. `pnpm cuttlefish stop`; re-run `status` — must say stopped; dashboard must be unreachable.
  3. `pnpm cuttlefish start`; confirm dashboard is back.
  4. `pnpm cuttlefish restart`; confirm one clean bounce (no orphan process, no double daemon).
- Expected: every command's exit code and message match reality; no stale PID/lock file confusion.
- Variations: `stop` when already stopped and `start` when already started — expect polite no-ops or clear "already running/stopped" messages, not stack traces. Run `restart` from *inside* an active session's terminal (the README claims detached restart works even from inside a session).

### LC-05 — Kill the daemon mid-session, then relaunch (crash recovery)
- Goal: simulate a crash/power-loss and verify state survives.
- Category: interruption / persistence / recovery
- Preconditions: gateway running; one chat session mid-conversation with at least two exchanges.
- Steps:
  1. Kill the gateway process ungracefully (`kill -9` the daemon PID).
  2. Confirm `status` detects the dead daemon (not a stale "running").
  3. `pnpm cuttlefish start`.
  4. Reopen the dashboard and the prior session.
- Expected: the session and its message history are intact; a session that was mid-run is shown in an honest terminal state (stopped/crashed), not perpetually "streaming".
- Observe: does the open browser tab recover on its own (reconnect) or require refresh? Either is acceptable if the UI signals the disconnect; a frozen UI silently pretending to be live is a finding.

### LC-06 — Port conflict and unreachable dashboard
- Goal: legible failure when the configured port is taken.
- Category: invalid environment / error clarity
- Preconditions: gateway stopped; another process bound to the gateway port (e.g. `python3 -m http.server 8888`).
- Steps: `pnpm cuttlefish start`; read the output; run `status`.
- Expected: start fails (or picks an alternative only if that's designed behavior) with an error naming the port and the remedy; `status` does not claim Cuttlefish is serving a port another process owns.
- Variations: set a non-default `gateway.port` in config, restart, and confirm both the CLI messages and the dashboard auto-open track the new port.

### LC-07 — Single-instance guardrails
- Goal: confirm the documented single-instance model holds up to a user poking at it.
- Category: boundary / settings
- Preconditions: gateway running.
- Steps:
  1. `pnpm cuttlefish list` — expect exactly the single supported instance.
  2. Attempt the disabled/limited inherited surfaces (`create`, `remove`, `nuke`) and read their responses.
  3. Run a second `pnpm cuttlefish start` from another terminal.
- Expected: disabled surfaces refuse with an explanation (not success, not a crash); a second start does not spawn a second daemon or corrupt the first.

### LC-08 — Config file edited by hand, then restart
- Goal: users edit `~/.cuttlefish/config.yaml` directly (the docs invite this); verify tolerance.
- Category: invalid input / boundary / recovery
- Preconditions: gateway stopped; back up the disposable home's config first.
- Steps:
  1. Make a benign valid edit (e.g. change a model display label); start; confirm the edit is reflected in the picker.
  2. Stop; introduce a YAML syntax error (bad indent); start.
  3. Restore valid YAML but with an unknown key and a wrong-typed value (string where number expected); start.
- Expected: valid edits take effect; broken YAML produces a startup error naming the file and problem (not a default-config silently overwriting the user's file, and not an opaque crash); unknown/wrong-typed keys are ignored or reported, never state-corrupting.
- Observe: is the user's broken file preserved for them to fix, or destroyed?
