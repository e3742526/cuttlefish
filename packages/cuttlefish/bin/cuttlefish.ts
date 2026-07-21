#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { CANONICAL_INSTANCE_NAME, homeForInstance } from "../src/shared/instance-home.js";

const program = new Command();

function parsePortArg(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer from 1 to 65535");
  }
  return port;
}

function parsePositiveIntegerArg(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("value must be a positive integer");
  }
  return parsed;
}

program
  .name("cuttlefish")
  .description("Lightweight AI gateway daemon")
  .version(pkg.version)
  .option("-i, --instance <name>", "Target the canonical instance (must be cuttlefish)");

// Pre-parse to set CUTTLEFISH_HOME before any module imports resolve paths
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts();
  if (process.env.CUTTLEFISH_INSTANCE && process.env.CUTTLEFISH_INSTANCE !== CANONICAL_INSTANCE_NAME) {
    console.error(`Error: Cuttlefish supports one local instance named "${CANONICAL_INSTANCE_NAME}".`);
    process.exit(1);
  }
  if (opts.instance) {
    if (opts.instance !== CANONICAL_INSTANCE_NAME) {
      console.error(`Error: Cuttlefish supports one local instance named "${CANONICAL_INSTANCE_NAME}".`);
      process.exit(1);
    }
    process.env.CUTTLEFISH_INSTANCE = opts.instance;
    process.env.CUTTLEFISH_HOME = homeForInstance(opts.instance);
  }
});

program
  .command("setup")
  .description("Initialize Cuttlefish and install dependencies")
  .option("--force", "Delete existing home dir and reinitialize from scratch")
  .action(async (opts) => {
    const { runSetup } = await import("../src/cli/setup.js");
    await runSetup(opts);
  });

program
  .command("start")
  .description("Start the gateway daemon")
  .option("--daemon", "Run in background")
  .option("-p, --port <port>", "Override the gateway port from config")
  .action(async (opts) => {
    const { runStart } = await import("../src/cli/start.js");
    await runStart({ daemon: opts.daemon, port: opts.port ? parsePortArg(opts.port) : undefined });
  });

program
  .command("stop")
  .description("Stop the gateway daemon")
  .option("-p, --port <port>", "Port to kill the process on (default: from config or 8888)")
  .action(async (opts: { port?: string }) => {
    const { runStop } = await import("../src/cli/stop.js");
    await runStop(opts.port ? parsePortArg(opts.port) : undefined);
  });

program
  .command("restart")
  .description("Restart the gateway (detached — safe to run from inside a session)")
  .action(async () => {
    const { runRestart } = await import("../src/cli/restart.js");
    await runRestart();
  });

program
  .command("status")
  .description("Show gateway status")
  .action(async () => {
    const { runStatus } = await import("../src/cli/status.js");
    await runStatus();
  });

program
  .command("pair")
  .description("Create a one-time code for pairing another browser")
  .option("--json", "Print raw JSON")
  .action(async (opts: { json?: boolean }) => {
    const { runPair } = await import("../src/cli/pair.js");
    await runPair(opts);
  });

program
  .command("unpair [deviceId]")
  .description("List paired browsers or unpair one by id")
  .option("--json", "Print raw JSON")
  .action(async (deviceId: string | undefined, opts: { json?: boolean }) => {
    const { runUnpair } = await import("../src/cli/pair.js");
    await runUnpair(deviceId, opts);
  });

program
  .command("limits")
  .description("Show engine rate limits, quota windows, and model capabilities")
  .option("-e, --engine <name>", "Only show one engine")
  .option("--json", "Print raw JSON")
  .action(async (opts: { engine?: string; json?: boolean }) => {
    const { runLimits } = await import("../src/cli/limits.js");
    await runLimits(opts);
  });

program
  .command("create <name>")
  .description("Disabled: Cuttlefish supports one local instance")
  .option("-p, --port <port>", "Set gateway port (auto-assigned if omitted)")
  .action(async (name: string, opts: { port?: string }) => {
    const { runCreate } = await import("../src/cli/create.js");
    await runCreate(name, opts.port ? parsePortArg(opts.port) : undefined);
  });

program
  .command("list")
  .description("Show the canonical Cuttlefish instance")
  .action(async () => {
    const { runList } = await import("../src/cli/list.js");
    await runList();
  });

