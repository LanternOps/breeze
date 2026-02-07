import { db } from '../db';
import { auditLogs } from '../db/schema';

export interface CreateAuditLogParams {
  orgId: string;
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
}

export async function createAuditLog(params: CreateAuditLogParams): Promise<void> {
  const { actorType = 'user', ...rest } = params;
  await db.insert(auditLogs).values({ actorType, ...rest });
}

export function createAuditLogAsync(params: CreateAuditLogParams): void {
  createAuditLog(params).catch((err) => {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    console.error('[audit] Failed to write audit log:', err);
  });
}
