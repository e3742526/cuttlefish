import { describe, expect, it } from "vitest";
import { buildProjectGraph } from "../project-graph.js";

const session = (id: string, parentSessionId: string | null, lastActivity: string) => ({ id, parentSessionId, lastActivity });

describe("buildProjectGraph", () => {
  it("groups recursively reachable descendants under one root at stable depths", () => {
    const graph = buildProjectGraph([
      session("root", null, "2026-01-01T00:00:00Z"),
      session("child", "root", "2026-01-02T00:00:00Z"),
      session("grandchild", "child", "2026-01-03T00:00:00Z"),
    ]);
    expect(graph.projects).toHaveLength(1);
    expect(graph.projects[0]).toMatchObject({ rootSessionId: "root", integrity: "valid" });
    expect(graph.projects[0].tree[0].children[0].children[0]).toMatchObject({
      session: { id: "grandchild" },
      depth: 3,
    });
    expect(graph.projectBySessionId.get("grandchild")?.rootSessionId).toBe("root");
  });

  it("keeps missing-parent branches visible as orphan projects", () => {
    const graph = buildProjectGraph([
      session("orphan", "missing", "2026-01-02T00:00:00Z"),
      session("child", "orphan", "2026-01-03T00:00:00Z"),
    ]);
    expect(graph.projects[0]).toMatchObject({ rootSessionId: "orphan", integrity: "orphan" });
    expect(graph.projects[0].sessions.map((entry) => entry.id)).toEqual(["child", "orphan"]);
  });

  it("terminates cycles and chooses a deterministic project root", () => {
    const graph = buildProjectGraph([
      session("b", "a", "2026-01-02T00:00:00Z"),
      session("a", "b", "2026-01-01T00:00:00Z"),
      session("child", "b", "2026-01-03T00:00:00Z"),
    ]);
    expect(graph.projects).toHaveLength(1);
    expect(graph.projects[0]).toMatchObject({ rootSessionId: "a", integrity: "cycle" });
    expect(graph.projects[0].sessions).toHaveLength(3);
  });

  it("sorts projects and siblings by activity with an id tie-break", () => {
    const graph = buildProjectGraph([
      session("old", null, "2026-01-01T00:00:00Z"),
      session("new", null, "2026-01-03T00:00:00Z"),
      session("b", "new", "2026-01-02T00:00:00Z"),
      session("a", "new", "2026-01-02T00:00:00Z"),
    ]);
    expect(graph.projects.map((project) => project.rootSessionId)).toEqual(["new", "old"]);
    expect(graph.projects[0].tree[0].children.map((node) => node.session.id)).toEqual(["a", "b"]);
  });
});

