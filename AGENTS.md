# Agent Execution Contract

This file is the canonical repo-wide instruction contract for coding, audit,
documentation, and maintenance agents. Model-specific files such as `CLAUDE.md`,
`GEMINI.md`, `CODEX.md`, or `.github/copilot-instructions.md` may add tool-specific
preferences, but they must not redefine, duplicate, or weaken this contract — they
should be thin pointers back to `AGENTS.md`.

<!-- fleet-tiering-core -->
## Normative Core (staged loading)

This section is front-loaded so that a provider which truncates long
instruction files still receives the binding rules. Some tools cap how much
of an instruction file they load (a Codex-style `project_doc_max_bytes`
defaults to 32 KiB, and global instructions count toward that cap); any rule
past that cap is invisible to such a provider. Everything below this section
elaborates these rules — later sections **must not weaken** the core.

### Precedence
1. Explicit task instructions from the operator.
2. This Normative Core and the repo-required sections below.
3. Later sections of this file (elaboration).
4. Adapter files (`CLAUDE.md`, `GEMINI.md`, …) — provider-specific execution
   preferences only; they never override this file. On conflict, `AGENTS.md`
   wins.

### Binding rules (MUST / MUST NOT)
- **Inspect before modifying.** Read existing code, tests, docs, and
  conventions first. Do not invent APIs, imports, paths, or commands.
- **Smallest coherent change.** One coherent task per run; MUST NOT bundle
  unrelated changes or widen scope silently — disclose adjacent edits.
- **No fake success.** MUST NOT present stubs/placeholders/canned responses
  as working, or suppress errors to make tests/logs look clean.
- **Validate and report honestly.** Run the relevant checks before declaring
  completion; state exactly what passed, failed, or was not run.
- **Preserve user work.** MUST NOT delete/overwrite existing work or revert
  changes without explicit instruction.
- **Artifact placement.** Durable audit summaries → `docs/audits/`;
  human-authored session/handoff logs → `docs/logs/session/<MMYYYY>/`
  (NOT the repo root or top-level `logs/`, which is for generated telemetry
  and raw evidence). Generated compliance artifacts stay under their
  generator's output path.
- **Documentation is source-grounded.** MUST NOT invent behavior; update
  user-facing docs when externally visible behavior changes.

### Staged instruction loading
- **Always (this core):** every provider that loads `AGENTS.md` receives it.
- **By location (nested `AGENTS.md`):** subtrees with their own `AGENTS.md`
  (e.g. `docs/`, `logs/`) carry local placement rules and defer to this root.
  Codex loads them automatically when editing that subtree; other tools open
  them when the task touches it.
- **Byte-capped providers:** set `project_doc_max_bytes` high enough to load
  this whole file; if you cannot, treat this Normative Core as authoritative
  and open later sections explicitly. Non-capped providers (e.g. Claude Code)
  load the full file and are unaffected.

For repo-specific detail — architecture, commands, governance, and the full
rules — read the sections that follow this one.
<!-- / fleet-tiering-core -->

## Repository Contract

Cuttlefish is a lightweight AI gateway daemon that orchestrates professional AI coding
CLIs (Claude Code, Codex, Antigravity). It is a **pnpm + Turborepo TypeScript
monorepo**. It declares `family: application`, `repo_type: service`,
`repo_profile: service_backend` in `governance/repo_config.yaml`.

- Packages: `packages/cuttlefish` (core gateway daemon + CLI, published as `cuttlefish-cli`)
  and `packages/web` (Vite + React dashboard served by the daemon).
- Canonical control surfaces: `AGENTS.md`, `governance/`, `schemas/`,
  `control/`, and `docs/`.
- Purpose: wrap battle-tested engine CLIs behind one daemon and add only routing,
  scheduling, connectors, and the org system — "a bus, not a brain".
- Allowed automation behavior: inspect all repo files; propose or apply scoped
  changes; update governance/compliance records when explicitly instructed.
