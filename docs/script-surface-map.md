# Script Surface Classification Map

This document is the authoritative in-repo classification of npm scripts and CLI
subcommands for deterministic automation sweeps, CI probe selection, and any
external surface-metadata generators. It supersedes any generated classification
that conflicts with the evidence recorded here.

Last updated: 2026-06-24

## Classification Key

| Field | Values |
| --- | --- |
| `destructive` | `true` — permanently deletes data or directories; `false` — no deletions |
| `mutates_state` | `true` — writes, modifies, or removes files/registry/process state; `false` — read-only |
| `interactive` | `true` — may block on stdin or require TTY confirmation; `false` — fully non-interactive |
| `bounded` | `true` — terminates deterministically; `false` — runs until interrupted (watch/daemon mode) |
| `posix_only` | `true` — uses shell syntax not portable to bare Windows cmd/PowerShell |
| `automated_probe_default` | `include` — safe for unattended sweeps; `exclude` — must never run in sweeps; `conditional` — safe only with explicit preconditions documented below |

---

## Root `package.json` Scripts

### `setup` — Initialize Cuttlefish home

```
pnpm build && node packages/cuttlefish/dist/bin/cuttlefish.js setup
```

| Field | Value |
| --- | --- |
| destructive | false (no-op if home already exists) |
| mutates_state | true (creates `~/.cuttlefish` and writes config/db/dirs) |
| interactive | true on fresh install with a TTY (engine selection prompt) |
| bounded | true |
| posix_only | false |
| automated_probe_default | **conditional** — safe only when `CUTTLEFISH_HOME` points to an isolated temp directory and no interactive TTY is expected |

### `setup:force` — Re-initialize Cuttlefish home, deleting existing data

```
pnpm build && node packages/cuttlefish/dist/bin/cuttlefish.js setup --force
```

| Field | Value |
| --- | --- |
| destructive | **true** — calls `fs.rmSync(safeHome, { recursive: true, force: true })` before reinitializing |
| mutates_state | **true** |
| interactive | false (force flag bypasses prompts) |
| bounded | true |
| posix_only | false |
| automated_probe_default | **exclude** — deletes the active Cuttlefish home; must never run in unattended sweeps without an isolated `CUTTLEFISH_HOME` |

Evidence: `packages/cuttlefish/src/cli/setup.ts` `runSetup({ force: true })` resolves the home through `assertSafeDestructiveHome` and removes it before continuing.

### `nuke` — Disabled for the canonical Cuttlefish instance

```
node packages/cuttlefish/dist/bin/cuttlefish.js nuke
```

| Field | Value |
| --- | --- |
| destructive | false for the supported single-instance model |
| mutates_state | false unless legacy non-canonical registry entries already exist |
| interactive | false for the supported single-instance model |
| bounded | true |
| posix_only | false |
| automated_probe_default | **exclude** — permanently destructive and gated on operator confirmation; never include in automated sweeps |

Evidence: `packages/cuttlefish/src/cli/nuke.ts` refuses the default `cuttlefish` instance; non-canonical instance homes are rejected by `homeForInstance`.

### `start` — Clean build and start the gateway daemon

```
pnpm clean && pnpm build && node packages/cuttlefish/dist/bin/cuttlefish.js start
```

| Field | Value |
| --- | --- |
| destructive | false |
| mutates_state | true (starts a long-running daemon process; writes PID/socket state) |
| interactive | false |
| bounded | false (daemon; runs until `stop`) |
| posix_only | false |
| automated_probe_default | **exclude** — unbounded daemon; starts a background process |

### `stop` — Stop the gateway daemon

```
node packages/cuttlefish/dist/bin/cuttlefish.js stop
```

| Field | Value |
| --- | --- |
| destructive | false |
| mutates_state | true (sends SIGTERM to running daemon) |
| interactive | false |
| bounded | true |
| posix_only | false |
| automated_probe_default | **conditional** — safe in isolation; requires a running daemon to be meaningful |

### `status` — Show gateway status (read-only)

```
node packages/cuttlefish/dist/bin/cuttlefish.js status
```

| Field | Value |
| --- | --- |
| destructive | false |
| mutates_state | false |
| interactive | false |
| bounded | true |
| posix_only | false |
| automated_probe_default | **include** — read-only, deterministic, non-destructive |

