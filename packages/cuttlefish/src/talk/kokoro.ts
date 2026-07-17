/**
 * Cuttlefish Talk — Kokoro-82M TTS engine (Phase 2 voice loop).
 *
 * Implements the `Tts` interface from ./context.js. Mirrors the STT sidecar
 * pattern (src/stt/stt.ts): weights live under CUTTLEFISH_HOME/models/kokoro, a Python
 * venv hosts a long-running HTTP sidecar (kokoro_sidecar.py) that wraps
 * `kokoro-onnx`, and this module owns the sidecar's lifecycle (spawn / health /
 * restart / shutdown).
 *
 * speak() sentence-chunks the text and streams ordered talk:audio events so the
 * frontend can play chunks as they arrive. Everything is defensive: if Python,
 * the venv, or the weights are missing, status().available is false and speak()
 * rejects gracefully so the loop degrades to the frontend's Web Speech fallback.
 */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { CUTTLEFISH_HOME } from "../shared/paths.js"
import { logger } from "../shared/logger.js"
import { safeRmSync } from "../shared/safe-delete.js"
import { assertFileIntegrity } from "../shared/file-integrity.js"
import { readResponseBuffer, readResponseJson } from "../shared/fetch-response.js"
import { TALK_EVENTS, type Emit, type Tts } from "./protocol.js"

/** Model / venv layout under CUTTLEFISH_HOME. */
const KOKORO_DIR = path.join(CUTTLEFISH_HOME, "models", "kokoro")
const VENV_PYTHON = path.join(KOKORO_DIR, "venv", "bin", "python")
const ONNX_FILE = path.join(KOKORO_DIR, "kokoro-v1.0.onnx")
const VOICES_FILE = path.join(KOKORO_DIR, "voices-v1.0.bin")

