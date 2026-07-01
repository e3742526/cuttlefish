import fs from "node:fs";
import { spawn } from "node:child_process";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { startForeground, startDaemon, getStatus, restartDetached } from "../gateway/lifecycle.js";
import { compareSemver, getPackageVersion, getInstanceVersion } from "../shared/version.js";

const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Best-effort: open the dashboard in the default browser. Never throws. */
function openBrowser(url: string): void {
  try {
    const isWin = process.platform === "win32";
    const cmd = process.platform === "darwin" ? "open" : isWin ? "cmd" : "xdg-open";
    const args = isWin ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best-effort — never block startup on a missing opener */
  }
}

export async function runStart(opts: { daemon?: boolean; port?: number }): Promise<void> {
  if (!fs.existsSync(CUTTLEFISH_HOME)) {
    console.error(
      `Error: ${CUTTLEFISH_HOME} does not exist. Run "cuttlefish setup" first.`
    );
    process.exit(1);
  }

  const config = loadConfig();

  // Check for pending migrations
  const instanceVersion = getInstanceVersion();
  const pkgVersion = getPackageVersion();
  if (compareSemver(instanceVersion, pkgVersion) < 0) {
    console.log(
      `${YELLOW}[migrate]${RESET} Instance is at v${instanceVersion}, CLI is v${pkgVersion}. Run ${DIM}cuttlefish migrate${RESET} to update.`
    );
  }

  // Allow CLI --port to override config
  if (opts.port) {
    config.gateway.port = opts.port;
  }

  // If a gateway is already running, `start` becomes a clean restart instead of
  // the old racy double-boot (new daemon SIGTERMs the old, then races its
  // graceful shutdown into EADDRINUSE). Always hand off to the detached helper:
  // an inline foreground stop from inside a gateway session kills the PTY that is
  // running this command before it can start the replacement.
  const status = getStatus(config.gateway.port);
  if (status.error) {
    console.error(`Error: ${status.error}`);
    process.exit(1);
  }
  if (status.running) {
    restartDetached();
    console.log("Gateway already running — restarting in background.");
    return;
  }

  if (opts.daemon) {
    startDaemon(config);
    console.log("Gateway started in background.");
  } else {
    const url = `http://${config.gateway.host}:${config.gateway.port}`;
    console.log(`Starting gateway on ${config.gateway.host}:${config.gateway.port}...`);
    // Open the dashboard once the server is up. Interactive foreground only, so
    // it never fires for the detached daemon child or in CI; opt out via
    // CUTTLEFISH_NO_OPEN=1. The timer fires after startForeground yields to the loop.
    // unref so it never keeps the process alive; cleared if startup throws so we
    // don't open a browser to a gateway that failed to bind.
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    if (process.stdout.isTTY && !process.env.CUTTLEFISH_NO_OPEN) {
      openTimer = setTimeout(() => openBrowser(url), 1200);
      openTimer.unref?.();
    }
    try {
      await startForeground(config);
    } catch (err) {
      if (openTimer) clearTimeout(openTimer);
      throw err;
    }
  }
}
