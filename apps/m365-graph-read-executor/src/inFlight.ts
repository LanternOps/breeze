import { incrementSyncCapacityRejected, setSyncInFlight, setTotalInFlight } from './metrics';

/**
 * Per-instance concurrency caps (spec §4.2). No queueing: a refused caller is
 * told to come back, which keeps latency honest and lets the API's BullMQ
 * backoff own the waiting.
 *
 * Sync may occupy at most `syncMaxInFlight` of `maxInFlight`, and config
 * validates syncMaxInFlight <= maxInFlight, so interactive AI-tool calls
 * always have (maxInFlight - syncMaxInFlight) slots reserved for them.
 */
export type ExecutorRequestKind = 'sync' | 'interactive';

export interface InFlightLease { release(): void }

export interface InFlightGate {
  acquire(kind: ExecutorRequestKind): InFlightLease | null;
  snapshot(): { sync: number; total: number };
}

export function createInFlightGate(limits: {
  syncMaxInFlight: number;
  maxInFlight: number;
}): InFlightGate {
  let sync = 0;
  let total = 0;

  function publish(): void {
    setSyncInFlight(sync);
    setTotalInFlight(total);
  }

  return {
    acquire(kind) {
      if (total >= limits.maxInFlight || (kind === 'sync' && sync >= limits.syncMaxInFlight)) {
        incrementSyncCapacityRejected(kind);
        return null;
      }
      total += 1;
      if (kind === 'sync') sync += 1;
      publish();
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          total -= 1;
          if (kind === 'sync') sync -= 1;
          publish();
        },
      };
    },
    snapshot: () => ({ sync, total }),
  };
}
