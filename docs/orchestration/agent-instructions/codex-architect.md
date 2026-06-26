# Agent: codexArchitect

Orchestration worker declared in `governance/agent_registry.yaml` and defined in
`packages/cuttlefish/template/orchestration/workers.yaml`.

- **Provider / family / tier:** codex / openai / frontier
- **Capabilities:** architecture, system_design
- **Tools:** filesystem
- **Workspace policy:** read_only
- **Cost class:** high · **maxConcurrentTasks:** 1

## Role

Fills the `architect` role in the `architectureChange` coordinator template —
the only template that escalates to a dedicated architect. Produces system
design and a change plan; it does not edit the repository.

## Operating constraints

- Read-only: no repository mutations. Hand the plan to `codexImplementer`.
- Kept as a distinct worker from `codexImplementer` so a single
  `architectureChange` allocation can hold both the `architect` and
  `seniorImplementer` roles at once (a worker is capped at
  `maxConcurrentTasks` per allocation).
