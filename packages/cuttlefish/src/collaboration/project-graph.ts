import type { ProjectIntegrity } from "@cuttlefish/contracts";

export interface ProjectSessionLike {
  id: string;
  parentSessionId?: string | null;
  lastActivity?: string;
}

export interface ProjectGraphNode<T extends ProjectSessionLike> {
  session: T;
  depth: number;
  children: ProjectGraphNode<T>[];
}

export interface ProjectGraphEntry<T extends ProjectSessionLike> {
  rootSessionId: string;
  integrity: ProjectIntegrity;
  sessions: T[];
  tree: ProjectGraphNode<T>[];
}

interface RootResolution {
  rootSessionId: string;
  integrity: ProjectIntegrity;
}

function newestFirst(a: ProjectSessionLike, b: ProjectSessionLike): number {
  const byActivity = String(b.lastActivity ?? "").localeCompare(String(a.lastActivity ?? ""));
  return byActivity || a.id.localeCompare(b.id);
}

export function buildProjectGraph<T extends ProjectSessionLike>(sessions: readonly T[]): {
  projects: ProjectGraphEntry<T>[];
  projectBySessionId: Map<string, ProjectGraphEntry<T>>;
} {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const cache = new Map<string, RootResolution>();

  const resolveRoot = (startId: string): RootResolution => {
    const cached = cache.get(startId);
    if (cached) return cached;
    const path: string[] = [];
    const position = new Map<string, number>();
    let currentId = startId;
    let result: RootResolution;
    while (true) {
      const known = cache.get(currentId);
      if (known) {
        result = known;
        break;
      }
      const cycleAt = position.get(currentId);
      if (cycleAt !== undefined) {
        const cycleIds = path.slice(cycleAt);
        result = { rootSessionId: [...cycleIds].sort()[0], integrity: "cycle" };
        for (const id of cycleIds) cache.set(id, result);
        break;
      }
      const current = byId.get(currentId);
      if (!current) {
        const anchor = path[path.length - 1] ?? startId;
        result = { rootSessionId: anchor, integrity: "orphan" };
        break;
      }
      position.set(currentId, path.length);
      path.push(currentId);
      if (!current.parentSessionId) {
        result = { rootSessionId: current.id, integrity: "valid" };
        break;
      }
      if (!byId.has(current.parentSessionId)) {
        result = { rootSessionId: current.id, integrity: "orphan" };
        break;
      }
      currentId = current.parentSessionId;
    }
    for (const id of path) {
      const existing = cache.get(id);
      cache.set(id, existing?.integrity === "cycle" ? existing : result);
    }
    return cache.get(startId) ?? result;
  };

  const grouped = new Map<string, { integrity: ProjectIntegrity; sessions: T[] }>();
  for (const session of sessions) {
    const resolved = resolveRoot(session.id);
    const group = grouped.get(resolved.rootSessionId) ?? { integrity: resolved.integrity, sessions: [] };
    group.sessions.push(session);
    if (resolved.integrity !== "valid") group.integrity = resolved.integrity;
    grouped.set(resolved.rootSessionId, group);
  }

  const projects = [...grouped.entries()].map(([rootSessionId, group]): ProjectGraphEntry<T> => {
    const groupIds = new Set(group.sessions.map((session) => session.id));
    const children = new Map<string, T[]>();
    const roots: T[] = [];
    for (const session of group.sessions) {
      const parent = session.parentSessionId;
      const breakCycleAtRoot = group.integrity === "cycle" && session.id === rootSessionId;
      if (!parent || !groupIds.has(parent) || breakCycleAtRoot) {
        roots.push(session);
      } else {
        const siblings = children.get(parent) ?? [];
        siblings.push(session);
        children.set(parent, siblings);
      }
    }
    const visiting = new Set<string>();
    const toNode = (session: T, depth: number): ProjectGraphNode<T> => {
      if (visiting.has(session.id)) return { session, depth, children: [] };
      visiting.add(session.id);
      const nested = (children.get(session.id) ?? []).sort(newestFirst).map((child) => toNode(child, depth + 1));
      visiting.delete(session.id);
      return { session, depth, children: nested };
    };
    return {
      rootSessionId,
      integrity: group.integrity,
      sessions: [...group.sessions].sort(newestFirst),
      tree: roots.sort(newestFirst).map((root) => toNode(root, 1)),
    };
  }).sort((a, b) => newestFirst(a.sessions[0], b.sessions[0]));

  const projectBySessionId = new Map<string, ProjectGraphEntry<T>>();
  for (const project of projects) {
    for (const session of project.sessions) projectBySessionId.set(session.id, project);
  }
  return { projects, projectBySessionId };
}

