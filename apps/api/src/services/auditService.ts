import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { auditLogs } from '../db/schema';
import { captureException } from './sentry';

export type InitiatedByType = 'manual' | 'ai' | 'automation' | 'policy' | 'schedule' | 'agent' | 'integration';

export interface CreateAuditLogParams {
  orgId?: string | null;
  actorType?: 'user' | 'api_key' | 'agent' | 'system';
  actorId: string;
  actorEmail?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  result: 'success' | 'failure' | 'denied';
  errorMessage?: string;
  initiatedBy?: InitiatedByType;
}

export async function createAuditLog(params: CreateAuditLogParams): Promise<void> {
  // Audit writes must run on a connection OUTSIDE the caller's request
  // transaction. Two reasons:
  //   1. System-scope semantics. Audits are written from both pre-auth paths
  //      (no tx yet) and authenticated handlers where the caller's scope
  //      can't insert rows with NULL or cross-org org_id under RLS. The
  //      previous `withSystemDbAccessContext` call was a no-op when already
  //      inside a tx (see `withDbAccessContext`'s short-circuit), leaving
  //      the insert running under the caller's scope and failing the
  //      `audit_logs` insert policy for partner-scope callers with a
  //      NULL-org audit row.
  //   2. Tx isolation. A failed audit insert inside the request tx aborts
  //      the whole transaction in Postgres, silently rolling back the
  //      caller's real work (e.g. password change) even though the route
  //      returned 200 — because `createAuditLogAsync` swallows the error.
  //
  // `runOutsideDbContext` exits the AsyncLocalStorage so the nested
  // `withSystemDbAccessContext` actually opens a fresh system-scope
  // transaction on its own pooled connection.
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const { actorType = 'user', ...rest } = params;
      await db.insert(auditLogs).values({ actorType, ...rest });
    })
  );
}

export function createAuditLogAsync(params: CreateAuditLogParams): void {
  createAuditLog(params).catch((err) => {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    console.error('[audit] Failed to write audit log:', err);
    captureException(err);
  });
}
