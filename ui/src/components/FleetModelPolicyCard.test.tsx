// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetModelPolicyCard } from "./FleetModelPolicyCard";

const getModelPolicyMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/fleet-model-policy", () => ({
  fleetModelPolicyApi: {
    get: (companyId: string) => getModelPolicyMock(companyId),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("FleetModelPolicyCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getModelPolicyMock.mockResolvedValue({
      policyId: "jarvis-shadow-model-policy",
      version: "2026-07-31.1",
      mode: "shadow",
      profiles: {
        "openai-first": {
          version: "2026-07-31.1",
          agents: [
            { slug: "jarvis", model: "gpt-5.6-sol", modelReasoningEffort: "high" },
          ],
        },
        "anthropic-first": {
          version: "2026-07-31.1",
          agents: [
            { slug: "badacz", model: "claude-sonnet-5", modelReasoningEffort: "medium" },
          ],
        },
      },
      roles: {
        badacz: {
          primary: { model: "gpt-5.6-terra" },
          fallback: [{ model: "claude-sonnet-5" }],
        },
      },
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the read-only warning and policy data without a button", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);

    await new Promise<void>((resolve) => {
      flushSync(() => {
        root.render(
          <QueryClientProvider client={client}>
            <FleetModelPolicyCard companyId="company-1" isProviderTabActive />
          </QueryClientProvider>,
        );
      });
      resolve();
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Read-only preview");
    });

    expect(getModelPolicyMock).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("This profile is not activated or applied.");
    expect(container.textContent).toContain("jarvis-shadow-model-policy");
    expect(container.textContent).toContain("openai-first");
    expect(container.textContent).toContain("anthropic-first");
    expect(container.textContent).toContain("jarvis");
    expect(container.textContent).toContain("gpt-5.6-sol");
    expect(container.textContent).toContain("badacz");
    expect(container.textContent).toContain("claude-sonnet-5");
    expect(container.textContent).toContain("Role model routing");
    expect(container.querySelector("button")).toBeNull();
  });
});
