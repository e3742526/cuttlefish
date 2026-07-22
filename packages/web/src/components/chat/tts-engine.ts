/**
 * Read-aloud playback engine — the real `TtsStart` for the chat TTS controller.
 *
 * Latency model: the server STREAMS one WAV frame per sentence (POST /api/tts,
 * length-prefixed frames). We start playing sentence 1 the moment it arrives while
 * 2..N are still synthesizing → time-to-first-audio ≈ one sentence, independent of
 * message length. Playback reuses the gapless sequential audio queue
 * (TalkAudioPlayer), fed binary buffers as frames decode.
 *
 * Strategy per message:
 *   1. Prime audio SYNCHRONOUSLY (resume the shared player's AudioContext) inside
 *      the click gesture — this is what lets the browser's autoplay policy permit
 *      playback after the async stream begins. (The original "stuck loading, no
 *      sound" bug was play() called outside the gesture window.)
 *   2. Strip markdown so we speak clean prose.
 *   3. Prefer Kokoro: open the streaming POST, decode each sentence frame, enqueue
 *      it on the gapless player. Availability is probed once (GET /api/tts, cached)
 *      so we pick the browser fallback WITHOUT a failed POST.
 *   4. Fall back to browser Web Speech (speechSynthesis) when Kokoro is unavailable
 *      OR the stream fails before any audio. It streams naturally.
 *
 * All browser touchpoints (fetch / AudioContext / speechSynthesis) are injected so
 * the streaming, ordering, and fallback logic is unit-testable without a DOM.
 */
import { stripMarkdown } from "@/lib/strip-markdown"
import { TalkAudioPlayer } from "@/routes/talk/audio-player"
import type { TtsStart, TtsStartCallbacks } from "./tts-controller"

/** A gapless, ordered WAV-chunk player (subset of TalkAudioPlayer we depend on). */
export interface StreamPlayer {
  enqueueBuffer(data: ArrayBuffer): void
  onStart(cb: () => void): void
  onIdle(cb: () => void): void
  reset(): void
  readonly playing: boolean
}

export interface TtsEngineDeps {
  /** Probe whether the custom (Kokoro) TTS is available. Cached by the caller. */
  checkAvailable: () => Promise<boolean>
  /** Open the streaming synth; resolve with the framed byte stream, reject on failure. */
  openStream: (text: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>
  /** Get the (reset) shared sequential player. */
  getPlayer: () => StreamPlayer
  /** Browser Web Speech fallback; returns a stop() handle. */
  speak: (text: string, cbs: TtsStartCallbacks) => () => void
  /** Synchronous gesture-time unlock (resume the shared AudioContext). */
  primeAudio?: () => void
}

const NOOP = () => {}

/**
 * Parse a length-prefixed frame stream: each frame is a 4-byte big-endian length
 * followed by that many bytes. `push` returns whatever complete frames are now
 * available; partial frames are buffered until the rest arrives. Pure (testable).
 */
export function createFrameReader(): { push: (chunk: Uint8Array) => ArrayBuffer[] } {
  let buf = new Uint8Array(0)
  return {
    push(chunk: Uint8Array): ArrayBuffer[] {
      const merged = new Uint8Array(buf.length + chunk.length)
      merged.set(buf)
      merged.set(chunk, buf.length)
      buf = merged
      const frames: ArrayBuffer[] = []
      for (;;) {
        if (buf.length < 4) break
        const len = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0
        if (buf.length < 4 + len) break
        // slice() copies into a fresh, exactly-sized buffer (safe for decodeAudioData).
        frames.push(buf.slice(4, 4 + len).buffer)
        buf = buf.slice(4 + len)
      }
      return frames
    },
  }
}

/** Build a `TtsStart` from injected playback dependencies. */
export function createTtsStart(deps: TtsEngineDeps): TtsStart {
  return async (raw, cbs) => {
    // MUST be first — runs in the click gesture's synchronous stack so the browser
    // unlocks audio for the streamed playback that begins after the fetch resolves.
    deps.primeAudio?.()

    const text = stripMarkdown(raw).trim()
    if (!text) {
      cbs.onEnd() // nothing speakable (media-/code-only message) — end cleanly
      return NOOP
    }

    let available = false
    try {
      available = await deps.checkAvailable()
    } catch {
      available = false
    }

    if (available) {
      try {
        // openStream rejects on 503 / network error → fall through to Web Speech.
        return await playKokoroStream(deps, text, cbs)
      } catch {
        /* Kokoro unavailable / connection failed at call time → browser fallback */
      }
    }

    return deps.speak(text, cbs)
  }
}

/**
 * Stream Kokoro audio: pump framed WAV chunks into the gapless player as they
 * arrive. Resolves (with a stop handle) once the stream is open; playback proceeds
 * in the background. stop() aborts the fetch — which cancels server-side synthesis
 * of the remaining sentences — and clears the queue.
 */
async function playKokoroStream(
  deps: TtsEngineDeps,
  text: string,
  cbs: TtsStartCallbacks,
): Promise<() => void> {
  const ac = new AbortController()
  const stream = await deps.openStream(text, ac.signal) // may throw → caller falls back
  const player = deps.getPlayer()

  let started = false
  let streamDone = false
  let stopped = false
  let frames = 0

  player.onStart(() => {
    if (!started && !stopped) {
      started = true
      cbs.onPlaying()
    }
  })
  player.onIdle(() => {
    if (streamDone && started && !stopped) cbs.onEnd()
  })

  // Background pump — read frames and enqueue them; never blocks the returned stop.
  void (async () => {
    const reader = stream.getReader()
    const parser = createFrameReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) for (const wav of parser.push(value)) {
          frames++
          player.enqueueBuffer(wav)
        }
      }
    } catch {
      /* aborted (pause) or network drop — fall through to settle below */
    } finally {
      streamDone = true
      if (!stopped) {
        if (frames === 0) {
          cbs.onError() // produced no audio at all → controller resets to idle
        } else if (started && !player.playing) {
          cbs.onEnd() // already drained before the stream finished reading
        }
        // else: onIdle will fire onEnd when the queue drains
      }
    }
  })()

  return () => {
    stopped = true
    ac.abort() // cancels in-flight server synthesis of the remaining sentences
    player.reset()
  }
}