/** kokoro-onnx official release assets. */
const RELEASE_BASE =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
const DOWNLOADS: Array<{ url: string; filename: string; size: number; sha256: string }> = [
  { url: `${RELEASE_BASE}/kokoro-v1.0.onnx`, filename: "kokoro-v1.0.onnx", size: 325_532_387, sha256: "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5" },
  { url: `${RELEASE_BASE}/voices-v1.0.bin`, filename: "voices-v1.0.bin", size: 28_214_398, sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d" },
]

export function resolveKokoroDownloadAssets(modelDir: string): Array<{ url: string; filename: string; dest: string; size: number; sha256: string }> {
  return DOWNLOADS.map((asset) => ({ ...asset, dest: path.join(modelDir, asset.filename) }));
}

const DEFAULT_VOICE = "af_heart"
const DEFAULT_PORT = 8765
const HEALTH_TIMEOUT_MS = 60_000 // model load is lazy + heavy on first synth
const SYNTH_TIMEOUT_MS = 120_000
const MAX_SYNTH_RESPONSE_BYTES = 256 * 1024 * 1024
const MAX_SYNTH_ERROR_BYTES = 64 * 1024

interface HealthResponse {
  ok: boolean
  ready: boolean
}

/** Resolve the sidecar .py path: next to this module, then a src/ fallback. */
function resolveSidecarPath(): string {
  const here = fileURLToPath(import.meta.url)
  const sameDir = path.join(path.dirname(here), "kokoro_sidecar.py")
  if (fs.existsSync(sameDir)) return sameDir
  // Running from dist before the lead's build copies the .py — fall back to src.
  const srcPath = here.replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`)
  if (srcPath !== here) {
    const candidate = srcPath.replace(/kokoro\.(js|ts)$/, "kokoro_sidecar.py")
    if (fs.existsSync(candidate)) return candidate
  }
  return sameDir // best effort; spawn will surface ENOENT
}

/** Pick a free localhost TCP port (used when no explicit port is configured). */
function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once("error", () => resolve(preferred)) // fall back to preferred on bind error
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : preferred
      srv.close(() => resolve(port))
    })
  })
}

export function createKokoroTts(opts?: {
  voice?: string
  modelDir?: string
  sidecarPort?: number
}): Tts {
  const voice = opts?.voice || DEFAULT_VOICE
  const modelDir = opts?.modelDir || KOKORO_DIR
  const onnxFile = modelDir === KOKORO_DIR ? ONNX_FILE : path.join(modelDir, "kokoro-v1.0.onnx")
  const voicesFile = modelDir === KOKORO_DIR ? VOICES_FILE : path.join(modelDir, "voices-v1.0.bin")
  const pythonBin =
    modelDir === KOKORO_DIR ? VENV_PYTHON : path.join(modelDir, "venv", "bin", "python")

  let child: ChildProcess | null = null
  let port = 0
  let starting: Promise<void> | null = null
  let ready = false // last-known sidecar /health "ready" (model loaded)
  let downloading = false
  let downloadProgress = 0
  let weightsVerified = false
  const downloads = resolveKokoroDownloadAssets(modelDir)

  /** Are the on-disk weights present? */
  function weightsPresent(): boolean {
    const sizes = new Map(downloads.map((asset) => [asset.dest, asset.size]))
    return [onnxFile, voicesFile].every((file) => {
      const stat = fs.statSync(file, {
        throwIfNoEntry: false,
      } as fs.StatSyncOptions & { throwIfNoEntry: false })
      return stat?.isFile() && stat.size === sizes.get(file)
    })
  }

  async function verifyWeights(): Promise<void> {
    if (weightsVerified) return
    for (const asset of downloads) {
      await assertFileIntegrity(asset.dest, {
        size: asset.size,
        sha256: asset.sha256,
        label: asset.filename,
      })
    }
    weightsVerified = true
  }

  /**
   * Is the venv python runnable? `fs.existsSync` follows symlinks, so a DANGLING
   * symlink (e.g. the base Homebrew python was upgraded/removed out from under
   * the venv) correctly reports false → ensureVenv() rebuilds on the next
   * download(). We additionally surface the broken-symlink case with a warning
   * so a silent python upgrade doesn't quietly strand us on the fallback voice.
   */
  function pythonPresent(): boolean {
    if (fs.existsSync(pythonBin)) return true
    const lst = fs.lstatSync(pythonBin, {
      throwIfNoEntry: false,
    } as fs.StatSyncOptions & { throwIfNoEntry: false })
    if (lst && lst.isSymbolicLink()) {
      logger.warn(
        `[kokoro] venv python is a broken symlink (${pythonBin}) — its base interpreter is gone; the venv will be rebuilt on next download()`,
      )
    }
    return false
  }

  async function httpGetHealth(p: number): Promise<HealthResponse | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (!res.ok) return null
      return (await res.json()) as HealthResponse
    } catch {
      return null
    }
  }

  /** Spawn the sidecar and wait until /health answers. Idempotent per failure. */
  async function ensureSidecar(): Promise<void> {
    // Already alive?
    if (child && child.exitCode === null && port) {
      const h = await httpGetHealth(port)
      if (h?.ok) {
        ready = h.ready
        return
      }
    }
    if (starting) return starting

    starting = (async () => {
      if (!pythonPresent()) {
        throw new Error(`Kokoro venv python missing at ${pythonBin} — run download() first`)
      }
      if (!weightsPresent()) {
        throw new Error(`Kokoro weights missing in ${modelDir} — run download() first`)
      }
      await verifyWeights()

      const chosen = opts?.sidecarPort || (await findFreePort(DEFAULT_PORT))
      const sidecar = resolveSidecarPath()

      const proc = spawn(
        pythonBin,
        [sidecar, "--port", String(chosen), "--model-dir", modelDir, "--voice", voice],
        { stdio: ["ignore", "pipe", "pipe"] },
      )

      let listening = false
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!listening) {
            // A slow sidecar may still finish importing and bind its port
            // after we give up — without this kill there would be no handle
            // left to reap it (child is only assigned after this promise).
            try { proc.kill("SIGKILL") } catch { /* already gone */ }
            reject(new Error("Kokoro sidecar did not start in time"))
          }
        }, 20_000)

        proc.stdout?.on("data", (buf: Buffer) => {
          const line = buf.toString()
          if (line.includes("KOKORO_SIDECAR_LISTENING")) {
            listening = true
            clearTimeout(timer)
            resolve()
          }
        })
        proc.stderr?.on("data", (buf: Buffer) => {
          logger.debug(`[kokoro] ${buf.toString().trim()}`)
        })
        proc.on("error", (err) => {
          clearTimeout(timer)
          reject(err)
        })
        proc.on("exit", (code) => {
          if (!listening) {
            clearTimeout(timer)
            reject(new Error(`Kokoro sidecar exited early (code ${code})`))
          }
        })
      })

      // Reset liveness flags whenever the process dies so the next call respawns.
      proc.on("exit", (code, signal) => {
        logger.warn(`[kokoro] sidecar exited (code=${code} signal=${signal})`)
        if (child === proc) {
          child = null
          port = 0
          ready = false
        }
      })

      child = proc
      port = chosen
      const h = await httpGetHealth(chosen)
      ready = h?.ready ?? false
      logger.info(`[kokoro] sidecar listening on 127.0.0.1:${chosen} (voice=${voice})`)
    })()

    try {
      await starting
    } finally {
      starting = null
    }
  }

  /**
   * POST one sentence to /synth. The sidecar can die between ensureSidecar's
   * liveness check and the request (or mid-request) — if the failure coincides
   * with a dead/absent child, reset state and retry the spawn once.
   */
  async function synth(text: string): Promise<Buffer> {
    try {
      return await synthOnce(text)
    } catch (err) {
      if (child && child.exitCode === null) throw err // sidecar alive — a real synth error
      logger.warn(
        `[kokoro] synth failed with sidecar dead — respawning once (${err instanceof Error ? err.message : err})`,
      )
      child = null
      port = 0
      ready = false
      return synthOnce(text)
    }
  }

  async function synthOnce(text: string): Promise<Buffer> {
    await ensureSidecar()
    if (!port) throw new Error("Kokoro sidecar not available")
    const res = await fetch(`http://127.0.0.1:${port}/synth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
    })
    if (!res.ok) {
      let detail = ""
      try {
        detail = (await readResponseJson<{ error?: string }>(res, MAX_SYNTH_ERROR_BYTES)).error || ""
      } catch {
        /* non-json error body */
      }
      throw new Error(`Kokoro synth failed (${res.status})${detail ? `: ${detail}` : ""}`)
    }
    ready = true // a successful synth means the model is loaded
    return readResponseBuffer(res, MAX_SYNTH_RESPONSE_BYTES)
  }

  /**
   * Split text into sentence-sized chunks for low-latency, ordered playback.
   * Keeps the terminal punctuation; collapses whitespace; drops empties.
   */
  function splitSentences(text: string): string[] {
    const parts = text
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    return parts.length > 0 ? parts : []
  }

  return {
    async speak(sessionId: string, text: string, emit: Emit, opts?: { seqStart?: number; final?: boolean }): Promise<number> {
      const sentences = splitSentences(text)
      if (sentences.length === 0) return 0

      // Fail fast & gracefully if the engine can't run at all.
      if (!pythonPresent() || !weightsPresent()) {
        throw new Error(
          "Kokoro TTS unavailable (missing venv or weights) — falling back to Web Speech",
        )
      }

      let seq = opts?.seqStart ?? 0
      const markLast = opts?.final !== false
      for (let i = 0; i < sentences.length; i++) {
        const wav = await synth(sentences[i]!)
        const last = markLast && i === sentences.length - 1
        emit(TALK_EVENTS.audio, {
          sessionId,
          seq: seq++,
          mime: "audio/wav",
          dataBase64: wav.toString("base64"),
          last,
        })
      }
      return sentences.length
    },

    async synthesize(text: string): Promise<Buffer> {
      // Fail fast & gracefully if the engine can't run at all (the route turns
      // this into a 503 {available:false} so the client falls back to Web Speech).
      if (!pythonPresent() || !weightsPresent()) {
        throw new Error(
          "Kokoro TTS unavailable (missing venv or weights) — falling back to Web Speech",
        )
      }
      const clean = text.replace(/\s+/g, " ").trim()
      if (!clean) throw new Error("Kokoro synthesize: empty text")
      // The kokoro-onnx sidecar handles arbitrary-length text in one /synth call,
      // returning a single valid WAV — no per-sentence concatenation needed.
      return synth(clean)
    },

    async warm(): Promise<void> {
      // Nothing to warm if the engine can't run; speak() will surface the error.
      if (!pythonPresent() || !weightsPresent()) return
      try {
        // One throwaway synth spawns the sidecar AND forces the heavy model load
        // so the user's first real sentence doesn't pay it. Audio is discarded.
        await synth(".")
      } catch (err) {
        logger.debug(`[kokoro] warm failed: ${err instanceof Error ? err.message : err}`)
      }
    },

    status() {
      return {
        available: pythonPresent() && weightsPresent(),
        downloading,
        progress: downloadProgress,
        voice,
        ready: ready && child !== null && child.exitCode === null,
      }
    },

    async download(emit: Emit): Promise<void> {
      if (downloading) return
      downloading = true
      downloadProgress = 0
      try {
        fs.mkdirSync(modelDir, { recursive: true })

        // 1. Ensure the venv + python deps exist (kokoro-onnx + onnxruntime + soundfile + numpy).
        if (!pythonPresent()) {
          await ensureVenv(modelDir)
        }

        // 2. Fetch the onnx weights + voices if absent, reporting growth as progress.
        const totalBytes = downloads.reduce((n, d) => n + d.size, 0)
        let basePrior = 0
        for (const d of downloads) {
          if (fs.existsSync(d.dest)) {
            try {
              await assertFileIntegrity(d.dest, { size: d.size, sha256: d.sha256, label: d.filename })
              basePrior += d.size
              downloadProgress = Math.min(99, Math.round((basePrior / totalBytes) * 100))
              emit(TALK_EVENTS.ttsDownloadProgress, { progress: downloadProgress })
              continue
            } catch (err) {
              logger.warn(`[kokoro] existing ${d.filename} failed integrity verification and will be replaced: ${err instanceof Error ? err.message : err}`)
              try { fs.unlinkSync(d.dest) } catch { /* curl will surface a remaining conflict */ }
            }
          }
          await curlDownload(d.url, d.dest, d.size, d.sha256, (bytes) => {
            downloadProgress = Math.min(
              99,
              Math.round(((basePrior + Math.min(bytes, d.size)) / totalBytes) * 100),
            )
            emit(TALK_EVENTS.ttsDownloadProgress, { progress: downloadProgress })
          })
          basePrior += d.size
        }

        weightsVerified = true
        downloadProgress = 100
        emit(TALK_EVENTS.ttsDownloadProgress, { progress: 100 })
        emit(TALK_EVENTS.ttsDownloadComplete, {})
        logger.info(`[kokoro] weights ready in ${modelDir}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emit(TALK_EVENTS.ttsDownloadError, { error: message })
        logger.error(`[kokoro] download failed: ${message}`)
        throw err
      } finally {
        downloading = false
      }
    },

    shutdown(): void {
      if (child && child.exitCode === null) {
        const proc = child
        try {
          proc.kill("SIGTERM")
        } catch {
          /* already gone */
        }
        // Escalate: a sidecar wedged in native code can ignore SIGTERM.
        const force = setTimeout(() => {
          if (proc.exitCode === null) {
            try { proc.kill("SIGKILL") } catch { /* already gone */ }
          }
        }, 2_000)
        force.unref?.()
      }
      child = null
      port = 0
      ready = false
    },
  }
}

/**
 * Pick the newest available base Python for the venv. Prefer a modern, wheel-rich
 * interpreter (kokoro-onnx/onnxruntime want >=3.10); fall back to bare `python3`.
 * This is what makes a rebuild survive a Homebrew python churn (e.g. 3.13 removed).
 */
function pickVenvPython(): string {
  for (const c of ["python3.12", "python3.11", "python3.13", "python3.10", "python3"]) {
    const r = spawnSync(c, ["--version"], { stdio: "ignore" })
    if (r.status === 0) return c
  }
  return "python3"
}

/** Create the venv and install the Python deps for the sidecar. */
function ensureVenv(modelDir: string): Promise<void> {
  const venvDir = path.join(modelDir, "venv")
  const py = path.join(venvDir, "bin", "python")
  // Always rebuild from scratch: `python3 -m venv` does NOT reliably repair a
  // venv whose base interpreter was removed (dangling bin/python symlink), so a
  // stale dir would otherwise wedge us on the fallback voice forever.
  try {
    safeRmSync(venvDir, { within: modelDir, label: "kokoro venv" })
  } catch {
    /* ignore */
  }
  const basePython = pickVenvPython()
  return new Promise<void>((resolve, reject) => {
    const make = spawn(basePython, ["-m", "venv", venvDir], { stdio: "ignore" })
    make.on("error", reject)
    make.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`venv creation failed (code ${code})`))
      const pip = spawn(
        py,
        [
          "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
          "kokoro-onnx==0.5.0",
          "onnxruntime==1.22.1",
          "numpy==2.2.6",
          "espeakng-loader==0.2.4",
          "phonemizer-fork==3.3.2",
        ],
        { stdio: "ignore" },
      )
      pip.on("error", reject)
      pip.on("exit", (pcode) =>
        pcode === 0 ? resolve() : reject(new Error(`pip install failed (code ${pcode})`)),
      )
    })
  })
}

/** Download a URL to dest via curl, polling file size for progress. */
function curlDownload(
  url: string,
  dest: string,
  expectedSize: number,
  expectedSha256: string,
  onBytes: (bytes: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tmp = `${dest}.downloading`
    // --speed-limit/--speed-time abort a stalled transfer (<1KB/s for 60s)
    // instead of holding the download promise (and its 1s progress poll) open
    // forever; --connect-timeout bounds a dead host.
    const curl = spawn("curl", [
      "-L", "--fail",
      "--proto", "=https",
      "--tlsv1.2",
      "--connect-timeout", "30",
      "--speed-limit", "1024", "--speed-time", "60",
      "-o", tmp, url,
    ])

    const poll = setInterval(() => {
      try {
        const st = fs.statSync(tmp, {
          throwIfNoEntry: false,
        } as fs.StatSyncOptions & { throwIfNoEntry: false })
        if (st && st.size > 0) onBytes(st.size as number)
      } catch {
        /* not created yet */
      }
    }, 1_000)

    curl.on("error", (err) => {
      clearInterval(poll)
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      reject(err)
    })
    curl.on("exit", async (code) => {
      clearInterval(poll)
      if (code === 0) {
        try {
          await assertFileIntegrity(tmp, {
            size: expectedSize,
            sha256: expectedSha256,
            label: path.basename(dest),
          })
          fs.renameSync(tmp, dest)
          resolve()
        } catch (err) {
          try {
            fs.unlinkSync(tmp)
          } catch {
            /* ignore */
          }
          reject(err as Error)
        }
      } else {
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* ignore */
        }
        reject(new Error(`curl exited with code ${code} for ${url}`))
      }
    })
  })
}
