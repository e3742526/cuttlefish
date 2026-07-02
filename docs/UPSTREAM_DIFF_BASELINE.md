# Difference Report: Upstream Baseline to Cuttlefish

## Snapshot

- Date: 2026-07-01
- Lineage: Cuttlefish descends from `repo-makeover/jinn`, itself a fork of the original `hristo2612/jinn`. That foundation is credited in `README.md`, `LICENSE`, and the rebrand commit (`284aeaa`), which states the intent of the fork: keep Jinn's lightweight orchestration foundation while adding provenance and governance capabilities.
- Upstream commit: `7d47260f2055d1020fcce1b4546b64bc42d3296b` (`formula: bump to v0.23.3`). No `upstream` remote was available at refresh time; the comparison is against this recorded upstream fork-point commit, which is present in local history.
- Local commit compared: `92654391580834ec84289942d13596d35e0f84d0` (`refactor: update navigation links and improve Command Center UI components`)
- Relationship: local `main` is 125 commits ahead of the fork-point commit.
- File delta: 1,318 paths changed — 835 added, 180 modified, 39 deleted, 263 renamed (chiefly the `packages/jinn/` → `packages/cuttlefish/` rebrand), 1 type change.
- Line delta: 106,605 insertions and 25,199 deletions.

Commands used:

```bash
git rev-list --count 7d47260..HEAD
git diff --shortstat 7d47260..HEAD
git diff --name-status 7d47260..HEAD
git diff --dirstat=files,0 7d47260..HEAD
```

The counts above compare committed local `HEAD` to the fork-point commit. Working-tree changes are excluded.

## High-Level Difference Map

The largest deviations from the Jinn baseline follow the fork's stated motivation: capture traceability and provenance for everything the system runs and produces, and add explicit governance — while keeping the orchestration layer itself lightweight (SQLite stores, YAML policy, no heavyweight workflow engine).

| Area | Representative paths | Actual differences |
|---|---|---|
| Rebrand and package split | `packages/cuttlefish/**` (renamed from `packages/jinn/**`), `README.md`, `LICENSE` | Renames the runtime package from jinn to cuttlefish with explicit upstream credit retained; removes the old `packages/jinn/template/` scaffolding. |
| Run ledger (execution traceability) | `packages/cuttlefish/src/run-ledger/`, `run-ledger.db`, `packages/cuttlefish/src/orchestration/run-ledger-integration.ts` | Adds a canonical SQLite run ledger recording every run's state machine (`created` → `running`/`blocked`/`failed`/`interrupted`/`dead_lettered`/`completed`), run events, error records, parent-child spawn links, retry/replay links, artifact references, and policy snapshot references. Wired into the gateway server and orchestration runtime. |
| Artifact lineage (provenance capture) | `packages/cuttlefish/src/artifact-lineage/`, `artifact-lineage.db` | Adds a SQLite artifact registry with content hashes (sha256), locators, lineage edges (`parent`, `derived_from`, `version_of`, `source`), run-to-artifact cross-references, and quarantine records for suspect artifacts. |
| Policy engine and export gating | `packages/cuttlefish/src/policy/` | Adds a rule-based policy evaluator (glob-matched kind/locator rules, fail-closed on invalid rules) with gates for artifact registration and external emission (`gateExternalEmit`), loaded from a user policy directory with built-in defaults. |
| Governance surfaces | `governance/*.yaml`, `docs/DECISION_LOG.md`, `.giles/feature-ledger/`, `.github/workflows/governance.yml` | Adds tracked governance metadata: agent registry, policy, Giles ruleset, schema registry, repo manifest/config, exceptions, and logging schema; a decision log of dated, sourced architecture decisions; and tracked Giles feature-ledger entries documenting repair/feature campaigns (broader `.giles/` output stays local-only). |
| Knowledge sink/provider | `packages/cuttlefish/src/knowledge/` | Adds hashed, structured knowledge envelopes (session summaries, checkpoint decisions) with an outbox service and pluggable sinks/read providers (JSONL, webhook, noop) so run outcomes can be exported under policy control. |
| Orchestration | `packages/cuttlefish/src/orchestration/**`, `docs/orchestration/`, `orchestration/` | Adds provider-neutral orchestration: durable scheduler/store modules, worktree execution, cross-family reviewer policy, dual-lane competition with a human selection gate, recovery/requeue, telemetry, a `mid_pair` implementer→reviewer loop, and run-ledger integration. Example task/role/quota configs and per-agent instruction docs live under `docs/orchestration/`. |
| Gateway API and server modularization | `packages/cuttlefish/src/gateway/api/routes/**`, `packages/cuttlefish/src/gateway/server/**`, `packages/cuttlefish/src/gateway/files/**` | Splits large gateway files into route modules, server transport/static/connector helpers, and file upload/read/transfer/attachment modules with seam tests; adds approvals, orchestration, inspect, email, and command-status routes. |
| Session persistence | `packages/cuttlefish/src/sessions/registry/**`, `registry-archives.ts`, `registry-approvals.ts` | Converts the registry into a facade over core/schema/migrations/search/messages/queue/files modules; adds archives, approvals with enforced foreign keys to sessions, composite indexes, and schema columns for employee/model/engine session/last-error. |
| Engine handling | `packages/cuttlefish/src/engines/**`, `packages/cuttlefish/src/shared/engine-env.ts` | Extends engine support beyond the baseline to Kiro, Pi, Antigravity, Grok, Aider, Hermes (ACP/JSON-RPC), Kilo, and Ollama, with defensive Claude interactive PTY handling (transcript parsing, turn resolution, late recovery), secret-stripped child environments, and usage/credit tracking. |
| Email ingestion | `packages/cuttlefish/src/email/` | Adds an email inbox connector with fail-closed auto-ingest, sender allowlists, message size limits, normalization, storage, and session annotation. |
| Security hardening | `packages/cuttlefish/src/shared/ssrf-guard.ts`, `safe-write.ts`, `gateway/internal-auth.ts`, `manager-auth.ts` | Ports the jinn S1–S12 fixes (request guards, scoped tokens, allowlists, env sanitization) and closes the SEC-CF-001/002 confused-deputy and remote-image-exfiltration findings; adds process-liveness probing before destructive operations and a security-review flow for risky Bash commands. |
| Org governance | `packages/cuttlefish/src/gateway/org*`, `org/` | Adds hierarchy resolution (`reportsTo`, ranks, services), an HR Manager / Org Steward role for org-change governance, manager-scoped employee updates, multi-role execution profiles, and cross-engine fallback model selection. |
| Dashboard UI | `packages/web/src/routes/**`, `packages/web/src/components/**` | Adds a Command Center dashboard (`routes/command/`), approvals, archive, orchestration, activity-log, and limits pages; theme management including a `cuttlefish` theme; drag-and-drop navigation ordering; richer Kanban ticket detail with ticket IDs; room grouping; and aquatic/nautical avatar packs. |
| Connectors | `packages/cuttlefish/src/connectors/**` | Removes upstream Discord and Telegram connectors in favor of Slack, WhatsApp, and a generic notifications connector with validated references. |
| Optional vector store | `packages/cuttlefish/src/shared/qdrant.ts`, `docs/QDRANT_SETUP.md` | Adds optional Qdrant vector-database client support with setup documentation. |
| Tests | `packages/cuttlefish/src/**/__tests__/**`, `packages/web/src/**/__tests__/**`, `e2e/` | Broad coverage for the run ledger, artifact lineage, policy, knowledge, orchestration, gateway routes/files/auth, registry/archives/approvals, email, engines, and web pages. |
| Documentation | `docs/INDEX.md`, `docs/ARCHITECTURE.md`, `docs/orchestration/README.md`, `docs/cloud-audit/`, `docs/feature_inventory.md`, `docs/script-surface-map.md` | Adds a documentation index, orchestration manual, pre-fork cloud-audit baseline, feature inventory, script-surface safety map, and dated audit/repair campaign records. |

