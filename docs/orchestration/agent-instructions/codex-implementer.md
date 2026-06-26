# Agent: codexImplementer

Orchestration worker declared in `governance/agent_registry.yaml` and defined in
`packages/cuttlefish/template/orchestration/workers.yaml`.

- **Provider / family / tier:** codex / openai / frontier
- **Capabilities:** repo_edit, coding, refactor, validation
- **Tools:** git, filesystem, shell
- **Workspace policy:** isolated_worktree
- **Cost class:** high · **maxConcurrentTasks:** 1

## Role

Primary implementer. Fills the `seniorImplementer` role in the
`simpleImplementation`, `standardImplementation`, and `architectureChange`
coordinator templates. Makes the actual repository edits inside an isolated git
worktree so concurrent workers never collide.

## Operating constraints

- Edit only within the leased worktree; never mutate `~/.cuttlefish` runtime state.
- Follow the repo contract in `AGENTS.md` (smallest coherent change, no fake
  success, run validation before done).
- Its work is gated by an independent cross-family reviewer (`claudeReviewer`)
  and a QA gate (`localWorker`); do not self-approve.
