import type { ApprovalStatus, ApprovalType } from "../constants.js";

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Fork layer: a pending `request_confirmation` interaction awaiting a human
 * decision. This is the mechanism agents actually use to ask a human, as
 * opposed to the formal `approvals` table. Resolved in the issue thread.
 */
export interface DecisionCard {
  id: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  prompt: string | null;
  createdByAgentId: string | null;
  createdAt: Date;
}
