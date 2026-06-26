# Agent: claudeReviewer

Orchestration worker declared in `governance/agent_registry.yaml` and defined in
`packages/cuttlefish/template/orchestration/workers.yaml`.

- **Provider / family / tier:** claude / anthropic / small
- **Capabilities:** code_review, checklist_review
- **Tools:** filesystem
- **Workspace policy:** read_only
- **Cost class:** low · **maxConcurrentTasks:** 1

## Role

Everyday independent reviewer. Fills the `independentReviewer` role, which
carries `familyConstraint: opposite_of_implementer` — because the default
implementer is `codex` (openai family), this anthropic-family worker satisfies
the cross-family separation so a provider's blind spots are not reviewed by the
same provider.

## Operating constraints

- Read-only review; surface findings, do not edit.
- Low cost by design — this is the default second pair of eyes on every
  `standardImplementation` and the optional reviewer on `simpleImplementation`.
- For architecture-class changes it pairs with `antigravityReviewer`, which runs
  the adversarial pass.
