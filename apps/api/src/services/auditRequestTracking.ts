import { AsyncLocalStorage } from 'node:async_hooks';

// Kept apart from auditService.ts so code that inserts into audit_logs
// directly can import `markRequestAuditWritten` without pulling in (or being
// broken by a test's mock of) the audit writer itself.
const requestAudit = new AsyncLocalStorage<{ written: boolean }>();

/** Track semantic audit submissions, including service calls without a Hono context. */
export async function runWithAuditRequestTracking(next: () => Promise<void>): Promise<boolean> {
  const state = { written: false };
  await requestAudit.run(state, next);
  return state.written;
}

/**
 * Record that the current request has written its own audit row, so the
 * generic fallback in index.ts does not add a second one. createAuditLog and
 * createAuditLogAsync call this for you; call it yourself right after inserting
 * into audit_logs directly (e.g. inside the mutation's own transaction). A
 * no-op outside a tracked request. `auditDirectInsertTracking.test.ts` checks
 * every direct insert has one.
 */
export function markRequestAuditWritten(): void {
  const state = requestAudit.getStore();
  if (state) state.written = true;
}
