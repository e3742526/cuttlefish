import { execSync, spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeWriteFile } from "../shared/safe-write.js";
import { PID_FILE, CUTTLEFISH_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { CuttlefishConfig } from "../shared/types.js";
import { startGateway } from "./server.js";
import { loadConfig } from "../shared/config.js";
import { installProcessErrorHandlers } from "./process-guards.js";

const MIN_NODE_MAJOR = 24;
const DAEMON_LOCK_FILE = path.join(CUTTLEFISH_HOME, "daemon.lock");

/**
 * Return a Node.js executable that satisfies the minimum required major version.
 * Falls back to process.execPath (and logs a warning) if none can be found.
 *
 * Search order: current execPath → PATH → hermit → nvm/fnm → ~/.local/bin
 */
function resolveNodeExecutable(): string {
  const current = process.execPath;
  if (nodeMajor(current) >= MIN_NODE_MAJOR) return current;

  // Candidates from common version managers and install locations.
  const home = os.homedir();
  const candidates: string[] = [
    // hermit (project-local or user-level)
    path.join(home, ".cache", "hermit", "pkg", `node-${MIN_NODE_MAJOR}.x.x`, "bin", "node"),
    // try any hermit node-24.* directory
    ...hermitNodeCandidates(home),
    // nvm
    ...nvmCandidates(home),
    // fnm
    ...fnmCandidates(home),
    // asdf
    path.join(home, ".asdf", "shims", "node"),
    // system / user local
    "/usr/local/bin/node",
    "/usr/bin/node",
    path.join(home, ".local", "bin", "node"),
  ];

  for (const bin of candidates) {
    if (fs.existsSync(bin) && nodeMajor(bin) >= MIN_NODE_MAJOR) {
      logger.info(`Daemon will use Node.js at ${bin} (current execPath is Node ${nodeMajor(current)})`);
      return bin;
    }
  }

  logger.error(
    `Could not find Node.js >= ${MIN_NODE_MAJOR} — daemon may crash (current execPath is Node ${nodeMajor(current)}). ` +
    `Install Node.js 24+ from https://nodejs.org or set CUTTLEFISH_NODE_PATH.`,
  );
  return current;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * SEC-CFDB-001: CUTTLEFISH_HOME holds the sessions/run-ledger/orchestration/
 * artifact-lineage SQLite DBs, config, and other sensitive runtime state, so
 * it must be owner-only. `mode` on mkdirSync only applies to a directory this
 * call creates; an existing install (pre-dating this hardening) keeps
 * whatever perms it had, so chmod it explicitly too, defensively, on every
 * daemon start.
 */
export function ensureSecureCuttlefishHome(home: string = CUTTLEFISH_HOME): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(home, 0o700);
    } catch {
      // best-effort; e.g. permission denied on a shared/read-only mount
    }
  }
}

