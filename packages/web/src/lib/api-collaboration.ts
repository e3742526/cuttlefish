import type {
  CollaborationFeedPage,
  CollaborationSendRequest,
  CollaborationSendResponse,
  ManagementRecipientsResponse,
  ProjectDeleteRequest,
  ProjectSummary,
  ProjectTreeResponse,
} from "@cuttlefish/contracts"
import { authFetch, extractErrorMessage, get, post } from "./api-core"

export interface ProjectsPage {
  projects: ProjectSummary[]
  nextCursor: string | null
}

function query(params: Record<string, string | number | null | undefined>): string {
  const values = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") values.set(key, String(value))
  }
  const encoded = values.toString()
  return encoded ? `?${encoded}` : ""
}

export const collaborationApi = {
  getProjects: (params: { cursor?: string | null; limit?: number; q?: string } = {}) =>
    get<ProjectsPage>(`/api/projects${query(params)}`),
  getProjectTree: (rootSessionId: string) =>
    get<ProjectTreeResponse>(`/api/projects/${encodeURIComponent(rootSessionId)}/tree`),
  getProjectFeed: (rootSessionId: string, params: { cursor?: string | null; limit?: number; sessionId?: string | null } = {}) =>
    get<CollaborationFeedPage>(`/api/projects/${encodeURIComponent(rootSessionId)}/feed${query(params)}`),
  sendProjectMessage: (rootSessionId: string, body: CollaborationSendRequest) =>
    post<CollaborationSendResponse>(`/api/projects/${encodeURIComponent(rootSessionId)}/messages`, body),
  getManagementFeed: (params: { cursor?: string | null; limit?: number; projectRootSessionId?: string | null } = {}) =>
    get<CollaborationFeedPage>(`/api/management/feed${query(params)}`),
  getManagementRecipients: (projectRootSessionId?: string | null) =>
    get<ManagementRecipientsResponse>(`/api/management/recipients${query({ projectRootSessionId })}`),
  sendManagementMessage: (body: CollaborationSendRequest) =>
    post<CollaborationSendResponse>("/api/management/messages", body),
  deleteProject: async (rootSessionId: string, body: ProjectDeleteRequest) => {
    const response = await authFetch(`/api/projects/${encodeURIComponent(rootSessionId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(await extractErrorMessage(response))
    return response.json() as Promise<{ status: "deleted"; count: number; deletedIds: string[]; warning?: string }>
  },
}