/* ── Default browser-backed dependencies ─────────────────────────────────── */

let availabilityPromise: Promise<boolean> | null = null

/** GET /api/tts once and cache the answer for the page lifetime. */
function checkAvailable(): Promise<boolean> {
  if (!availabilityPromise) {
    availabilityPromise = fetch("/api/tts")
      .then((r) => (r.ok ? (r.json() as Promise<{ available?: boolean }>) : { available: false }))
      .then((d) => !!d.available)
      .catch(() => false)
  }
  return availabilityPromise
}

async function openStream(text: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  })
  if (!r.ok || !r.body) throw new Error(`tts ${r.status}`)
  return r.body
}

/* One shared player so priming on the click unlocks playback for every message. */
let sharedPlayer: TalkAudioPlayer | null = null

function getPlayerInstance(): TalkAudioPlayer | null {
  if (typeof window === "undefined") return null
  const hasAudio =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!hasAudio) return null
  if (!sharedPlayer) sharedPlayer = new TalkAudioPlayer()
  return sharedPlayer
}

/** Resume the player's AudioContext from within the user gesture (autoplay unlock). */
function primeAudio(): void {
  getPlayerInstance()?.resume()
}

function getPlayer(): StreamPlayer {
  const p = getPlayerInstance()
  if (!p) throw new Error("AudioContext unavailable") // → caller falls back to Web Speech
  p.reset() // clear any prior message's queue (single-active)
  return p
}

function speak(text: string, { onPlaying, onEnd, onError }: TtsStartCallbacks): () => void {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    onError()
    return NOOP
  }
  const utt = new SpeechSynthesisUtterance(text)
  utt.onstart = () => onPlaying()
  utt.onend = () => onEnd()
  utt.onerror = () => onError()
  synth.cancel() // clear any queued/leftover speech first
  synth.speak(utt)
  return () => {
    // cancel() may fire a late onend/onerror — the controller's generation guard
    // ignores those, so stop() is safe to call here.
    synth.cancel()
  }
}

/** Production dependencies (browser fetch + shared AudioContext player + Web Speech). */
export function defaultTtsDeps(): TtsEngineDeps {
  return { checkAvailable, openStream, getPlayer, speak, primeAudio }
}
