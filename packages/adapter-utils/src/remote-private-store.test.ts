import { describe, expect, it } from "vitest";
import { buildRemotePrivateStoreProvision } from "./remote-private-store.js";

describe("remote private store", () => {
  it("canonicalizes a legal trailing slash for Claude and Codex stores", () => {
    for (const adapterKey of ["claude", "codex"]) {
      const storeDir = `/app/.paperclip-runtime/${adapterKey}/session-stores/company/agent`;
      const command = buildRemotePrivateStoreProvision({ remoteCwd: "/app/", adapterKey, storeDir });
      expect(command).toContain(`'/app/.paperclip-runtime/${adapterKey}/session-stores'`);
      expect(command).not.toContain("/app//");
    }
  });

  it("rejects root, traversal, relative cwd, and stores outside the anchor", () => {
    for (const remoteCwd of ["/", "/app/../escape", "app"]) {
      expect(() => buildRemotePrivateStoreProvision({
        remoteCwd, adapterKey: "claude", storeDir: "/app/.paperclip-runtime/claude/session-stores/a",
      })).toThrow();
    }
  });
});
