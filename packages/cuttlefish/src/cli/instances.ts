import fs from "node:fs";
import path from "node:path";
import { INSTANCES_REGISTRY } from "../shared/paths.js";
import { safeWriteFile } from "../shared/safe-write.js";
import { assertSafeDestructivePath } from "../shared/safe-delete.js";
import { homeForInstance } from "../shared/instance-home.js";

export interface Instance {
  name: string;
  port: number;
  home: string;
  createdAt: string;
}

export function loadInstances(): Instance[] {
  if (!fs.existsSync(INSTANCES_REGISTRY)) return [];
  try {
    return JSON.parse(fs.readFileSync(INSTANCES_REGISTRY, "utf-8"));
  } catch {
    return [];
  }
}

export function saveInstances(instances: Instance[]): void {
  fs.mkdirSync(path.dirname(INSTANCES_REGISTRY), { recursive: true });
  safeWriteFile(INSTANCES_REGISTRY, JSON.stringify(instances, null, 2) + "\n", {
    audit: { actor: "cli", op: "instances.save" },
  });
}

export function assertSafeDestructiveHome(home: string, label = "Cuttlefish home"): string {
  return assertSafeDestructivePath(home, { label });
}

export function assertSafeManagedInstanceHome(instance: Instance): string {
  const resolved = assertSafeDestructiveHome(instance.home, `Instance "${instance.name}" home`);
  const expected = homeForInstance(instance.name);
  if (resolved !== path.resolve(expected)) {
    throw new Error(`Instance "${instance.name}" home is outside its managed path: ${resolved}`);
  }
  return resolved;
}

/** Ensure the default "cuttlefish" instance is registered, optionally refreshing its active port. */
export function ensureDefaultInstance(port?: number): void {
  const instances = loadInstances();
  const canonicalHome = homeForInstance("cuttlefish");
  const existing = instances.find((i) => i.name === "cuttlefish");
  if (existing) {
    // The registry lives at the OS-default home for backwards compatibility,
    // while CUTTLEFISH_HOME is resolved per invocation. Refresh an old entry
    // so `list` does not keep reporting a previous/default instance after the
    // operator selects a custom home. Only start has an authoritative active
    // port; list must retain the port already recorded by start.
    if (existing.home !== canonicalHome || (port !== undefined && existing.port !== port)) {
      existing.home = canonicalHome;
      if (port !== undefined) existing.port = port;
      saveInstances(instances);
    }
    return;
  }
  instances.unshift({
    name: "cuttlefish",
    port: port ?? 8888,
    home: canonicalHome,
    createdAt: new Date().toISOString(),
  });
  saveInstances(instances);
}

export function findInstance(name: string): Instance | undefined {
  return loadInstances().find((i) => i.name === name);
}
