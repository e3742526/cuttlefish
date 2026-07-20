import { describe, it, expect, afterEach } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Point CUTTLEFISH_HOME at a temp dir BEFORE importing the module under test so
// PID_FILE resolves inside it.
const { home: tmpHome } = withStaticTempCuttlefishHome("cuttlefish-lifecycle-stop-");

const { stop, stopAndWait, getStatus, writeGatewayPid, clearGatewayPid } = await import("../lifecycle.js");
const { PID_FILE } = await import("../../shared/paths.js");

/** Pick a free ephemeral port (nothing will be listening on it afterwards). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn a child that exits `delayMs` after receiving SIGTERM (simulating graceful shutdown). */
function spawnSlowShutdownChild(delayMs: number): ChildProcess {
  const script = `process.on("SIGTERM", () => setTimeout(() => process.exit(0), ${delayMs})); setInterval(() => {}, 1000);`;
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("stop / stopAndWait PID-file race", () => {
  const children: ChildProcess[] = [];
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    for (const child of children.splice(0)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await waitForExit(child);
    }
    fs.rmSync(PID_FILE, { force: true });
  });

  async function listenOnFreePort(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        servers.push(server);
        resolve({ server, port });
      });
    });
  }

  function writeConfigForPort(port: number): void {
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), [
      "gateway:",
      `  port: ${port}`,
      "  host: \"127.0.0.1\"",
      "engines:",
      "  default: claude",
      "  claude: {}",
      "logging:",
      "  file: false",
      "  stdout: false",
      "  level: info",
      "",
    ].join("\n"));
  }

  it("stop() leaves the PID file in place while the process is still shutting down", async () => {
    const child = spawnSlowShutdownChild(500);
    children.push(child);
    await waitForSpawn(child);
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));

    const stopped = stop(await freePort());
    expect(stopped).toBe(true);
    // The fix: no early unlink — a concurrent start/status must keep seeing
    // the (still running) gateway until it actually exits.
    expect(fs.existsSync(PID_FILE)).toBe(true);
    expect(child.exitCode).toBe(null); // still shutting down

    await waitForExit(child);
  });

  it("stopAndWait() waits for the process to exit, then removes the PID file", async () => {
    const child = spawnSlowShutdownChild(300);
    children.push(child);
    await waitForSpawn(child);
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));

    const stopped = await stopAndWait(await freePort(), 5_000);
    expect(stopped).toBe(true);
    // Process must be gone by the time stopAndWait resolves…
    expect(() => process.kill(child.pid!, 0)).toThrow();
    // …and only then is the PID file removed.
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  it("stop() cleans up a stale PID file and reports not running", async () => {
    const child = spawnSlowShutdownChild(0);
    children.push(child);
    await waitForSpawn(child);
    const deadPid = child.pid!;
    child.kill("SIGKILL");
    await waitForExit(child);

    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(deadPid));

    const stopped = stop(await freePort());
    expect(stopped).toBe(false);
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  it("stop() refuses to kill an unowned process listening on the target port", async () => {
    const { server, port } = await listenOnFreePort();

    const stopped = stop(port);

    expect(stopped).toBe(false);
    expect(server.listening).toBe(true);
  });

  it("getStatus() reports an occupied port without treating it as Cuttlefish", async () => {
    const { port } = await listenOnFreePort();
    writeConfigForPort(port);

    const status = getStatus();

    expect(status.running).toBe(false);
    expect(status.pid).toBe(null);
    expect(status.error).toContain(`Port ${port} is occupied`);
  });

  it("records foreground gateway ownership without clearing another process's PID", () => {
    writeGatewayPid(process.pid);
    expect(fs.readFileSync(PID_FILE, "utf8").trim()).toBe(String(process.pid));

    clearGatewayPid(process.pid + 1);
    expect(fs.existsSync(PID_FILE)).toBe(true);

    clearGatewayPid(process.pid);
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });
});
