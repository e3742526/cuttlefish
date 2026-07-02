import type { AgentModelPolicy, EngineFailureReason, GlobalModelFallbackConfig, CuttlefishConfig, ModelFallbackMode, ModelFallbackTarget, Employee } from "./types.js";
import { resolveModelEscalation, rungKey, type EscalationCandidate, type ModelLadder } from "./model-escalation.js";

export interface ModelFallbackCandidate {
  engine: string;
  model: string;
  effortLevel?: string;
  employee?: string;
  reason?: string;
  source: "agent" | "global" | "ladder";
  via: "policy" | "higher" | "sibling";
}

export interface ModelFallbackDecision {
  action: "fallback" | "ask_user" | "never" | "none";
  mode: ModelFallbackMode;
  target?: ModelFallbackCandidate;
  reason: string;
}

export interface ResolveModelFallbackOpts {
  employee?: Pick<Employee, "engine" | "model" | "modelPolicy" | "department" | "rank" | "name">;
  config: CuttlefishConfig;
  failureReason: EngineFailureReason;
  fromEngine: string;
  fromModel?: string;
  triedRungs: Set<string>;
  excludeEngines?: Set<string>;
  ladder?: ModelLadder;
  isAvailable: (engine: string, model: string) => boolean;
}

const DEFAULT_GLOBAL_CHAIN: ModelFallbackTarget[] = [
  { engine: "codex", model: "gpt-5.5", effortLevel: "high", reason: "strong cross-provider backup" },
  { engine: "claude", model: "claude-sonnet-5", effortLevel: "medium", reason: "balanced Claude backup" },
  { engine: "codex", model: "gpt-5.4", effortLevel: "high", reason: "mid-tier Codex backup" },
];

function normMode(v: unknown, fallback: ModelFallbackMode): ModelFallbackMode {
  return v === "auto" || v === "ask_user" || v === "never" ? v : fallback;
}

function triggerAllowed(policy: AgentModelPolicy | undefined, global: GlobalModelFallbackConfig | undefined, reason: EngineFailureReason): boolean {
  const agentTriggers = policy?.fallback_behavior?.triggers;
  if (Array.isArray(agentTriggers) && agentTriggers.length > 0) return agentTriggers.includes(reason);
  const g = global?.triggers;
  if (g && Object.prototype.hasOwnProperty.call(g, reason)) return g[reason] !== false;
  return ["rate_limit", "quota_exhausted", "engine_unavailable", "timeout"].includes(reason);
}

function modelForTarget(t: ModelFallbackTarget, config: CuttlefishConfig): string | undefined {
  if (typeof t.model === "string" && t.model.trim()) return t.model.trim();
  const ec = (config.engines as unknown as Record<string, { model?: string } | undefined>)[t.engine];
  return ec?.model;
}

function candidateFromTarget(t: ModelFallbackTarget, config: CuttlefishConfig, source: "agent" | "global"): ModelFallbackCandidate | undefined {
  const engine = (t.engine || "").trim();
  const model = modelForTarget(t, config);
  if (!engine || !model) return undefined;
  return { engine, model, effortLevel: t.effortLevel, employee: t.employee, reason: t.reason, source, via: "policy" };
}

function firstPolicyCandidate(opts: ResolveModelFallbackOpts, chain: ModelFallbackTarget[] | undefined, source: "agent" | "global"): ModelFallbackCandidate | undefined {
  for (const t of chain || []) {
    const c = candidateFromTarget(t, opts.config, source);
    if (!c) continue;
    if (opts.excludeEngines?.has(c.engine)) continue;
    if (opts.triedRungs.has(rungKey(c.engine, c.model))) continue;
    if (rungKey(c.engine, c.model) === rungKey(opts.fromEngine, opts.fromModel || "")) continue;
    if (!opts.isAvailable(c.engine, c.model)) continue;
    return c;
  }
  return undefined;
}

function ladderCandidate(opts: ResolveModelFallbackOpts): ModelFallbackCandidate | undefined {
  const c: EscalationCandidate | null = resolveModelEscalation({
    fromEngine: opts.fromEngine,
    fromModel: opts.fromModel,
    ladder: opts.ladder,
    triedRungs: opts.triedRungs,
    excludeEngines: opts.excludeEngines,
    isAvailable: opts.isAvailable,
  });
  if (!c) return undefined;
  return { engine: c.engine, model: c.model, source: "ladder", via: c.via };
}

export function resolveModelFallback(opts: ResolveModelFallbackOpts): ModelFallbackDecision {
  const global = opts.config.modelFallback;
  if (global?.enabled === false) return { action: "never", mode: "never", reason: "global modelFallback disabled" };
  const policy = opts.employee?.modelPolicy;
  const mode = normMode(policy?.fallback_behavior?.mode, normMode(global?.defaultMode, "auto"));
  if (mode === "never") return { action: "never", mode, reason: "fallback mode is never" };
  if (!triggerAllowed(policy, global, opts.failureReason)) {
    return { action: "none", mode, reason: "trigger " + opts.failureReason + " is not allowed" };
  }

  const agentCandidate = firstPolicyCandidate(opts, policy?.fallback_chain, "agent");
  const globalCandidate = firstPolicyCandidate(opts, global?.globalChain ?? DEFAULT_GLOBAL_CHAIN, "global");
  const target = agentCandidate ?? globalCandidate ?? ladderCandidate(opts);
  if (!target) return { action: "none", mode, reason: "no available fallback target" };
  if (mode === "ask_user") return { action: "ask_user", mode, target, reason: "approval required before fallback" };
  return { action: "fallback", mode, target, reason: "fallback target resolved" };
}
