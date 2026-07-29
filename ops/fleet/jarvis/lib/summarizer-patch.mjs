/**
 * Controlled Summarizer AGENTS.md patch for deployments where built-in reset is unavailable.
 * Exact old fragment must be present; new fragment must be absent — otherwise refuse to write.
 * already-patched requires the exact target section and no cheap-lane claim.
 * POST-write verify requires exact equality with plan.next (or identical SHA-256).
 */

import { createHash } from "node:crypto";

export const SUMMARIZER_OLD_MODEL_SECTION = `## Model lane

You run on the low-cost model profile lane (\`cheap\`) by default and spend no tokens in the background. Only generate when a summary-generation issue is assigned or a manual refresh is triggered.

- Keep summaries short — a header summary that scrolls or reads like a task list has failed its job.
- An operator may override the cheap default with a specific model in this agent's \`cheap\` model profile configuration. Respect whatever model the run actually provides.
`;

export const SUMMARIZER_NEW_MODEL_SECTION = `## Model

Your built-in primary model is \`claude-haiku-4-5\`. An operator may change this agent's primary model. Respect whatever model the run actually provides. Only generate when a summary-generation issue is assigned or a manual refresh is triggered; spend no tokens in the background otherwise.

- Keep summaries short — a header summary that scrolls or reads like a task list has failed its job.
`;

export const SUMMARIZER_CHEAP_CLAIM_RE =
  /run on the low-cost model profile lane\s*\(`cheap`\)\s*by default/i;

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function hasExactNewSection(content) {
  return content.includes(SUMMARIZER_NEW_MODEL_SECTION.trimEnd());
}

function hasExactOldSection(content) {
  return content.includes(SUMMARIZER_OLD_MODEL_SECTION.trimEnd());
}

/**
 * @param {string} content
 * @returns {{ ok: true, next: string } | { ok: false, code: string, detail: string }}
 */
export function planSummarizerInstructionPatch(content) {
  if (typeof content !== "string") {
    return { ok: false, code: "missing-content", detail: "Summarizer AGENTS.md content missing" };
  }

  const exactNew = hasExactNewSection(content);
  const exactOld = hasExactOldSection(content);
  const cheapClaim = SUMMARIZER_CHEAP_CLAIM_RE.test(content);

  // already-patched: exact target section present AND no cheap/old claim
  if (exactNew && !cheapClaim && !exactOld) {
    return {
      ok: false,
      code: "already-patched",
      detail: "Summarizer instructions already contain the exact Haiku primary-model section",
    };
  }

  // Partial/corrupted: looks patched heuristically but not exact — refuse
  if (!exactNew && !exactOld && !cheapClaim) {
    if (content.includes("claude-haiku-4-5") || content.includes("## Model\n")) {
      return {
        ok: false,
        code: "unexpected-drift",
        detail:
          "Summarizer AGENTS.md has partial/corrupted Model wording (not exact target section); refusing write",
      };
    }
    return {
      ok: false,
      code: "unexpected-drift",
      detail: "Summarizer AGENTS.md lacks the expected cheap-lane fragment; refusing write",
    };
  }

  if (cheapClaim && !exactOld) {
    return {
      ok: false,
      code: "unexpected-drift",
      detail:
        "Cheap claim present but surrounding Model lane block does not match exact old fragment; refusing write",
    };
  }

  if (!exactOld) {
    return {
      ok: false,
      code: "unexpected-drift",
      detail: "Summarizer AGENTS.md lacks the expected cheap-lane fragment; refusing write",
    };
  }

  if (exactNew) {
    return {
      ok: false,
      code: "unexpected-drift",
      detail: "Both old cheap-lane and new Haiku sections present; refusing write",
    };
  }

  const next = content.replace(SUMMARIZER_OLD_MODEL_SECTION, SUMMARIZER_NEW_MODEL_SECTION);
  if (next === content) {
    return { ok: false, code: "replace-failed", detail: "Exact old fragment replace produced no change" };
  }
  if (SUMMARIZER_CHEAP_CLAIM_RE.test(next) || hasExactOldSection(next)) {
    return { ok: false, code: "replace-incomplete", detail: "Cheap claim still present after planned replace" };
  }
  if (!hasExactNewSection(next)) {
    return {
      ok: false,
      code: "replace-incomplete",
      detail: "Exact Haiku primary-model section missing after planned replace",
    };
  }
  return { ok: true, next };
}

/**
 * GET → require exact old / absent new → PUT → GET verify exact content/hash.
 */
export async function applySummarizerInstructionPatch({
  agentId,
  client,
  dryRun = true,
  getContent = null,
} = {}) {
  const stepBase = {
    kind: "summarizer-instructions-patch",
    target: "summarizer",
    api: {
      method: "PUT",
      path: `/api/agents/${agentId}/instructions-bundle/file`,
      bodyKeys: ["path", "content"],
    },
  };

  const getRes =
    getContent != null
      ? { ok: true, dryRun: false, data: { content: getContent } }
      : await client.get(
          `/api/agents/${agentId}/instructions-bundle/file?path=${encodeURIComponent("AGENTS.md")}`,
        );

  if (!getRes.ok && !getRes.dryRun) {
    return {
      ...stepBase,
      ok: false,
      result: "failed",
      error: `GET instructions failed HTTP ${getRes.status}`,
    };
  }

  const current =
    typeof getRes.data === "string"
      ? getRes.data
      : getRes.data?.content ?? getRes.data?.file?.content ?? "";

  const plan = planSummarizerInstructionPatch(current);
  if (!plan.ok) {
    if (plan.code === "already-patched") {
      return { ...stepBase, ok: true, result: "noop", detail: plan.detail };
    }
    return { ...stepBase, ok: false, result: "refused", error: plan.detail, code: plan.code };
  }

  if (dryRun || client.dryRun) {
    return {
      ...stepBase,
      ok: true,
      result: "dry-run",
      detail: "Would replace Model lane cheap claim with Haiku primary-model section",
    };
  }

  const putRes = await client.put(`/api/agents/${agentId}/instructions-bundle/file`, {
    path: "AGENTS.md",
    content: plan.next,
  });
  if (!putRes.ok) {
    return {
      ...stepBase,
      ok: false,
      result: "failed",
      error: `PUT instructions failed HTTP ${putRes.status}`,
      partial: false,
    };
  }

  const verifyRes = await client.get(
    `/api/agents/${agentId}/instructions-bundle/file?path=${encodeURIComponent("AGENTS.md")}`,
  );
  const verified =
    typeof verifyRes.data === "string"
      ? verifyRes.data
      : verifyRes.data?.content ?? verifyRes.data?.file?.content ?? "";

  const wantHash = sha256(plan.next);
  const gotHash = typeof verified === "string" ? sha256(verified) : null;
  const exactMatch = verified === plan.next || (gotHash != null && gotHash === wantHash);

  if (!verifyRes.ok || !exactMatch) {
    return {
      ...stepBase,
      ok: false,
      result: "verify-failed",
      error: `POST-write verify failed: content/hash mismatch (liveHash=${gotHash} expectedHash=${wantHash})`,
      partial: true,
      detail: "PUT succeeded but verify did not confirm exact plan.next content",
    };
  }

  return {
    ...stepBase,
    ok: true,
    result: "applied",
    detail: "Summarizer AGENTS.md patched and verified",
    hash: wantHash,
  };
}
