import type { CuttlefishConfig } from "../shared/types.js";

export interface TurnStallWatchdogConfig {
  tickMs: number;
  leaderCheckMs: number;
  inactivityMs: number;
  hardCeilingMs: number;
  maxRetries: number;
}

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

export { positiveNumberOr };

export function resolveTurnStallWatchdogConfig(config: CuttlefishConfig): TurnStallWatchdogConfig {
  const STALL_TICK_MS = 30_000;
  const gatewayConfig = config.gateway ?? {};
  return {
    tickMs: STALL_TICK_MS,
    leaderCheckMs: positiveNumberOr(gatewayConfig.turnStallLeaderCheckMs, 4 * 60_000),
    inactivityMs: positiveNumberOr(gatewayConfig.turnStallInactivityMs, 15 * 60_000),
    hardCeilingMs: positiveNumberOr(gatewayConfig.turnStallCeilingMs, 45 * 60_000),
    maxRetries:
      typeof gatewayConfig.turnStallRetries === "number" && gatewayConfig.turnStallRetries >= 0
        ? Math.floor(gatewayConfig.turnStallRetries)
        : 0,
  };
}

export function shouldRetrySameEngineAfterStall(stallAttempt: number, maxRetries: number): boolean {
  return stallAttempt < maxRetries;
}

export function shouldNotifyLeaderReviewOnStall(input: {
  idleMs: number;
  leaderCheckMs: number;
  inactivityMs: number;
  alreadyNotified: boolean;
}): boolean {
  if (input.alreadyNotified) return false;
  if (input.leaderCheckMs <= 0) return false;
  if (input.idleMs < input.leaderCheckMs) return false;
  return input.idleMs < input.inactivityMs;
}
