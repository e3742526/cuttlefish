import { describe, expect, it } from "vitest"
import { readCollaborationRouteState, writeCollaborationRouteState } from "./collaboration-route-state"

describe("collaboration route state", () => {
  it("reads durable Team project, filter, and inspector state", () => {
    expect(readCollaborationRouteState(new URLSearchParams("lane=team&project=root&session=child&inspector=1"))).toEqual({
      lane: "team",
      projectRootSessionId: "root",
      sessionId: "child",
      inspectorOpen: true,
    })
  })

  it("normalizes invalid lanes and inspector-without-session", () => {
    expect(readCollaborationRouteState(new URLSearchParams("lane=old&inspector=1"))).toEqual({
      lane: "team",
      projectRootSessionId: null,
      sessionId: null,
      inspectorOpen: false,
    })
  })

  it("preserves unrelated URL state and optional project context in Management", () => {
    const next = writeCollaborationRouteState(new URLSearchParams("debug=1&project=old&session=old&inspector=1"), {
      lane: "management",
      projectRootSessionId: "root",
      sessionId: null,
      inspectorOpen: false,
    })
    expect(next.toString()).toBe("debug=1&project=root&lane=management")
  })
})