function acquireDaemonLock(): () => void {
  ensureSecureCuttlefishHome();
  const writeLock = (pid: number) => {
    const fd = fs.openSync(DAEMON_LOCK_FILE, "wx");
    fs.writeFileSync(fd, `${pid}\n`, "utf8");
    fs.closeSync(fd);
  };

  try {
    writeLock(process.pid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const stalePid = Number.parseInt(fs.readFileSync(DAEMON_LOCK_FILE, "utf8").trim(), 10);
    if (Number.isFinite(stalePid) && pidIsAlive(stalePid)) {
      throw new Error(`Another cuttlefish daemon is already running (pid ${stalePid}). Stop it before starting a second instance.`);
    }
    fs.rmSync(DAEMON_LOCK_FILE, { force: true });
    writeLock(process.pid);
  }

  const release = () => {
    try {
      const recordedPid = Number.parseInt(fs.readFileSync(DAEMON_LOCK_FILE, "utf8").trim(), 10);
      if (!Number.isFinite(recordedPid) || recordedPid === process.pid) {
        fs.rmSync(DAEMON_LOCK_FILE, { force: true });
      }
    } catch {
      fs.rmSync(DAEMON_LOCK_FILE, { force: true });
    }
  };

  process.once("exit", release);
  return release;
}

function nodeMajor(bin: string): number {
  try {
    const v = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 3000 }).trim();
    const m = v.match(/^v?(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function hermitNodeCandidates(home: string): string[] {
  const dir = path.join(home, ".cache", "hermit", "pkg");
  try {
    return fs.readdirSync(dir)
      .filter((n) => n.startsWith(`node-${MIN_NODE_MAJOR}.`))
      .map((n) => path.join(dir, n, "bin", "node"));
  } catch {
    return [];
  }
}

function nvmCandidates(home: string): string[] {
  const base = process.env.NVM_DIR ?? path.join(home, ".nvm", "versions", "node");
  try {
    return fs.readdirSync(base)
      .filter((n) => n.startsWith(`v${MIN_NODE_MAJOR}.`))
      .map((n) => path.join(base, n, "bin", "node"));
  } catch {
    return [];
  }
}

function fnmCandidates(home: string): string[] {
  const base = path.join(home, ".local", "share", "fnm", "node-versions");
  try {
    return fs.readdirSync(base)
      .filter((n) => n.startsWith(`v${MIN_NODE_MAJOR}.`) || n.startsWith(`${MIN_NODE_MAJOR}.`))
      .map((n) => path.join(base, n, "installation", "bin", "node"));
  } catch {
    return [];
  }
}

export async function startForeground(config: CuttlefishConfig): Promise<void> {
  installProcessErrorHandlers();
  const releaseDaemonLock = acquireDaemonLock();
  const cleanup = await startGateway(config);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      logger.info("Forced exit");
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("Shutting down gateway...");

    // Force exit if graceful shutdown takes too long
    const forceTimer = setTimeout(() => {
      logger.warn("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 5000);
    forceTimer.unref();

    await cleanup();
    releaseDaemonLock();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export function startDaemon(config: CuttlefishConfig): void {
  const __filename = fileURLToPath(import.meta.url);
  const candidateEntryScripts = [
    // When running from a built bundle, __filename is dist/src/gateway/lifecycle.js
    path.resolve(path.dirname(__filename), "daemon-entry.js"),
    // Fallback for unusual layouts
    path.resolve(path.dirname(__filename), "..", "..", "dist", "src", "gateway", "daemon-entry.js"),
  ];
  const entryScript = candidateEntryScripts.find((p) => fs.existsSync(p)) ?? candidateEntryScripts[0];

  const child = spawn(resolveNodeExecutable(), [entryScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CUTTLEFISH_HOME },
  });

  if (child.pid) {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    safeWriteFile(PID_FILE, String(child.pid), { fsync: false }); // atomic; durability unneeded for a pid file
    logger.info(`Gateway daemon started with PID ${child.pid}`);
  }

  child.unref();
}

/**
 * Restart the gateway from a DETACHED, reparented helper process.
 *
 * The whole point: a `cuttlefish stop && cuttlefish start` run from *inside* a gateway
 * session fails because `stop` kills the gateway, whose shutdown kills all PTYs
 * — including the very session running the command — so `start` never executes.
 * This spawns a helper (restart-entry.js) detached + unref'd with no IPC, so it
 * is reparented to launchd/init and SURVIVES the gateway's killAll(). The
 * helper does stop → waitForPortFree → startDaemon out of band. The returning
 * gateway then resumes the interrupted session.
 */
export function restartDetached(): void {
  const __filename = fileURLToPath(import.meta.url);
  const candidateEntryScripts = [
    path.resolve(path.dirname(__filename), "restart-entry.js"),
    path.resolve(path.dirname(__filename), "..", "..", "dist", "src", "gateway", "restart-entry.js"),
  ];
  const entryScript = candidateEntryScripts.find((p) => fs.existsSync(p)) ?? candidateEntryScripts[0];

  const child = spawn(resolveNodeExecutable(), [entryScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CUTTLEFISH_HOME },
  });

  if (child.pid) {
    logger.info(`Gateway restart helper started with PID ${child.pid}`);
  }

  child.unref();
}

/**
 * Send SIGTERM to the running gateway. Returns the PID that was signaled (or
 * was found already gone), or null if nothing was running.
 *
 * Deliberately does NOT delete the PID file after a successful SIGTERM: the
 * gateway keeps shutting down (gracefully, up to ~5s) after the signal, and
 * unlinking early opens a race window where the gateway is still running and
 * holding the port but a concurrent start/status sees "not running". The file
 * self-heals once the process exits: getStatus() and stop() both verify
 * liveness with kill(pid, 0) and treat a dead PID as stale, and startDaemon()
 * overwrites the file. stopAndWait() removes it once the process has exited.
 */
function signalGateway(port?: number): number | null {
  // Try PID file first
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);

    try {
      process.kill(pid, "SIGTERM");
      logger.info(`Sent SIGTERM to gateway process ${pid}`);
      return pid;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        logger.warn(`Process ${pid} not found. Cleaning up stale PID file.`);
        fs.unlinkSync(PID_FILE);
      } else {
        throw err;
      }
    }
    // PID file existed but was stale; fall through to kill by port.
  }

  // No PID file means we cannot prove ownership. Do not kill an arbitrary
  // process just because it is listening on the configured port.
  const targetPort = port ?? resolvePort();
  const pid = findPidOnPort(targetPort);
  if (pid) {
    logger.warn(`Port ${targetPort} is occupied by PID ${pid}, but no Cuttlefish PID file exists; refusing to kill an unowned process.`);
    return null;
  }

  logger.warn(`No PID file found and nothing listening on port ${targetPort}.`);
  return null;
}

export function stop(port?: number): boolean {
  return signalGateway(port) !== null;
}

/**
 * Stop the gateway and wait until the process has actually exited (bounded by
 * `timeoutMs`), then remove the PID file. This is the race-free variant used
 * by the restart path: the PID file stays on disk for the whole shutdown so a
 * concurrent start/status keeps seeing "running" until the port is truly
 * released. Returns true if something was signaled, false if nothing was
 * running.
 */
export async function stopAndWait(port?: number, timeoutMs = 10_000): Promise<boolean> {
  const pid = signalGateway(port);
  if (pid === null) return false;

  const exited = await waitForPidExit(pid, timeoutMs);
  if (!exited) {
    logger.warn(`Process ${pid} still alive after ${timeoutMs}ms — leaving PID file in place`);
    return true;
  }

  // Only remove the PID file if it still refers to the process we stopped —
  // a fresh daemon may have overwritten it already.
  try {
    if (
      fs.existsSync(PID_FILE) &&
      parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10) === pid
    ) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // best-effort cleanup; a leftover stale file self-heals (see signalGateway)
  }
  return true;
}

/** Poll kill(pid, 0) until the process is gone, or `timeoutMs` elapses. */
async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH (or EPERM on a recycled PID) — treat as exited
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function resolvePort(portOverride?: number): number {
  if (typeof portOverride === "number" && Number.isFinite(portOverride) && portOverride > 0) {
    return portOverride;
  }
  const config = loadConfig();
  return config.gateway?.port || 8888;
}

function findPidOnPort(port: number): number | null {
  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf-8" }).trim();
      if (!output) return null;
      // netstat output: proto  local_addr  foreign_addr  state  PID
      const parts = output.split("\n")[0].trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      return isNaN(pid) ? null : pid;
    } else {
      const output = execSync(
        process.platform === "darwin"
          ? `/usr/sbin/lsof -ti tcp:${port}`
          : `lsof -ti tcp:${port}`,
        { encoding: "utf-8" },
      ).trim();
      if (!output) return null;
      const pid = parseInt(output.split("\n")[0], 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {
    return null;
  }
}

/**
 * Poll until nothing is listening on `port`, or `timeoutMs` elapses.
 * Returns true if the port became free, false on timeout (caller should start
 * anyway — startGateway will surface EADDRINUSE if it's still bound). This is
 * the race-killer: it prevents a fresh daemon from racing the old one's
 * graceful shutdown (up to 5s) into an EADDRINUSE crash.
 */
export async function waitForPortFree(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findPidOnPort(port) === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export async function waitForPortListening(port: number, host = "127.0.0.1", timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
  error?: string;
}

export function getStatus(portOverride?: number): GatewayStatus {
  let targetPort: number;
  try {
    targetPort = resolvePort(portOverride);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { running: false, pid: null, error: message };
  }

  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      // Process not alive, stale PID file — fall back to port check.
      const portPid = findPidOnPort(targetPort);
      if (portPid) {
        return {
          running: false,
          pid: null,
          error: `Port ${targetPort} is occupied by PID ${portPid}, but the Cuttlefish PID file is stale. Refusing to treat an unowned process as Cuttlefish.`,
        };
      }
      return { running: false, pid };
    }
  }

  const portPid = findPidOnPort(targetPort);
  if (portPid) {
    return {
      running: false,
      pid: null,
      error: `Port ${targetPort} is occupied by PID ${portPid}, but no Cuttlefish PID file exists.`,
    };
  }
  return { running: false, pid: null };
}
