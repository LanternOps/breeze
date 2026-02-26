import { db } from '../db';
import * as dbModule from '../db';
import { auditLogs } from '../db/schema';

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
  const { actorType = 'user', ...rest } = params;
  await db.insert(auditLogs).values({ actorType, ...rest });
}

export function createAuditLogAsync(params: CreateAuditLogParams): void {
  // Run outside any active DB transaction context so audit failures
  // never abort business-logic transactions (e.g. password changes).
  let runOutsideDbContext: <T>(fn: () => T) => T = <T>(fn: () => T): T => fn();
  try {
    if (typeof dbModule.runOutsideDbContext === 'function') {
      runOutsideDbContext = dbModule.runOutsideDbContext;
    }
  } catch {
    // Some tests mock ../db without runOutsideDbContext; fall back to direct invocation.
  }

  runOutsideDbContext(() => {
    createAuditLog(params).catch((err) => {
      if (process.env.NODE_ENV === 'test') {
        return;
      }
      console.error('[audit] Failed to write audit log:', err);
    });
  });
}
