import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;

/**
 * JSON shape of GET /companies/:companyId/decision-cards.
 * Pending request_confirmation cards with issue context for the Approvals view.
 */
export const decisionCardSchema = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  issueIdentifier: z.string().nullable(),
  issueTitle: z.string(),
  prompt: z.string().nullable(),
  createdByAgentId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
}).strict();

export type DecisionCardResponse = z.infer<typeof decisionCardSchema>;
