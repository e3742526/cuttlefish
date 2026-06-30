# Fork Readiness Checklist — Cuttlefish 2026-06-30

**Assessment date:** 2026-06-30
**Assessed by:** Automated cloud audit

---

## Readiness Score

| Dimension | Score |
|---|---|
| Overall fork readiness | **62 / 100** |
| Architecture portability | **68 / 100** |

**Summary:** The codebase is architecturally well-suited for forking. Runtime config is broadly externalized via a validated YAML schema, all filesystem paths derive from an overridable home directory, there is no phone-home telemetry, SQLite persistence is local and portable, the engine adapter model is genuinely pluggable, and the license is MIT with clear upstream attribution.

The primary obstacles are: (1) the product identity (`cuttlefish`, `~/.cuttlefish`, `cuttlefish-cli`) is deeply embedded in code — not just docs — including a hard assertion in `instance-home.ts` that rejects any other instance name at startup; (2) an active prefork-substrate campaign was merged just before this assessment, leaving the repo in a transitional state.

None of these are architectural dead-ends — they are all bounded, addressable tasks. With roughly one to two days of rename/cleanup work plus a decision on the WhatsApp connector, this codebase would be cleanly forkable at 85+.

---

## Blockers (must fix before fork)

These items must be resolved before cutting a meaningful fork. They are not cosmetic — they affect filesystem isolation, license compliance, or baseline stability.

1. **Product identity is deeply embedded.** The npm package name is `cuttlefish-cli`, the binary name is `cuttlefish`, and the instance home defaults to `~/.cuttlefish`. `instance-home.ts:8` contains a hard assertion that rejects any instance name other than the string `"cuttlefish"` at startup. This blocks filesystem isolation between the upstream and any fork.

2. **`@whiskeysockets/baileys` (WhatsApp connector) is MIT-licensed** — no license encumbrance for proprietary forks. The remaining concern is it is pinned to an RC (`7.0.0-rc13`); track stable 7.x release before the fork ships.

3. **The prefork-substrate work is mid-campaign.** The most recent merge (`9af11d8`: "prefork-substrate stages 1B-7") was completed just before this assessment, but the README and governance files still reflect pre-hardening state. The fork baseline should not be cut mid-campaign.

---

## High Priority Pre-Fork Work

**Area: Hardcoded Identity**
Priority: HIGH

The npm package name is `cuttlefish-cli` (package.json line 2), the binary name is `cuttlefish` (line 11), the GitHub repository URL is hardcoded to `github.com/e3742526/cuttlefish` in both `package.json` and the Homebrew tap reference in README. The instance home is always `~/.cuttlefish` (`instance-home.ts` line 14) and the only allowed `CUTTLEFISH_INSTANCE` value is the string `"cuttlefish"` — any other value throws at startup (line 8). Auth cookies are named `cuttlefish_auth` and `cuttlefish_device` (`auth.ts` lines 25-26). All internal path symbols contain the word `cuttlefish`. The `server.ts` log line at boot names `Cuttlefish gateway`. The `package.json` description still calls out Claude Code, Codex, Grok, and Antigravity explicitly. These are numerous but well-centralized touchpoints.

**Recommendation:** Before forking: rename the package and binary in `package.json`; parameterize the instance home via `CANONICAL_INSTANCE_NAME`; update auth cookie names; update the GitHub repository/bugs URLs; do a repo-wide symbol rename for the product identity. The `portal.portalName` config key already provides a runtime display-name override, but the binary name and paths are still hardcoded.

---

## Medium Priority

**Area: Configuration Surface**

Runtime config is well-externalized via `config-schema.ts` (validated YAML at `~/.cuttlefish/config.yaml`). The schema covers gateway, engines, models, connectors, email, logging, MCP, orchestration, sessions, cron, notifications, portal, knowledge sinks, and more. Missing from the config surface: (1) no way to override the binary name or npm package name at runtime; (2) the instance home directory is only overridable via `CUTTLEFISH_HOME` env var, not in the YAML; (3) auth cookie names are not configurable; (4) the Homebrew tap and npm registry endpoints are hardcoded in README/setup docs.

**Recommendation:** For a fork: add a config key or env var to override the instance slug and home directory name without recompiling. Cookie names can stay internal. Document all env vars (`CUTTLEFISH_HOME`, `CUTTLEFISH_INSTANCE`, `CUTTLEFISH_INSTANCES_REGISTRY`) in a dedicated ops guide.

---

**Area: Engine Coupling**

The architecture is explicitly "a bus, not a brain" and this is well-implemented. Each engine has its own adapter file under `src/engines/` implementing a shared `Engine` interface. However, Claude gets privileged treatment: (a) PTY lifecycle pool sizing for all other engines defaults to `claudeCfg.maxLivePtys` (`server.ts` lines 212-241), exposing a deep Claude-as-primary assumption; (b) `CLAUDE_SETTINGS_DIR`, `CLAUDE_SKILLS_DIR`, `CLAUDE_LIMITS_DIR` are first-class named paths; (c) `seedTrust()` reads `~/.claude.json` specifically; (d) the hook-relay mechanism is Claude-Code-specific. Adding a new engine follows a clear extension pattern. Removing an engine requires touching `server.ts`, `config-schema.ts`, and any CLI help text.

**Recommendation:** For a fork that does not need Claude: the PTY pool sizing coupling is a minor refactor. Plan a small pass to decouple PTY pool config from the claude engine config block, and rename Claude-specific path constants if the fork drops Claude support.

---

**Area: Database Portability**