program
  .command("remove <name>")
  .description("Legacy cleanup for non-canonical registry entries")
  .option("--force", "Also delete the instance home directory")
  .action(async (name: string, opts: { force?: boolean }) => {
    const { runRemove } = await import("../src/cli/remove.js");
    await runRemove(name, opts);
  });

program
  .command("nuke [name]")
  .description("Legacy cleanup for non-canonical registry entries")
  .action(async (name?: string) => {
    const { runNuke } = await import("../src/cli/nuke.js");
    await runNuke(name);
  });

program
  .command("migrate")
  .description("Apply pending template migrations to update this instance")
  .option("--check", "Only check for pending migrations, don't apply")
  .option("--auto", "Apply safe changes automatically without launching AI")
  .action(async (opts) => {
    const { runMigrate } = await import("../src/cli/migrate.js");
    await runMigrate(opts);
  });

// Orchestration subcommands. Read-only inspection and dry-run commands require
// an explicit config path; live commands remain opt-in through their named
// action rather than becoming side effects of CLI startup.
{
  const workersCmd = program
    .command("workers")
    .description("Inspect configured orchestration workers");

  workersCmd
    .command("list")
    .description("List workers from an explicit orchestration config directory")
    .requiredOption("--config-dir <dir>", "Directory containing orchestration YAML files")
    .option("--json", "Print raw JSON")
    .action(async (opts: { configDir: string; json?: boolean }) => {
      const { runWorkersList } = await import("../src/cli/orchestration.js");
      await runWorkersList(opts);
    });
}

{
  const schedulerCmd = program
    .command("scheduler")
    .description("Plan, simulate, and inspect orchestration scheduling");

  schedulerCmd
    .command("allocate <taskFile>")
    .description("Validate an allocation as an inert dry-run")
    .requiredOption("--config-dir <dir>", "Directory containing orchestration YAML files")
    .requiredOption("--dry-run", "Required safety guard; does not start a live worker")
    .option("--json", "Print raw JSON")
    .action(async (taskFile: string, opts: { configDir: string; dryRun?: boolean; json?: boolean }) => {
      const { runSchedulerAllocate } = await import("../src/cli/orchestration.js");
      await runSchedulerAllocate(taskFile, opts);
    });

  schedulerCmd
    .command("simulate <scenarioFile>")
    .description("Run an in-memory scheduler scenario")
    .requiredOption("--config-dir <dir>", "Directory containing orchestration YAML files")
    .option("--json", "Print raw JSON")
    .action(async (scenarioFile: string, opts: { configDir: string; json?: boolean }) => {
      const { runSchedulerSimulate } = await import("../src/cli/orchestration.js");
      await runSchedulerSimulate(scenarioFile, opts);
    });

  schedulerCmd
    .command("plan <taskFile>")
    .description("Create an observe-only allocation plan")
    .requiredOption("--config-dir <dir>", "Directory containing orchestration YAML files")
    .option("--db-path <path>", "Optional scheduler database to observe")
    .option("--json", "Print raw JSON")
    .action(async (taskFile: string, opts: { configDir: string; dbPath?: string; json?: boolean }) => {
      const { runSchedulerPlan } = await import("../src/cli/orchestration.js");
      await runSchedulerPlan(taskFile, opts);
    });

  schedulerCmd
    .command("stats")
    .description("Summarize append-only orchestration telemetry")
    .option("--path <file>", "Telemetry JSONL path")
    .option("--json", "Print raw JSON")
    .action(async (opts: { path?: string; json?: boolean }) => {
      const { runSchedulerStats } = await import("../src/cli/orchestration.js");
      await runSchedulerStats(opts);
    });
}

{
  const leasesCmd = program
    .command("leases")
    .description("Inspect durable orchestration leases");

  leasesCmd
    .command("list")
    .description("List durable leases without creating scheduler state")
    .requiredOption("--config-dir <dir>", "Directory containing orchestration YAML files")
    .option("--db-path <path>", "Scheduler database path")
    .option("--json", "Print raw JSON")
    .action(async (opts: { configDir: string; dbPath?: string; json?: boolean }) => {
      const { runLeasesList } = await import("../src/cli/orchestration.js");
      await runLeasesList(opts);
    });
}