### `build` — Compile TypeScript and copy web output

```
turbo build && rm -rf packages/cuttlefish/dist/web && cp -r packages/web/out packages/cuttlefish/dist/web
```

| Field | Value |
| --- | --- |
| destructive | false (removes generated output only, not source) |
| mutates_state | true (writes `dist/`) |
| interactive | false |
| bounded | true |
| posix_only | **true** — uses `rm -rf` and `cp -r` in the postbuild step |
| automated_probe_default | **conditional** — safe in CI; POSIX-shell dependency limits cross-platform use |

### `test` — Run all package test suites (bounded)

```
turbo run test
```

| Field | Value |
| --- | --- |
| destructive | false |
| mutates_state | false |
| interactive | false |
| bounded | true |
| posix_only | false |
| automated_probe_default | **include** — canonical deterministic validation surface |

### `typecheck` — Static type-check all packages

```
turbo typecheck
```

| Field | Value |
| --- | --- |
| destructive | false |
| mutates_state | false |
| interactive | false |
| bounded | true |
| posix_only | false |
| automated_probe_default | **include** |

### `lint` — Run linter across all packages

```
turbo lint
```

| Field | Value |
| --- | --- |
| destructive | false |
| mutates_state | false |
| interactive | false |
| bounded | true |
| posix_only | false |
| automated_probe_default | **include** |

### `coverage` — Run tests and write coverage reports

```
turbo run coverage
```

| Field | Value |
| --- | --- |
| destructive | false |
| mutates_state | **true** — writes HTML/JSON/text reports to `packages/cuttlefish/coverage/` |
| interactive | false |
| bounded | true |
| posix_only | false |
| automated_probe_default | **conditional** — bounded and deterministic; include only when coverage artifacts are needed, as it writes output files |

### `cuttlefish` (dispatcher) — Root alias for the built CLI binary

```
node packages/cuttlefish/dist/bin/cuttlefish.js
```

| Field | Value |
| --- | --- |
| automated_probe_default | **exclude** — this is a subcommand dispatcher, not an atomic surface; classify and probe child subcommands individually (see CLI Subcommand Classification below) |

---

## `packages/cuttlefish` Scripts

### `test` — Run unit tests (bounded)

```
vitest run
```

| automated_probe_default | **include** |

### `test:watch` — Run tests in watch/interactive mode

```
vitest
```

| Field | Value |
| --- | --- |
| interactive | **true** — Vitest watch mode blocks waiting for file changes and keystroke commands |
| bounded | **false** |
| automated_probe_default | **exclude** — watch mode; unbounded and interactive |

### `coverage` — Run tests with coverage output

```
vitest run --coverage
```

| Field | Value |
| --- | --- |
| mutates_state | **true** — writes to `coverage/` (configured in `vitest.config.ts` `reportsDirectory`) |
| bounded | true |
| automated_probe_default | **conditional** — same as root `coverage` |

### `build` — Compile TypeScript

```
rm -rf dist && tsc -p tsconfig.build.json && ...
```

| posix_only | **true** — uses `rm -rf` |
| automated_probe_default | **conditional** — safe in POSIX/CI; not portable to bare Windows shell |

### `clean` — Remove compiled output

```
rm -rf dist
```

| Field | Value |
| --- | --- |
| destructive | false (removes generated artifacts only) |
| mutates_state | true |
| posix_only | **true** |
| automated_probe_default | **exclude** unless cleanup is the explicit probe target |

---

## `packages/web` Scripts

### `test` — Run unit tests (bounded)

```
vitest run
```

| automated_probe_default | **include** |

### `test:watch` — Run tests in watch/interactive mode

```
vitest
```

| Field | Value |
| --- | --- |
| interactive | **true** |
| bounded | **false** |
| automated_probe_default | **exclude** |

### `clean` — Remove generated web output (cross-platform)

```
node -e "const{rmSync}=require('node:fs');['out','dist'].forEach(d=>rmSync(d,{recursive:true,force:true}))"
```

| Field | Value |
| --- | --- |
| destructive | false (removes generated artifacts only) |
| mutates_state | true |
| posix_only | false — replaced with a Node.js cross-platform command (previously `rm -rf out dist`) |
| automated_probe_default | **exclude** unless cleanup is the explicit probe target |

---

## CLI Subcommand Classification

