import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAgentStartLock, withProviderStartLock } from "../services/agent-start-lock.ts";

describe("heartbeat agent start lock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not let a stale start lock freeze later queued-run starts", async () => {
    vi.useFakeTimers();

    const agentId = randomUUID();
    const firstStart = vi.fn(() => new Promise<void>(() => undefined));
    const secondStart = vi.fn(async () => "started");

    void withAgentStartLock(agentId, firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledTimes(1);

    const secondStartResult = withAgentStartLock(agentId, secondStart);
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(secondStartResult).resolves.toBe("started");
    expect(secondStart).toHaveBeenCalledTimes(1);
  });

  it("serializes two agents sharing one provider lock", async () => {
    let active = 0;
    let peak = 0;
    const run = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    };

    await Promise.all([
      withProviderStartLock("company", "openai", run),
      withProviderStartLock("company", "openai", run),
    ]);

    expect(peak).toBe(1);
  });

  it("does not serialize unrelated providers", async () => {
    let active = 0;
    let peak = 0;
    const run = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    };

    await Promise.all([
      withProviderStartLock("company", "openai", run),
      withProviderStartLock("company", "anthropic", run),
    ]);

    expect(peak).toBe(2);
  });

  it("never bypasses a delayed provider admission holder", async () => {
    let releaseFirst!: () => void;
    const firstEntered = vi.fn();
    const secondEntered = vi.fn();
    const first = withProviderStartLock("company", "openai", async () => {
      firstEntered();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });

    await vi.waitFor(() => expect(firstEntered).toHaveBeenCalledOnce());
    const second = withProviderStartLock("company", "openai", async () => {
      secondEntered();
    });
    await Promise.resolve();
    expect(secondEntered).not.toHaveBeenCalled();

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toHaveBeenCalledOnce();
  });

  it("allows same-chain re-entry without releasing the provider boundary", async () => {
    const events: string[] = [];
    await withProviderStartLock("company", "openai", async () => {
      events.push("outer-start");
      await withProviderStartLock("company", "openai", async () => {
        events.push("inner");
      });
      events.push("outer-end");
    });

    expect(events).toEqual(["outer-start", "inner", "outer-end"]);
  });

  it("revokes inherited re-entry after the owning section ends", async () => {
    let triggerDescendant!: () => void;
    let descendant!: Promise<void>;
    const descendantEntered = vi.fn();

    await withProviderStartLock("company", "openai", async () => {
      const trigger = new Promise<void>((resolve) => {
        triggerDescendant = resolve;
      });
      descendant = (async () => {
        await trigger;
        await withProviderStartLock("company", "openai", async () => {
          descendantEntered();
        });
      })();
    });

    let releaseExternal!: () => void;
    const externalEntered = vi.fn();
    const external = withProviderStartLock("company", "openai", async () => {
      externalEntered();
      await new Promise<void>((resolve) => {
        releaseExternal = resolve;
      });
    });
    await vi.waitFor(() => expect(externalEntered).toHaveBeenCalledOnce());

    triggerDescendant();
    await Promise.resolve();
    expect(descendantEntered).not.toHaveBeenCalled();
    releaseExternal();
    await Promise.all([external, descendant]);
    expect(descendantEntered).toHaveBeenCalledOnce();
  });
});
