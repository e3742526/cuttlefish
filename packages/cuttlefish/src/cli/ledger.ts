import fs from "node:fs";
import path from "node:path";
import { RUN_LEDGER_DB } from "../shared/paths.js";
import { getRunLedger } from "../run-ledger/index.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export async function runLedgerStatus(): Promise<void> {
  const dbPath = RUN_LEDGER_DB;
  if (!fs.existsSync(dbPath)) {
    console.log(`${YELLOW}Run ledger not found at ${dbPath}${RESET}`);
    console.log("It will be created automatically when the gateway starts.");
    return;
  }
  const ledger = getRunLedger(dbPath);
  const schemaVersion = ledger.getSchemaVersion();
  const runs = ledger.listRuns({ limit: 10000 });
  const byCounts: Record<string, number> = {};
  for (const run of runs) {
    byCounts[run.currentState] = (byCounts[run.currentState] ?? 0) + 1;
  }
  console.log(`${GREEN}Run Ledger${RESET}`);
  console.log(`  Path:           ${dbPath}`);
  console.log(`  Schema version: ${schemaVersion ?? "(none)"}`);
  console.log(`  Total runs:     ${runs.length}`);
  for (const [state, count] of Object.entries(byCounts).sort()) {
    console.log(`    ${state}: ${count}`);
  }
  ledger.close();
}

export async function runLedgerReset(opts: { force?: boolean }): Promise<void> {
  const dbPath = RUN_LEDGER_DB;
  if (!fs.existsSync(dbPath)) {
    console.log(`${YELLOW}Run ledger not found at ${dbPath}${RESET}`);
    console.log("Nothing to reset.");
    return;
  }

  let schemaVersion: string | null = null;
  try {
    const ledger = getRunLedger(dbPath);
    schemaVersion = ledger.getSchemaVersion();
    ledger.close();
  } catch {
    // If we can't read it, treat it as incompatible
  }

  const compatible = schemaVersion !== null && Number(schemaVersion) >= 1;
  if (compatible && !opts.force) {
    console.log(`${GREEN}Run ledger schema version ${schemaVersion} appears compatible.${RESET}`);
    console.log("Use --force to quarantine and reset anyway.");
    return;
  }

  if (!opts.force) {
    console.log(`${YELLOW}Run ledger at ${dbPath} has schema version: ${schemaVersion ?? "(none)"}${RESET}`);
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Quarantine and reset the run ledger? [y/N] ", resolve);
    });
    rl.close();
    if (answer.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "-").replace(/-$/, "");
  const quarantinePath = `${dbPath}.quarantine.${stamp}`;
  try {
    fs.renameSync(dbPath, quarantinePath);
    for (const ext of ["-wal", "-shm"]) {
      const src = `${dbPath}${ext}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${quarantinePath}${ext}`);
    }
  } catch (err) {
    console.error(`${RED}Failed to quarantine run ledger: ${err instanceof Error ? err.message : err}${RESET}`);
    console.error("The gateway may be running and holding a lock on the database.");
    process.exitCode = 1;
    return;
  }
  console.log(`${GREEN}Quarantined run ledger to:${RESET} ${quarantinePath}`);
  console.log(`${DIM}The gateway will create a fresh run-ledger.db on next start.${RESET}`);
}
