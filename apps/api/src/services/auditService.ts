import { db, withSystemDbAccessContext } from '../db';
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
  // Audit writes run under system scope because they are called from both
  // authenticated handlers (where the request's org scope would match) AND
  // pre-auth paths like failed-login tracking (where no scope is set yet,
  // e.g. apps/api/src/routes/auth/login.ts:91 auditUserLoginFailure).
  // Running in system scope keeps the audit path reliable regardless of
  // caller context — the orgId in the row itself still identifies which
  // tenant the event belongs to.
  return withSystemDbAccessContext(async () => {
    const { actorType = 'user', ...rest } = params;
    await db.insert(auditLogs).values({ actorType, ...rest });
  });
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