- Prohibited automation behavior: weakening baseline agent/governance rules,
  silently widening scope, adding fake feature behavior, breaking the Claude
  subscription / interactive-PTY billing path (see README "How the Claude engine
  works"), or committing secrets / `~/.cuttlefish` runtime state.


<!-- GILES:FEATURE-LEDGER:START -->
## Giles feature ledger requirement

Before making implementation, refactor, config, test, or documentation changes, identify the active feature or task.

For each feature-level change, append or update the repo-local Giles feature ledger under:

`.giles/feature-ledger/`

Each ledger entry must record:

- feature id
- short action summary
- touched files
- validation run
- remaining open items
- provenance

Do not claim completion unless the ledger and validation results are updated.
Do not overwrite prior ledger entries.
If reconstructing history from archive/session/audit logs, mark provenance as reconstructed or inferred.
<!-- GILES:FEATURE-LEDGER:END -->
<!-- GILES:DOCS-GOVERNANCE:START -->
## Giles Compliance

- README.md and docs/INDEX.md are required read-order surfaces for repository
  orientation.
- Mermaid diagrams must follow `docs/agent/mermaid-diagram-guidance.md`.
- Documentation patch rules: documentation must be source-grounded; no invented
  or fabricated facts, claims, or docs; verify before writing.
- Treat `.giles/*.yaml` as advisory/discovery-only until validated by a fresh
  Giles scan.
- `.giles` artifacts are local advisory sidecar outputs that may not be
  available without Giles. Canonical compliance data lives under
  `governance/logs/`, while governing repo policy lives under `governance/`,
  `docs/`, and this `AGENTS.md` contract.
- Agents record evidence and do not declare compliance. Only Giles writes or
  refreshes canonical compliance status, and agents must report residual risks,
  skipped checks, and validation failures plainly.
- Cloud/remote agents or agents without local Giles/Dory access may ignore Giles
  and Dory requirements; those requirements are waived when the tools are
  unavailable, and the agent should continue with the repo contract plus visible
  disclosure.
- orchestrator/router file contract: router files are allowed to grow in number
  of registrations, but not in domain behavior.
- Orchestrator/router file contract: orchestrator/router files may only
  register routes/commands, parse shallow adapter inputs, call domain services,
  sequence high-level workflow steps, and translate service outputs. They must
  not host business rules, persistence mutation, validation algorithms,
  lifecycle/state machines, dedup/merge/repair logic, or archive/file parsing;
  new non-routing behavior belongs in focused domain modules.
<!-- GILES:DOCS-GOVERNANCE:END -->

## Agent Operating Rules

- One task per run; run validation before done.
- Agents must read `AGENTS.md` first.
- Read existing code before edits; prefer minimal, focused diffs over rewrites.
- One coherent task per run; if scope expands, document and justify it.
- Run validation before declaring completion; if partial, say so with residual risks.
- Do not delete or overwrite user work; preserve existing behavior unless the task
  requires a change.
- No fake success, stubbed completion, invented APIs/imports/paths, or hidden errors.
- Do not edit out-of-scope or frozen paths (`control/**`, `governance/**`) unless the
  task explicitly requires it and authority allows.

## Documentation Rules

- Keep `docs/INDEX.md` aligned with new or renamed operator-facing docs and the
  current month's log/audit summaries.
- Keep documentation aligned with current behavior; use explicit status language
  (implemented, partially validated, residual risks). Update docs in the same change set.
- Do not claim production readiness for scaffolded surfaces without evidence.
- Public CLI/API/UI surfaces are catalogued in `docs/feature_inventory.md`; keep it current.

## Compliance

Governance posture for this repo lives under `governance/`:
- `governance/repo_config.yaml`, `governance/repo_manifest.yaml`, and
  `governance/policy.yaml` define the repo type and policy.
- Blocking findings/actions must be remediated or explicitly justified through the
  governed exception workflow (`governance/exceptions.yaml`).
- Informational findings are non-blocking unless a policy explicitly elevates them.
- Keep `family: application`, `repo_type: service`, and `repo_profile: service_backend`
  aligned with the actual repo structure.

## Validation

This monorepo's authoritative checks (run from the repo root):

```bash
pnpm typecheck   # turbo tsc --noEmit across packages
pnpm test        # turbo test (vitest in packages/web, node tests in packages/cuttlefish)
pnpm lint        # turbo lint
pnpm build       # turbo build (also copies packages/web/out -> packages/cuttlefish/dist/web)
```

## Operating Principles

- Prefer the smallest coherent change that satisfies the task.
- Make failure states visible; do not hide uncertainty, skipped validation, degraded
  mode, or partial completion.
- Do not bundle unrelated work.

## Core Rules

1. Inspect existing code, nearby files, tests, docs, and conventions before writing new code.
2. Do not invent APIs, imports, commands, files, configuration keys, or paths. Verify before use.
3. Preserve project style: naming, formatting, architecture, UI language, logging, tests.
4. Execute one coherent task per run. Do not bundle unrelated fixes or opportunistic cleanup.
5. Stay in scope. If a necessary change touches adjacent scope, disclose it explicitly.
6. Prefer the smallest coherent change that satisfies the task and preserves existing behavior.
7. Surface conflicting patterns instead of averaging them; choose the least risky local convention.
8. Never silently fail. Surface partial success, blocked work, degraded mode, skipped checks.
9. Do not hide or suppress errors to make tests, UI, logs, or reports look clean.
10. Run the relevant tests/checks before declaring completion. State what passed, failed, or was not run.
11. Summarize meaningful tool actions and file changes with their effect.
12. Stop at the task boundary, destructive action, or unresolved ambiguity; report state and next safe step.

## Repository State Rules

13. Do not treat uncommitted files as failure by default. Report them as repository state.
14. Severity `info` findings are not automatic failures. Fail only on configured fail conditions.
15. Respect documented exceptions. A known, governed exception is reported as covered, not rediscovered.
16. Do not modify generated artifacts, vendored files, lockfiles, or `packages/*/dist`/`out` unless required.

## Audit Rules

17. For audit tasks, write findings and evidence. Do not patch code unless explicitly instructed.
18. For patch tasks, keep changes scoped and avoid opportunistic architecture rewrites.
19. Findings must include evidence paths, observed behavior, expected behavior, and remediation guidance.
20. Do not average conflicting conventions. Report the conflict and make the smallest reversible local choice.

## Canonical filename

Use `AGENTS.md` (uppercase) as the single canonical instruction file for this repository.

<!-- audit-retention-convention -->
## Audit File Retention

Audits are written under `docs/audits/`. The entire `docs/audits/` tree is a
**git-ignored local artifact** — audit detail files and monthly summaries live only
on the machine that produced them and are not part of the published repo.

Writing a new audit: write `docs/audits/YYYY-MM-DD-<slug>.md` (optionally bucket it
under `docs/audits/MMYYYY/`). Keep findings with evidence paths, observed vs.
expected behavior, and remediation guidance.
<!-- /audit-retention-convention -->

<!-- session-log-convention -->
## Session and Activity Log Retention

Human-authored session logs, activity logs, repair logs, handoff notes, and agent
run narratives belong under `docs/logs/`, not a top-level `logs/`. New session logs
should be written to `docs/logs/session/<MMYYYY>/<YYYY-MM-DD>-<slug>.md`.

Both `docs/logs/` and the top-level `logs/` (generated runtime telemetry such as
`logs/agent-activity.jsonl`) are **git-ignored local artifacts** — they are not part
of the published repo.
<!-- /session-log-convention -->
