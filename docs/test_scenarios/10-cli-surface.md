# 10 — CLI Surface Robustness

Lifecycle commands are covered in file 01 and pairing in file 09; this file
covers the rest of the `cuttlefish` CLI as a product surface: help output,
JSON modes, bad arguments, and behavior when the daemon is down. A CLI that
panics on a typo fails the same user a broken button fails.

Run from a source checkout (`pnpm cuttlefish …`) and, if a packaged install
is available on the test machine, spot-check the same commands via the
installed binary — drift between the two is a finding. For a `--json` command,
use `pnpm --silent cuttlefish … --json` so pnpm's script banner does not share
stdout with the JSON payload.

---

### CL-01 — Help and discoverability
- Goal: a user can discover the CLI from the CLI.
- Category: happy path / navigation
- Preconditions: built source checkout; record both source-checkout and packaged binary versions when both are available.
- Steps:
  1. `cuttlefish` with no arguments; `cuttlefish --help`; `cuttlefish help`.
  2. `--help` on each subcommand surfaced by the top-level help (start, stop, restart, status, list, pair, unpair, skills, setup, and any others listed).
- Expected: every advertised command has help; help text matches actual behavior (spot-check two); exit code 0 for help, non-zero for errors.
- Variations: `cuttlefish skills` with no subcommand — usage message, not a crash.

### CL-02 — Unknown commands, typos, and bad flags
- Goal: misuse fails politely.
- Category: invalid input
- Preconditions: built source checkout; disposable active home.
- Steps:
  1. `cuttlefish strat` (typo) — unknown-command error, ideally a "did you mean start?" style hint; never a stack trace.
  2. `cuttlefish start --bogus-flag`; `cuttlefish status extraneous-arg`.
  3. `cuttlefish skills add` with no package argument.
  4. Empty-string and unicode arguments: `cuttlefish skills find ""`, `cuttlefish skills find "日本語"`.
- Expected: clear one-line errors with usage pointers; consistent non-zero exit codes; no partial side effects from failed invocations.

### CL-03 — JSON output contract
- Goal: `--json` modes (e.g. `unpair --json`) emit machine-parseable output.
- Category: boundary / files
- Preconditions: built source checkout; use `pnpm --silent` for source-checkout JSON commands; capture stdout and stderr separately.
- Steps:
  1. Run every command that documents a `--json` flag; pipe each through a JSON parser (`| node -e 'JSON.parse(require("fs").readFileSync(0))'`).
  2. Trigger an *error* under `--json` (e.g. unpair when nothing is paired) — the error should also be JSON, not prose polluting the stream.
- Expected: valid JSON on stdout, human noise (if any) on stderr; stable enough shape that a script could consume it.

### CL-04 — Commands while the daemon is down
- Goal: every non-lifecycle command degrades legibly without a gateway.
- Category: recovery / error clarity
- Preconditions: `cuttlefish stop` completed.
- Steps: run `status`, `list`, `pair`, `unpair`, and each `skills` subcommand against the stopped daemon.
- Expected: each either works offline by design or says plainly that the gateway isn't running and how to start it; nothing hangs waiting on a dead socket; exit codes reflect failure.
- Variations: daemon *starting but not yet ready* (race window right after `start`) — commands should wait briefly or report "starting", not flap between contradictory answers.

### CL-05 — Concurrent and repeated CLI invocations
- Goal: the CLI tolerates being scripted.
- Category: concurrency
- Preconditions: gateway running.
- Steps:
  1. Run `cuttlefish status` in a tight loop (20×) while the dashboard is in active use — consistent answers, no daemon disturbance.
  2. Fire `restart` and `status` simultaneously from two terminals.
  3. Run two `skills update` invocations concurrently.
- Expected: no deadlocks, no corrupted skill state, no lock-file residue that breaks the *next* invocation; concurrent restart+status resolves to a coherent story.

### CL-06 — Environment seams
- Goal: realistic environment problems produce named errors.
- Category: invalid environment / error clarity
- Preconditions: disposable homes for each variation; a version manager or container for the unsupported-Node branch.
- Steps:
  1. Run under an unsupported Node major (if easy to arrange via nvm) — expect the documented `>=24 <25` enforcement to speak up at the right moment, not a deep runtime error later.
  2. Point the Cuttlefish home at a read-only directory; run `setup` and `start` — permission errors must name the path.
  3. Run `setup` when the home already contains a *newer* schema than the binary understands (simulate by editing a version field, if one exists) — expect a refusal or migration message, not silent downgrade.
- Expected: every environment failure identifies itself; none corrupts the home.
