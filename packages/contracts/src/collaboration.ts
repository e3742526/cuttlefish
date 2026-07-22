import type { PublicSession } from "./session.js";

export type CollaborationLane = "team" | "management";
export type ProjectIntegrity = "valid" | "orphan" | "cycle";
export type CollaborationFeedKind = "message" | "delegation" | "callback" | "status" | "error";
export type CollaborationAttribution = "recorded" | "inferred";
export type CollaborationAuthorKind = "operator" | "agent" | "system";
export type OperatorDelegationScope = "approve" | "decide" | "plan" | "act";

export interface ProjectSummary {
  rootSessionId: string;
  title: string;
  lastActivity: string;
  jobState: string;
  sessionCount: number;
  participantIds: string[];
  integrity: ProjectIntegrity;
  runningCount: number;
  needsAttentionCount: number;
}

export interface ProjectTreeNode {
  session: PublicSession;
  depth: number;
  children: ProjectTreeNode[];
}

export interface ProjectTreeResponse {
  project: ProjectSummary;
  tree: ProjectTreeNode[];
}

export interface CollaborationFeedItem {
  id: string;
  lane: CollaborationLane;
  projectRootSessionId?: string;
  sessionId?: string;
  kind: CollaborationFeedKind;
  author: {
    kind: CollaborationAuthorKind;
    id?: string;
    displayName: string;
  };
  recipients: string[];
  content: string;
  timestamp: number;
  attribution: CollaborationAttribution;
  deliveryReceipts?: DeliveryReceipt[];
  projectTitle?: string;
}

export interface DeliveryReceipt {
  recipientId: string;
  sessionId?: string;
  state: "queued" | "unavailable" | "failed";
  error?: string;
}

export interface CollaborationFeedPage {
  items: CollaborationFeedItem[];
  nextCursor: string | null;
  projectionWarning?: string;
}

export interface CollaborationSendRequest {
  message: string;
  recipientIds?: string[];
  recipientMode?: "all";
  projectRootSessionId?: string;
  operatorDelegationScopes?: OperatorDelegationScope[];
  confirmAllRecipients?: string[];
}

export interface CollaborationSendResponse {
  status: "queued" | "partial";
  receipts: DeliveryReceipt[];
  projectionWarning?: string;
  authorityGrant?: {
    recipientId: string;
    scopes: OperatorDelegationScope[];
    oneTurn: true;
    modelEligible: true;
  };
}

export interface ManagementRecipient {
  id: string;
  displayName: string;
  rank: "executive" | "manager";
  active: boolean;
  humanOnly?: boolean;
}

export interface ManagementRecipientsResponse {
  recipients: ManagementRecipient[];
  defaultRecipientId?: string;
  defaultReason: "explicit" | "project_lead" | "program_manager" | "coo";
}

export interface ProjectDeleteRequest {
  expectedTitle: string;
  expectedSessionCount: number;
  confirmation: string;
}

