/**
 * Model escalation routing.
 *
 * When a delegated worker stalls or its engine runs out of usage, retrying the
 * same model cannot help — the model/engine is the bottleneck. Escalation moves
 * the slice UP a capability ladder to a stronger model (often on a different
 * provider) before the work is escalated to a human:
 *
 *   small  (haiku / gemini-flash / qwen / gpt-mini)
 *     → mid   (gpt-5.4 / sonnet)
 *       → large (gpt-5.5 / opus / gemini-pro)
 *
 * Pure resolver (no I/O) so it is exhaustively unit-testable; the caller supplies
 * availability and performs the re-dispatch. The ladder is overridable via config
 * (`sessions.modelLadder`) because model ids churn.
 */

export interface ModelRung {
  engine: string;
  model: string;
}

/** Ordered tiers, lowest capability first. Each tier holds interchangeable rungs. */
export type ModelLadder = ModelRung[][];

export interface EscalationCandidate extends ModelRung {
  /** "higher" = a stronger tier; "sibling" = same tier, different engine (last resort). */
  via: "higher" | "sibling";
}

export interface ResolveEscalationOpts {
  fromEngine: string;
  /** Current model; undefined/unknown is treated as the lowest tier so it climbs. */
  fromModel?: string;
  /** Override ladder; defaults to DEFAULT_MODEL_LADDER. */
  ladder?: ModelLadder;
  /** Rungs already attempted ("engine::model" via rungKey), including the current. */
  triedRungs: Set<string>;
  /** Engines to avoid entirely (e.g. the one that is rate-limited). */
  excludeEngines?: Set<string>;
  /** Caller gate: is this engine installed AND wired into the gateway? */
  isAvailable: (engine: string, model: string) => boolean;
}

/**
 * Default cross-provider capability ladder for the current org. Tune via
 * `config.sessions.modelLadder` as model ids change. Within a tier, earlier
 * entries are preferred when escalating into it.
 */
export const DEFAULT_MODEL_LADDER: ModelLadder = [
  // Tier 0 — small / cheap / fast
  [
    { engine: "claude", model: "claude-haiku-4-5" },
    { engine: "antigravity", model: "Gemini 3.5 Flash (High)" },
    { engine: "pi", model: "purdue/qwen3-coder:latest" },
    { engine: "codex", model: "gpt-5.4-mini" },
    { engine: "codex", model: "gpt-5.3-codex-spark" },
  ],
  // Tier 1 — mid / balanced
  [
    { engine: "codex", model: "gpt-5.4" },
    { engine: "claude", model: "claude-sonnet-5" },
  ],
  // Tier 2 — large / most capable
  [
    { engine: "codex", model: "gpt-5.5" },
    { engine: "claude", model: "opus" },
    { engine: "antigravity", model: "Gemini 3.1 Pro (High)" },
  ],
];

const norm = (s: string) => s.trim().toLowerCase();

/** Stable identity for a rung; used to dedupe across escalation attempts. */
export function rungKey(engine: string, model: string): string {
  return `${norm(engine)}::${norm(model)}`;
}

/** Tier index of (engine, model) in the ladder, or -1 if not present. */
function findTier(ladder: ModelLadder, engine: string, model: string): number {
  const e = norm(engine);
  const m = norm(model);
  for (let t = 0; t < ladder.length; t++) {
    if (ladder[t].some((r) => norm(r.engine) === e && norm(r.model) === m)) return t;
  }
  return -1;
}

/**
 * Pick the next-higher model to escalate to, or null if nothing higher is
 * available. Candidates are: every rung in strictly-higher tiers (ascending),
 * then — only as a last resort — same-tier rungs on a different engine (so a
 * top-tier worker whose engine is exhausted can still move sideways once).
 */
export function resolveModelEscalation(opts: ResolveEscalationOpts): EscalationCandidate | null {
  const ladder = opts.ladder?.length ? opts.ladder : DEFAULT_MODEL_LADDER;
  const fromModel = opts.fromModel ?? "";
  const tier = fromModel ? findTier(ladder, opts.fromEngine, fromModel) : -1;
  // Unknown current model → treat as tier 0 so we climb into tier 1+, never down
  // into the cheap tier.
  const baseTier = tier >= 0 ? tier : 0;

  const candidates: EscalationCandidate[] = [];
  for (let t = baseTier + 1; t < ladder.length; t++) {
    for (const rung of ladder[t]) candidates.push({ ...rung, via: "higher" });
  }
  // Same-tier siblings (different engine) only when we actually know the current
  // tier — handles engine exhaustion at the top of the ladder.
  if (tier >= 0) {
    for (const rung of ladder[tier]) candidates.push({ ...rung, via: "sibling" });
  }

  const curKey = rungKey(opts.fromEngine, fromModel);
  for (const c of candidates) {
    const key = rungKey(c.engine, c.model);
    if (key === curKey) continue;
    if (opts.triedRungs.has(key)) continue;
    if (opts.excludeEngines?.has(c.engine)) continue;
    if (!opts.isAvailable(c.engine, c.model)) continue;
    return c;
  }
  return null;
}
