# Agent: localWorker

Orchestration worker declared in `governance/agent_registry.yaml` and defined in
`packages/cuttlefish/template/orchestration/workers.yaml`.

- **Provider / family / tier:** pi (Ollama-backed local engine) / local / local
- **Capabilities:** validation, triage, test_log_triage, duplicate_detection
- **Tools:** filesystem, shell
- **Workspace policy:** shared
- **Cost class:** near_zero · **maxConcurrentTasks:** 4

## Role

Near-zero-cost local worker. Fills the `qaGate` role (validation) across all
templates and the `localTriage` role in `localHeavy`. Because
`maxConcurrentTasks` is 4, a single `localHeavy` allocation can lease it for both
the `localTriage` and `qaGate` roles at once.

## Why one worker

This merges the original roster's two near-identical local entries (`localQa` +
`localTriage`) into a single multi-capability worker. It keeps the design's
"use local compute aggressively for triage/QA" goal (docs/orchestration/README.md)
while removing a redundant roster entry, and prevents the expensive frontier
implementer from being drawn into cheap QA work.

## Operating constraints

- Cheap, fast, local: runs validation/test-log triage and de-duplication.
- Not a reviewer or implementer — it gates and triages, it does not edit code or
  make approval decisions on substantive changes.