The project uses three separate SQLite databases (`better-sqlite3`): `sessions/registry.db` (WAL mode, foreign keys on), `orchestration.db` (WAL mode), and `run-ledger.db`/`artifact-lineage.db`. All paths resolve under `CUTTLEFISH_HOME` which is overridable via env var. WAL mode means forks of a live database will include `-wal` and `-shm` sidecar files. An in-tree schema migration system exists under `template/migrations/` with semver-versioned subdirectories. The migration system uses `version.ts` to detect and apply pending migrations — it reads the version from `config.yaml` and compares to the package version. A fork must reset the migration baseline or risk skipping applied migrations.

**Recommendation:** Before forking: (1) checkpoint all WAL files (`PRAGMA wal_checkpoint(TRUNCATE)`) so the fork starts clean; (2) reset `config.yaml` `cuttlefish.version` to `0.0.0` or to the fork's starting version; (3) decide whether to carry forward the existing migration history or start a fresh schema at the fork point. The migration runner is solid and should be reused.

---

**Area: Authentication Portability**

Auth is entirely self-contained: a random token is generated and stored in `~/.cuttlefish/gateway.json` on first boot. There are no external identity providers, no OAuth flows, no LDAP, no SSO. Remote access uses a pairing-code flow. The `gateway.userHeader` config key allows a reverse-proxy to pass a trusted user identity header. Auth cookie names (`cuttlefish_auth`, `cuttlefish_device`) are hardcoded constants. The current model is single-operator. REST API auth and multi-user roles are listed as not-yet-shipped in the Roadmap.

**Recommendation:** The auth system is fork-friendly as-is for single-operator use. For a fork needing multi-user or SSO: the `gateway.userHeader` hook is the intended seam, but it will need significant expansion. Rename the auth cookie constants when renaming the product.

---

## What's Already Fork-Ready

| Area | Status | Notes |
|---|---|---|
| Telemetry and logging | Ready | No phone-home telemetry, no third-party analytics SDK. Logging is local structured JSONL configurable in `config.yaml`. Knowledge sink webhook points anywhere the operator chooses — no default endpoint hardcoded. |
| Connector abstraction | Ready | Connectors (Slack, WhatsApp, email/IMAP) are well-modularized under `src/connectors/`. Credentials live in `config.yaml`. Removing unused connectors is straightforward. |
| Environment coupling | Ready with notes | `CUTTLEFISH_HOME` env var overrides home directory for containerized use. The `caffeinate` call is guarded by platform check. `docker-compose.yml` provides a containerization starting point. Node 24 is a hard ABI requirement — pin the same Node 24.x in any fork's container base image. |
| License | Ready | MIT licensed. Copyright line reads "Cuttlefish Contributors" with a note for upstream Jinn contributors. All runtime dependencies are permissively licensed — `@whiskeysockets/baileys` is MIT, not GPL-3.0 (verified via npm registry). No license blocker for proprietary or open-source forks. |
| Runtime config schema | Ready | Broadly externalized via validated YAML. Covers gateway, engines, models, connectors, email, logging, MCP, orchestration, sessions, cron, notifications, portal, knowledge sinks. |
| Engine adapter pattern | Ready | Clear extension pattern: add a file in `src/engines/`, register in `server.ts`, add config in `config-schema.ts`. Minor Claude-as-primary coupling in PTY pool sizing is addressable. |

---

## Recommended Fork Baseline Checklist (actionable items with checkboxes)

### Identity and naming
- [ ] Rename npm package (`package.json` `name`, `bin` key, `keywords`) and binary — affects install path and all documentation
- [ ] Replace `CANONICAL_INSTANCE_NAME` (`'cuttlefish'`) in `instance-home.ts` and `homeForInstance()` to allow a new home directory
- [ ] Update `CUTTLEFISH_HOME` default, `CUTTLEFISH_INSTANCES_REGISTRY` default, and all `CUTTLEFISH_*` env var names if rebranding fully
- [ ] Rename auth cookie constants `AUTH_COOKIE` and `AUTH_DEVICE_COOKIE` in `auth.ts`
- [ ] Update `package.json` `repository.url` and `bugs.url` from `github.com/e3742526/cuttlefish` to the fork's repo

### License and dependencies
- [ ] Track stable `@whiskeysockets/baileys` 7.x release (currently RC-pinned); assess WhatsApp TOS risk for fork's use case
- [ ] Audit and remove or document `@qdrant/js-client-rest` — no usage found in scanned source; either wire it up or drop it
- [ ] Retain Jinn contributor attribution in the `LICENSE` file per MIT requirements

### Database and migrations
- [ ] Checkpoint all SQLite WAL files before forking live data: `PRAGMA wal_checkpoint(TRUNCATE)` on `registry.db`, `orchestration.db`, `run-ledger.db`, `artifact-lineage.db`
- [ ] Reset `config.yaml` `cuttlefish.version` to `0.0.0` (or the fork's initial version) so the migration runner does not skip migrations
- [ ] Decide whether to carry the existing migration history or start a fresh schema at the fork point

### Engine and runtime decoupling
- [ ] Decouple PTY pool sizing from `claudeCfg.maxLivePtys` in `server.ts` — each engine's pool should read its own config key

### Codebase hygiene
- [ ] Remove or archive the repo-root scratch files: `explore-*.mjs`, `verify-fix*.mjs`, `scratchpad/`
- [ ] Investigate and resolve the `src/` and `tests/` directories at the monorepo root (unusual placement — may be leftover artifacts)
- [ ] Fix React UI test warnings so the fork starts with a green test baseline (noted in `ARCHITECTURE.md`)

### Documentation and ops
- [ ] Document the `CUTTLEFISH_HOME` / `CUTTLEFISH_INSTANCE` / `CUTTLEFISH_INSTANCES_REGISTRY` env vars in an operator guide if not already done
- [ ] Review `docs/UPSTREAM_DIFF_BASELINE.md` and update to reflect the fork's own lineage delta
