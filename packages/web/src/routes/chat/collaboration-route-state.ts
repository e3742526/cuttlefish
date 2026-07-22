export interface CollaborationRouteState {
  lane: "team" | "management"
  projectRootSessionId: string | null
  sessionId: string | null
  inspectorOpen: boolean
}

export function readCollaborationRouteState(params: URLSearchParams): CollaborationRouteState {
  const lane = params.get("lane") === "management" ? "management" : "team"
  const projectRootSessionId = params.get("project")?.trim() || null
  const sessionId = params.get("session")?.trim() || null
  return {
    lane,
    projectRootSessionId,
    sessionId,
    inspectorOpen: params.get("inspector") === "1" && Boolean(projectRootSessionId && sessionId),
  }
}

export function writeCollaborationRouteState(
  current: URLSearchParams,
  state: CollaborationRouteState,
): URLSearchParams {
  const next = new URLSearchParams(current)
  next.set("lane", state.lane)
  if (state.projectRootSessionId) next.set("project", state.projectRootSessionId)
  else next.delete("project")
  if (state.lane === "team" && state.projectRootSessionId && state.sessionId) next.set("session", state.sessionId)
  else next.delete("session")
  if (state.lane === "team" && state.sessionId && state.inspectorOpen) next.set("inspector", "1")
  else next.delete("inspector")
  return next
}
