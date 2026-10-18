/**
 * Private dispatch context for the caller-verification gate (#6354 W05).
 *
 * `prepareCallerDispatch` re-runs the real gate (`requireCallerVerification`
 * in `check` mode) INSIDE its own marker transaction, while it already holds
 * the requester+target subject locks. Normally the gate escapes into its own
 * short system transactions and reads the target's mailboxes itself; inside a
 * dispatch it must instead:
 *   - run every read in the ambient marker transaction (so the fence it checks
 *     and the `dispatch_started_at` marker commit atomically, under the same
 *     locks a "This is not me" rejection takes);
 *   - evaluate ONLY the grant this intent already consumed (a newer grant can
 *     never substitute for it or change the lock set);
 *   - use mailbox hashes prefetched before any lock was taken (no Graph I/O
 *     while locks or the transaction are open).
 *
 * The value is never populated from HTTP or tool input — only by
 * `prepareCallerDispatch`, from the pinned intent row.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GateInput } from './gate';

export interface PreparedDispatchGate {
  input: GateInput;
  /** The grant consumed by `input.intentId`; null only at tier zero. */
  verificationId: string | null;
  /** Hashes of the target's mailboxes, or null when unknown / not an email grant. */
  mailboxHashes: Set<string> | null;
}

const prepared = new AsyncLocalStorage<PreparedDispatchGate>();

export function currentDispatchGate(): PreparedDispatchGate | undefined {
  return prepared.getStore();
}

export function withPreparedDispatchGate<T>(value: PreparedDispatchGate, fn: () => Promise<T>): Promise<T> {
  return prepared.run(value, fn);
}
