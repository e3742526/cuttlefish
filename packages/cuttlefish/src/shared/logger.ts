import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "./paths.js";
import { redactText } from "./redact.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

let minLevel: LogLevel = "info";
let writeToStdout = true;
let logStream: fs.WriteStream | null = null;
let logFilePath: string | null = null;
let maxSizeBytes = DEFAULT_MAX_SIZE_BYTES;
let maxFiles = DEFAULT_MAX_FILES;
let loggedBytes = 0;

export function configureLogger(opts: {
  level?: string;
  stdout?: boolean;
  file?: boolean;
  maxSizeBytes?: number;
  maxFiles?: number;
}) {
  if (opts.level && opts.level in LEVELS) minLevel = opts.level as LogLevel;
  if (opts.stdout !== undefined) writeToStdout = opts.stdout;
  if (opts.maxSizeBytes !== undefined && Number.isFinite(opts.maxSizeBytes) && opts.maxSizeBytes > 0) {
    maxSizeBytes = opts.maxSizeBytes;
  }
  if (opts.maxFiles !== undefined && Number.isFinite(opts.maxFiles) && opts.maxFiles > 0) {
    maxFiles = Math.trunc(opts.maxFiles);
  }
  if (opts.file !== false) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    logFilePath = path.join(LOGS_DIR, "gateway.log");
    loggedBytes = fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0;
    logStream = fs.createWriteStream(logFilePath, { flags: "a" });
  }
}

/** Renames gateway.log -> .1, shifting .1 -> .2 .. up to maxFiles-1, dropping the oldest (REL-RES-003). */
function rotateLogFile() {
  if (!logFilePath) return;
  for (let i = maxFiles - 1; i >= 1; i--) {
    const src = i === 1 ? logFilePath : `${logFilePath}.${i - 1}`;
    const dest = `${logFilePath}.${i}`;
    if (fs.existsSync(src)) {
      fs.renameSync(src, dest);
    }
  }
  logStream = fs.createWriteStream(logFilePath, { flags: "a" });
  loggedBytes = 0;
}

function log(level: LogLevel, message: string) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  // Neutralize log-injection: embedded newlines must not forge new timestamp lines.
  // Continuation lines are tab-indented so they can never start at column 0.
  const safeMessage = redactText(message).replace(/\r\n?/g, "\n").replace(/\n/g, "\n\t");
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${safeMessage}`;
  if (writeToStdout) console.log(line);
  if (logStream) {
    const bytes = Buffer.byteLength(line) + 1;
    if (loggedBytes + bytes > maxSizeBytes) {
      logStream.end();
      rotateLogFile();
    }
    logStream!.write(line + "\n");
    loggedBytes += bytes;
  }
}

export const logger = {
  debug: (msg: string) => log("debug", msg),
  info: (msg: string) => log("info", msg),
  warn: (msg: string) => log("warn", msg),
  error: (msg: string) => log("error", msg),
};
