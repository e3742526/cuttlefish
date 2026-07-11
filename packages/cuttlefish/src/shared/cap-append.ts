/**
 * Bounded string accumulation for long-running engine turns.
 *
 * Engine adapters accumulate subprocess/model output for the duration of a turn
 * (the authoritative result text, and the JSONL line buffer used to frame stdout).
 * Without a cap a hostile or runaway engine — or one that never emits a line
 * terminator — grows these buffers without bound and can exhaust the daemon's
 * heap (AR-09). `capAppend` keeps only the most-recent `max` characters (the
 * tail, where an engine's final answer text and its latest JSONL line live),
 * mirroring the rolling-window discipline already used for stderr.
 */

/** 2 MiB rolling window for accumulated result/stdout text. */
export const ENGINE_OUTPUT_MAX = 2 * 1024 * 1024;

/** 2 MiB cap on a single unterminated stdout/JSONL line buffer. */
export const ENGINE_LINE_BUF_MAX = 2 * 1024 * 1024;

/**
 * Append `chunk` to `base`, retaining at most `max` characters from the end. When
 * the combined length exceeds `max` the oldest characters are dropped so growth
 * is bounded regardless of how much output arrives.
 */
export function capAppend(base: string, chunk: string, max: number): string {
  const next = base + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}
