/**
 * Tool Catalog W05 (#5220), plan Task A7 / Decision 11 — the process-wide cap
 * on concurrently executing for-each units. Each unit holds DB connections
 * (its checkpoints, the step's own reads), so a worker process runs at most
 * `FLOW_RUN_LIMITS.maxParallelUnitsPerProcess` at once across every run it is
 * slicing. FIFO: waiters are granted in arrival order.
 */
import { FLOW_RUN_LIMITS } from '@breeze/shared';

export interface UnitSemaphore {
  /** Resolves with an idempotent release once a slot is free. */
  acquire(): Promise<() => void>;
  inUse(): number;
}

export function createUnitSemaphore(size: number): UnitSemaphore {
  if (!Number.isInteger(size) || size < 1) throw new Error('unit semaphore size must be a positive integer');
  let used = 0;
  const waiters: Array<() => void> = [];
  const grant = (): (() => void) => {
    used += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      used -= 1;
      const next = waiters.shift();
      if (next) next();
    };
  };
  return {
    acquire() {
      if (used < size) return Promise.resolve(grant());
      return new Promise((resolve) => waiters.push(() => resolve(grant())));
    },
    inUse: () => used,
  };
}

const processUnits = createUnitSemaphore(FLOW_RUN_LIMITS.maxParallelUnitsPerProcess);

/** One of the worker process's concurrent-unit slots. */
export function acquireUnit(): Promise<() => void> {
  return processUnits.acquire();
}
