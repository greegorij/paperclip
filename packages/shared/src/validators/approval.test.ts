import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  decisionCardSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";

describe("approval validators", () => {
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote)
      .toBe("Decision\nRevise.");
  });

  it("parses decision-card list items with issue context", () => {
    expect(
      decisionCardSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        issueId: "22222222-2222-4222-8222-222222222222",
        issueIdentifier: "PAP-1",
        issueTitle: "Needs a human decision",
        prompt: "Ship this?",
        createdByAgentId: "33333333-3333-4333-8333-333333333333",
        createdAt: "2026-07-16T12:00:00.000Z",
      }),
    ).toMatchObject({
      issueIdentifier: "PAP-1",
      prompt: "Ship this?",
    });

    expect(
      decisionCardSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        issueId: "22222222-2222-4222-8222-222222222222",
        issueIdentifier: null,
        issueTitle: "Untitled",
        prompt: null,
        createdByAgentId: null,
        createdAt: "2026-07-16T12:00:00.000Z",
      }).prompt,
    ).toBeNull();
  });
});