{
  const queueCmd = program
    .command("queue")
    .description("Inspect and control orchestration queue items");

  queueCmd
    .command("list")
    .description("List blocked queue items without creating scheduler state")
    .requiredOption("--config-dir <dir>", "Directory containing orchestration YAML files")
    .option("--db-path <path>", "Scheduler database path")
    .option("--json", "Print raw JSON")
    .action(async (opts: { configDir: string; dbPath?: string; json?: boolean }) => {
      const { runQueueList } = await import("../src/cli/orchestration.js");
      await runQueueList(opts);
    });

  queueCmd
    .command("pause-task")
    .description("Pause one queued task through the running gateway")
    .requiredOption("--task-id <id>", "Task ID")
    .requiredOption("--coordinator-id <id>", "Coordinator ID")
    .option("--reason <text>", "Operator-visible pause reason")
    .option("--manager-name <name>", "Manager authorizing the pause")
    .option("--json", "Print raw JSON")
    .action(async (opts: { taskId: string; coordinatorId: string; reason?: string; managerName?: string; json?: boolean }) => {
      const { runQueuePauseTask } = await import("../src/cli/orchestration.js");
      await runQueuePauseTask(opts);
    });

  queueCmd
    .command("resume-task")
    .description("Resume one queued task through the running gateway")
    .requiredOption("--task-id <id>", "Task ID")
    .requiredOption("--coordinator-id <id>", "Coordinator ID")
    .option("--json", "Print raw JSON")
    .action(async (opts: { taskId: string; coordinatorId: string; json?: boolean }) => {
      const { runQueueResumeTask } = await import("../src/cli/orchestration.js");
      await runQueueResumeTask(opts);
    });
}

program
  .command("run")
  .description("Submit an opt-in live orchestration task to the running gateway")
  .requiredOption("--mode <mode>", "Run mode")
  .requiredOption("--task <file>", "Task YAML file")
  .option("--json", "Print raw JSON")
  .action(async (opts: { mode: string; task: string; json?: boolean }) => {
    const { runOrchestrationRun } = await import("../src/cli/orchestration.js");
    await runOrchestrationRun(opts);
  });

{
  const dualLaneCmd = program
    .command("dual-lane")
    .description("Select or apply a completed dual-lane orchestration result");

  for (const action of ["select", "apply"] as const) {
    dualLaneCmd
      .command(action)
      .description(`${action === "select" ? "Select" : "Apply"} a dual-lane winner`)
      .requiredOption("--task-id <id>", "Task ID")
      .requiredOption("--coordinator-id <id>", "Coordinator ID")
      .requiredOption("--winner <lane>", "Winning lane")
      .option("--json", "Print raw JSON")
      .action(async (opts: { taskId: string; coordinatorId: string; winner: string; json?: boolean }) => {
        const { runDualLaneApply, runDualLaneSelect } = await import("../src/cli/orchestration.js");
        if (action === "select") await runDualLaneSelect(opts);
        else await runDualLaneApply(opts);
      });
  }
}

{
  const holdsCmd = program
    .command("holds")
    .description("Manage TTL-bounded orchestration worker holds");

  holdsCmd
    .command("list")
    .description("List active and historical holds")
    .option("--json", "Print raw JSON")
    .action(async (opts: { json?: boolean }) => {
      const { runHoldsList } = await import("../src/cli/orchestration.js");
      await runHoldsList(opts);
    });

  holdsCmd
    .command("create")
    .description("Create a manager-authorized worker hold")
    .requiredOption("--manager-name <name>", "Manager authorizing the hold")
    .option("--role <role...>", "Role(s) to hold")
    .option("--worker-id <id...>", "Worker ID(s) to hold")
    .option("--task-id <id>", "Optional task ID")
    .option("--coordinator-id <id>", "Optional coordinator ID")
    .option("--reason <text>", "Operator-visible reason")
    .option("--ttl-ms <ms>", "Hold TTL in milliseconds", parsePositiveIntegerArg)
    .option("--json", "Print raw JSON")
    .action(async (opts: { managerName: string; role?: string[]; workerId?: string[]; taskId?: string; coordinatorId?: string; reason?: string; ttlMs?: number; json?: boolean }) => {
      const { runHoldsCreate } = await import("../src/cli/orchestration.js");
      await runHoldsCreate(opts);
    });

  holdsCmd
    .command("extend")
    .description("Extend an existing manager-authorized hold")
    .requiredOption("--hold-id <id>", "Hold ID")
    .requiredOption("--manager-name <name>", "Manager authorizing the extension")
    .requiredOption("--ttl-ms <ms>", "New TTL in milliseconds", parsePositiveIntegerArg)
    .option("--json", "Print raw JSON")
    .action(async (opts: { holdId: string; managerName: string; ttlMs: number; json?: boolean }) => {
      const { runHoldsExtend } = await import("../src/cli/orchestration.js");
      await runHoldsExtend(opts);
    });

  holdsCmd
    .command("cancel")
    .description("Cancel an existing manager-authorized hold")
    .requiredOption("--hold-id <id>", "Hold ID")
    .requiredOption("--manager-name <name>", "Manager authorizing the cancellation")
    .option("--json", "Print raw JSON")
    .action(async (opts: { holdId: string; managerName: string; json?: boolean }) => {
      const { runHoldsCancel } = await import("../src/cli/orchestration.js");
      await runHoldsCancel(opts);
    });
}