## Notable Behavioral Changes

- Every orchestrated run can now be traced end to end: the run ledger records canonical state transitions, errors, and parent-child spawn links, and the artifact-lineage store ties produced artifacts (with content hashes) back to the runs that made them.
- External emission of artifacts and knowledge is policy-gated: user rules plus fail-closed built-in defaults decide what may be registered, retained, or exported, and quarantine records exist for suspect artifacts.
- Board/ticket dispatch can route through the orchestration scheduler (when `orchestration.enabled`), including worktree-isolated implementation lanes, cross-family review, dual-lane competition with human winner selection, and an implementer→reviewer (`mid_pair`) loop.
- Session data handling expanded to include archives, approvals (with enforced foreign keys and cleanup on session deletion), partial messages, prompt excerpts, queue pause/replay, and registry search.
- Email can flow into sessions via fail-closed auto-ingest with sender allowlists; connector reply-delivery failures are logged rather than dropped.
- Engine execution is more defensive around interactive PTY behavior, late turn recovery, model-alias resolution against the registry, rate-limit fallback reversion, and child-environment secret redaction.
- The web app gained operator control surfaces (Command Center, approvals, orchestration, activity logs, limits) and theme management, with several audit/playtest defect-repair rounds recorded in the Giles feature ledger.

## Notable Tooling and Contribution Changes

- Repo tooling targets Node.js 24.x (with `engine-strict` relaxed in `.npmrc` for Node 22 remote environments); pnpm runtime pinning lives in `.pnpmrc`.
- Linting is an explicit repo/package validation surface; root `pnpm test` runs turbo tests with `--concurrency=1`.
- Governance CI exists (`.github/workflows/governance.yml`) but Giles rules are advisory today — `giles repo-check` only runs when a `giles` binary is present on the runner, as documented in `governance/policy.yaml`.
- Architecture decisions are recorded in `docs/DECISION_LOG.md` with dated IDs, rationale, alternatives, and sources; feature/repair campaigns are recorded in tracked `.giles/feature-ledger/` entries.
- `actions/checkout` bumped to 7.0.0 via Dependabot; release/skills tooling lives under `.claude/skills/`.

## Public Repo Caveats

- Some retained planning documents under `docs/plans/` and `docs/superpowers/` are historical and may describe earlier architecture assumptions. Current behavior should be taken from `README.md`, `docs/INDEX.md`, `docs/USER_MANUAL.md`, `docs/ARCHITECTURE.md`, `docs/SPECIFICATION.md`, and source/tests.
- Local-only artifacts such as generated `.giles/` output (other than the force-tracked `feature-ledger/`), `docs/audits/`, `docs/logs/`, top-level `logs/`, `governance/logs/`, and `state/` remain intentionally ignored by the repo contract.
- The runtime databases (`run-ledger.db`, `artifact-lineage.db`, session registry) are created under the user's Cuttlefish home at runtime; only their schemas and stores are in the repo.
- This report is a documentation summary of the committed diff against the recorded fork-point commit. For exact path-level review, run the commands in the snapshot section.
