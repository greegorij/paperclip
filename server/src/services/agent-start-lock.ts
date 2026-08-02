import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();
const startLocksByProvider = new Map<string, Promise<void>>();
type ProviderLockOwnership = { active: boolean };
const providerLockContext = new AsyncLocalStorage<ReadonlyMap<string, ProviderLockOwnership>>();

async function waitForAgentStartLock(agentId: string, lock: { promise: Promise<void>; startedAtMs: number }) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ agentId, staleMs: elapsedMs }, "agent start lock stale; continuing queued-run start");
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ agentId, staleMs: AGENT_START_LOCK_STALE_MS }, "agent start lock timed out; continuing queued-run start");
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId);
  const waitForPrevious = previous ? waitForAgentStartLock(agentId, previous) : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId)?.promise === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

/** Serialize admission decisions for all agents sharing one company/provider. */
export async function withProviderStartLock<T>(companyId: string, provider: string, fn: () => Promise<T>) {
  const key = `${companyId}:${provider}`;
  const inheritedOwnership = providerLockContext.getStore();
  if (inheritedOwnership?.get(key)?.active) {
    // A claim can synchronously promote deferred work for another agent of the
    // same provider. It is still inside the original critical section, so
    // waiting on itself would deadlock while direct re-entry remains serialized
    // against every external caller.
    return fn();
  }
  const previous = startLocksByProvider.get(key);
  // Provider admission is a strict concurrency boundary. Unlike the per-agent
  // recovery lock, it must never bypass an older holder after a timeout because
  // two concurrent count-and-claim sections could exceed the provider cap.
  const waitForPrevious = previous ?? Promise.resolve();
  const run = waitForPrevious.then(() => {
    const ownership: ProviderLockOwnership = { active: true };
    const nextOwnership = new Map(inheritedOwnership ?? []);
    nextOwnership.set(key, ownership);
    return providerLockContext.run(nextOwnership, fn).finally(() => {
      // Async descendants retain the context object, so revoke its authority
      // when the critical section ends instead of trusting context presence.
      ownership.active = false;
    });
  });
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByProvider.set(key, marker);
  try {
    return await run;
  } finally {
    if (startLocksByProvider.get(key) === marker) {
      startLocksByProvider.delete(key);
    }
  }
}
