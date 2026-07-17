import type { Allocation, Lease, TelemetryEvent } from "./types.js";

export const DEFAULT_TERMINAL_ALLOCATION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TERMINAL_ALLOCATION_LIMIT = 1_000;
export const DEFAULT_SCHEDULER_TELEMETRY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SCHEDULER_TELEMETRY_LIMIT = 2_000;

export interface SchedulerRetentionOptions {
  terminalAllocationRetentionMs?: number;
  terminalAllocationLimit?: number;
  telemetryRetentionMs?: number;
  telemetryEventLimit?: number;
}

export interface ResolvedSchedulerRetentionOptions {
  terminalAllocationRetentionMs: number;
  terminalAllocationLimit: number;
  telemetryRetentionMs: number;
  telemetryEventLimit: number;
}

export function resolveSchedulerRetentionOptions(opts: SchedulerRetentionOptions = {}): ResolvedSchedulerRetentionOptions {
  return {
    terminalAllocationRetentionMs: nonNegativeInteger(opts.terminalAllocationRetentionMs, DEFAULT_TERMINAL_ALLOCATION_RETENTION_MS),
    terminalAllocationLimit: nonNegativeInteger(opts.terminalAllocationLimit, DEFAULT_TERMINAL_ALLOCATION_LIMIT),
    telemetryRetentionMs: nonNegativeInteger(opts.telemetryRetentionMs, DEFAULT_SCHEDULER_TELEMETRY_RETENTION_MS),
    telemetryEventLimit: nonNegativeInteger(opts.telemetryEventLimit, DEFAULT_SCHEDULER_TELEMETRY_LIMIT),
  };
}

export function refreshAllocationLifecycle(
  allocation: Allocation,
  leasesById: Map<string, Lease>,
  updatedAt: string,
): boolean {
  const leases = allocation.leases.map((lease) => leasesById.get(lease.leaseId) ?? lease);
  const nextState = deriveAllocationState(leases);
  const changed = nextState !== allocation.state || leases.some((lease, index) => lease !== allocation.leases[index]);
  if (!changed) return false;
  allocation.state = nextState;
  allocation.leases = leases;
  allocation.updatedAt = updatedAt;
  return true;
}

export function pruneTerminalAllocations(
  allocations: Map<string, Allocation>,
  now: Date,
  opts: ResolvedSchedulerRetentionOptions,
): void {
  const terminal = [...allocations.values()]
    .filter((allocation) => allocation.state === "completed" || allocation.state === "expired")
    .sort(compareNewestAllocationFirst);
  const newestKept = new Set(terminal.slice(0, opts.terminalAllocationLimit).map((allocation) => allocation.allocationId));
  const cutoff = now.getTime() - opts.terminalAllocationRetentionMs;

  for (const allocation of terminal) {
    const updatedAt = Date.parse(allocation.updatedAt || allocation.createdAt);
    const overLimit = !newestKept.has(allocation.allocationId);
    const tooOld = Number.isFinite(updatedAt) && updatedAt < cutoff;
    if (overLimit || tooOld) allocations.delete(allocation.allocationId);
  }
}

export function pruneTerminalLeases(
  leases: Map<string, Lease>,
  allocations: Map<string, Allocation>,
  now: Date,
  opts: ResolvedSchedulerRetentionOptions,
): void {
  const referencedLeaseIds = new Set<string>();
  for (const allocation of allocations.values()) {
    for (const lease of allocation.leases) referencedLeaseIds.add(lease.leaseId);
  }

  const terminal = [...leases.values()]
    .filter((lease) => (lease.state === "released" || lease.state === "expired") && !referencedLeaseIds.has(lease.leaseId))
    .sort(compareNewestLeaseFirst);
  const newestKept = new Set(terminal.slice(0, opts.terminalAllocationLimit).map((lease) => lease.leaseId));
  const cutoff = now.getTime() - opts.terminalAllocationRetentionMs;

  for (const lease of terminal) {
    const updatedAt = Date.parse(lease.heartbeatAt || lease.startedAt);
    const overLimit = !newestKept.has(lease.leaseId);
    const tooOld = Number.isFinite(updatedAt) && updatedAt < cutoff;
    if (overLimit || tooOld) leases.delete(lease.leaseId);
  }
}

export function pruneSchedulerTelemetry(
  telemetry: TelemetryEvent[],
  now: Date,
  opts: ResolvedSchedulerRetentionOptions,
): void {
  const cutoff = now.getTime() - opts.telemetryRetentionMs;
  for (let index = telemetry.length - 1; index >= 0; index -= 1) {
    const timestamp = Date.parse(telemetry[index].timestamp);
    if (Number.isFinite(timestamp) && timestamp < cutoff) telemetry.splice(index, 1);
  }
  if (telemetry.length <= opts.telemetryEventLimit) return;
  telemetry.sort(compareOldestTelemetryFirst);
  telemetry.splice(0, telemetry.length - opts.telemetryEventLimit);
}

function deriveAllocationState(leases: Lease[]): Allocation["state"] {
  if (leases.some((lease) => lease.state === "running")) return "allocated";
  if (leases.some((lease) => lease.state === "expired")) return "expired";
  return "completed";
}

function compareNewestAllocationFirst(a: Allocation, b: Allocation): number {
  const time = Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt);
  if (time !== 0) return time;
  return b.allocationId.localeCompare(a.allocationId);
}

function compareNewestLeaseFirst(a: Lease, b: Lease): number {
  const time = Date.parse(b.heartbeatAt || b.startedAt) - Date.parse(a.heartbeatAt || a.startedAt);
  if (time !== 0) return time;
  return b.leaseId.localeCompare(a.leaseId);
}

function compareOldestTelemetryFirst(a: TelemetryEvent, b: TelemetryEvent): number {
  const time = Date.parse(a.timestamp) - Date.parse(b.timestamp);
  if (time !== 0) return time;
  return a.eventId.localeCompare(b.eventId);
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}