The `cuttlefish` CLI dispatcher (`packages/cuttlefish/bin/cuttlefish.ts`) registers a family of
subcommands with distinct risk profiles. Treat each separately; never probe `cuttlefish`
without a subcommand.

### Read-only / observational (safe to include in sweeps with a running instance)

| Subcommand | Notes |
| --- | --- |
| `cuttlefish status` | Shows daemon status; no mutations |
| `cuttlefish list` | Lists the canonical Cuttlefish instance for the active `CUTTLEFISH_HOME`; no mutations except refreshing/backfilling the legacy registry entry |
| `cuttlefish limits` | Shows engine rate limits; no mutations |
| `cuttlefish workers list` | Inert worker config inspection |
| `cuttlefish leases list` | Observe orchestration leases |
| `cuttlefish queue list` | Observe task queue |
| `cuttlefish holds list` | List active holds |
| `cuttlefish artifacts view` | View raw orchestration artifacts |
| `cuttlefish continuations list` | List durable continuations |
| `cuttlefish scheduler allocate\|plan\|simulate\|stats` | Dry-run only; no live mutations |
| `cuttlefish migrate --check` | Check-only migration scan; no writes |

### Process-mutating (bounded, non-destructive to data)

| Subcommand | Notes |
| --- | --- |
| `cuttlefish start` | Starts daemon process |
| `cuttlefish stop` | Sends SIGTERM to daemon |
| `cuttlefish restart` | Requests a detached stop/start handoff; concurrent requests coalesce behind the restart lock |
| `cuttlefish startup enable\|disable` | Manages systemd user service |

### Data-mutating (registry, config, or skill state)

| Subcommand | Notes |
| --- | --- |
| `cuttlefish create <name>` | Disabled; exits with a single-instance error |
| `cuttlefish remove <name>` | Legacy cleanup only; cannot remove the canonical `cuttlefish` instance |
| `cuttlefish remove <name> --force` | Legacy cleanup only; non-canonical homes are rejected by the managed-home guard |
| `cuttlefish migrate --auto` | Applies pending template migrations; writes files |
| `cuttlefish skills add\|remove\|update\|restore` | Mutates the skills registry |
| `cuttlefish queue pause-task\|resume-task` | Mutates queue state |
| `cuttlefish holds create\|extend\|cancel` | Mutates TTL-bounded holds |

### Destructive (exclude from all automated sweeps)

| Subcommand | Notes |
| --- | --- |
| `cuttlefish setup --force` | Deletes `CUTTLEFISH_HOME` before reinitializing |
| `cuttlefish nuke [name]` | Legacy cleanup only; cannot delete the canonical `cuttlefish` instance |

---

## Deterministic Sweep Allowlist

Automated sweeps and deterministic validation probes should be restricted to the
following surfaces unless an explicit exception is documented:

```
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter cuttlefish typecheck
pnpm --filter cuttlefish lint
pnpm --filter cuttlefish exec vitest run
pnpm --filter @cuttlefish/web typecheck
pnpm --filter @cuttlefish/web lint
pnpm --filter @cuttlefish/web exec vitest run
```

For CLI probes, restrict to read-only subcommands listed above and only when a
running Cuttlefish instance is known to be available in a safe test environment.

---

## Positive Controls

The following safety guards are already in place for destructive operations:

- `assertSafeDestructiveHome` (`packages/cuttlefish/src/cli/instances.ts`) rejects
  filesystem root, the user's home directory, the current working directory, and
  symlinks before any `rmSync` call.
- `assertSafeManagedInstanceHome` validates that only the canonical `cuttlefish`
  instance home is accepted for managed destructive cleanup.
- `nuke` refuses to delete the default `cuttlefish` instance.

These guards protect against accidental destructive execution but do not make the
commands safe for unattended automated sweeps.

---

## Residual Risks and Open Items

- The `build` script at both root and `packages/cuttlefish` still uses POSIX `rm -rf`;
  if Windows becomes a supported execution environment these should also be replaced
  with cross-platform Node.js equivalents.
- `packages/cuttlefish` `clean` also uses `rm -rf dist`; same portability caveat applies.
- Root `build` uses `rm -rf` and `cp -r` in the Turbo postbuild step.
- `test:e2e` (`playwright test`) has not been fully classified; it is bounded but
  may have network/filesystem side-effects depending on the test suite.
