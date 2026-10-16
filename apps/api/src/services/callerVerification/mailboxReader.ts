/**
 * Mailbox-read attribution (#6354 W03).
 *
 * The release gate reads the target's mailbox set on behalf of a technician
 * with no HTTP request or AuthContext in play (SDK / worker dispatch is
 * headless). The acting technician id rides in invocation-local async state —
 * never a module-level variable, never a fabricated AuthContext, never a
 * request field. Deliberately a leaf module with no imports beyond Node so the
 * gate can depend on it without pulling the M365/AI tool graph into every
 * worker that loads the gate.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const reader = new AsyncLocalStorage<string>();

export function withMailboxReader<T>(technicianUserId: string, fn: () => Promise<T>): Promise<T> {
  return reader.run(technicianUserId, fn);
}

export function currentMailboxReader(): string | undefined {
  return reader.getStore();
}