{
  const artifactsCmd = program
    .command("artifacts")
    .description("Inspect dual-lane orchestration artifacts");

  artifactsCmd
    .command("view")
    .description("View a raw diff, prompt, or output artifact")
    .requiredOption("--task-id <id>", "Task ID")
    .requiredOption("--coordinator-id <id>", "Coordinator ID")
    .requiredOption("--kind <kind>", "Artifact kind: diff, prompt, or output")
    .option("--json", "Print raw JSON")
    .action(async (opts: { taskId: string; coordinatorId: string; kind: "diff" | "prompt" | "output"; json?: boolean }) => {
      const { runArtifactsView } = await import("../src/cli/orchestration.js");
      await runArtifactsView(opts);
    });
}

{
  const continuationsCmd = program
    .command("continuations")
    .description("Inspect and retry durable orchestration continuations");

  continuationsCmd
    .command("list")
    .description("List continuations through the running gateway")
    .option("--json", "Print raw JSON")
    .action(async (opts: { json?: boolean }) => {
      const { runContinuationsList } = await import("../src/cli/orchestration.js");
      await runContinuationsList(opts);
    });

  continuationsCmd
    .command("retry")
    .description("Retry a failed continuation through the running gateway")
    .requiredOption("--task-id <id>", "Task ID")
    .requiredOption("--coordinator-id <id>", "Coordinator ID")
    .option("--json", "Print raw JSON")
    .action(async (opts: { taskId: string; coordinatorId: string; json?: boolean }) => {
      const { runContinuationRetry } = await import("../src/cli/orchestration.js");
      await runContinuationRetry(opts);
    });
}

{
  const recoveryCmd = program
    .command("recovery")
    .description("Inspect and requeue recovered orchestration continuations");

  recoveryCmd
    .command("notices")
    .description("List corrupt-database recovery notices")
    .option("--json", "Print raw JSON")
    .action(async (opts: { json?: boolean }) => {
      const { runRecoveryNotices } = await import("../src/cli/orchestration.js");
      await runRecoveryNotices(opts);
    });

  recoveryCmd
    .command("requeue")
    .description("Requeue one recovered continuation in a paused state")
    .requiredOption("--manifest <path>", "Recovery manifest path")
    .requiredOption("--task-id <id>", "Task ID")
    .requiredOption("--coordinator-id <id>", "Coordinator ID")
    .requiredOption("--manager-name <name>", "Manager authorizing the requeue")
    .option("--json", "Print raw JSON")
    .action(async (opts: { manifest: string; taskId: string; coordinatorId: string; managerName: string; json?: boolean }) => {
      const { runRecoveryRequeue } = await import("../src/cli/orchestration.js");
      await runRecoveryRequeue(opts);
    });
}

{
  const worktreeCmd = program
    .command("worktree")
    .description("Create, inspect, and remove managed task worktrees");

  for (const action of ["create", "diff", "cleanup"] as const) {
    worktreeCmd
      .command(`${action} <taskFile>`)
      .description(`${action === "create" ? "Create" : action === "diff" ? "Show the diff for" : "Remove"} a managed task worktree`)
      .option("--lane <name>", "Worktree lane", "implementation")
      .option("--json", "Print raw JSON")
      .action(async (taskFile: string, opts: { lane?: string; json?: boolean }) => {
        const { runWorktreeCleanup, runWorktreeCreate, runWorktreeDiff } = await import("../src/cli/orchestration.js");
        if (action === "create") await runWorktreeCreate(taskFile, opts);
        else if (action === "diff") await runWorktreeDiff(taskFile, opts);
        else await runWorktreeCleanup(taskFile, opts);
      });
  }
}

