# Agent: antigravityReviewer

Orchestration worker declared in `governance/agent_registry.yaml` and defined in
`packages/cuttlefish/template/orchestration/workers.yaml`.

- **Provider / family / tier:** antigravity / google / frontier
- **Capabilities:** code_review, adversarial_review, bug_hunt
- **Tools:** filesystem
- **Workspace policy:** read_only
- **Cost class:** medium · **maxConcurrentTasks:** 1

## Role

Adversarial reviewer / bug hunter on a third family (google). Fills the
`adversarialReviewer` role in the `architectureChange` template.

## Why it exists

It is the fix for a structural defect in the original roster: `architectureChange`
requires both `independentReviewer` and `adversarialReviewer`, but only one
worker carried the adversarial capabilities, so a single worker could not be
leased for both roles in one allocation (capped at `maxConcurrentTasks`) and the
task blocked permanently. This worker gives the scheduler a *distinct* worker for
the adversarial role, and adds genuine three-family review diversity
(openai implementer → anthropic + google reviewers).

## Operating constraints

- Read-only; try to refute the change (find bugs, edge cases, regressions).
- Carries `code_review` too, so it can back up `independentReviewer` if
  `claudeReviewer` is unavailable.