// Skills subcommands (cuttlefish skills find|add|remove|list|update|restore)
{
  const skillsCmd = program
    .command("skills")
    .description("Manage skills from the skills.sh registry");

  skillsCmd
    .command("find [query]")
    .description("Search the skills.sh registry")
    .action(async (query?: string) => {
      const { skillsFind } = await import("../src/cli/skills.js");
      skillsFind(query);
    });

  skillsCmd
    .command("add <package>")
    .description("Install a skill from skills.sh")
    .action(async (pkg: string) => {
      const { skillsAdd } = await import("../src/cli/skills.js");
      skillsAdd(pkg);
    });

  skillsCmd
    .command("remove <name>")
    .description("Remove a skill from this instance")
    .action(async (name: string) => {
      const { skillsRemove } = await import("../src/cli/skills.js");
      skillsRemove(name);
    });

  skillsCmd
    .command("list")
    .description("List installed skills")
    .action(async () => {
      const { skillsList } = await import("../src/cli/skills.js");
      skillsList();
    });

  skillsCmd
    .command("update")
    .description("Re-install all skills to get latest versions")
    .action(async () => {
      const { skillsUpdate } = await import("../src/cli/skills.js");
      skillsUpdate();
    });

  skillsCmd
    .command("restore")
    .description("Install all skills listed in skills.json")
    .action(async () => {
      const { skillsRestore } = await import("../src/cli/skills.js");
      skillsRestore();
    });
}

// Ledger subcommands (cuttlefish ledger reset|status)
{
  const ledgerCmd = program
    .command("ledger")
    .description("Manage the run ledger database");

  ledgerCmd
    .command("status")
    .description("Show run ledger schema version and record counts")
    .action(async () => {
      const { runLedgerStatus } = await import("../src/cli/ledger.js");
      await runLedgerStatus();
    });

  ledgerCmd
    .command("reset")
    .description("Quarantine an incompatible run-ledger DB and let it be recreated clean on next start")
    .option("--force", "Skip confirmation prompt")
    .action(async (opts: { force?: boolean }) => {
      const { runLedgerReset } = await import("../src/cli/ledger.js");
      await runLedgerReset(opts);
    });
}

// Inspect subcommands (cuttlefish inspect runs|run|lineage|dead-letter|policy)
{
  const inspectCmd = program
    .command("inspect")
    .description("Inspect run-ledger, artifact lineage, dead-letter, and policy state");

  inspectCmd
    .command("runs")
    .description("List run-ledger records")
    .option("--state <state>", "Filter by canonical state")
    .option("--session <sessionId>", "Filter by session ID")
    .option("--limit <n>", "Maximum records to show", "50")
    .action(async (opts: { state?: string; session?: string; limit?: string }) => {
      const { runInspectRuns } = await import("../src/cli/inspect.js");
      await runInspectRuns(opts);
    });

  inspectCmd
    .command("run <runId>")
    .description("Show a single run record with events and errors")
    .action(async (runId: string) => {
      const { runInspectRun } = await import("../src/cli/inspect.js");
      await runInspectRun(runId);
    });

  inspectCmd
    .command("lineage <artifactId>")
    .description("Show artifact lineage (ancestors and descendants)")
    .action(async (artifactId: string) => {
      const { runInspectLineage } = await import("../src/cli/inspect.js");
      await runInspectLineage(artifactId);
    });

  inspectCmd
    .command("dead-letter")
    .description("Show quarantine records from the artifact lineage DB")
    .action(async () => {
      const { runInspectDeadLetter } = await import("../src/cli/inspect.js");
      await runInspectDeadLetter();
    });

  inspectCmd
    .command("policy")
    .description("Show the resolved policy snapshot")
    .action(async () => {
      const { runInspectPolicy } = await import("../src/cli/inspect.js");
      await runInspectPolicy();
    });
}

program.parse();
