/**
 * Transactional side effects for caller verification state transitions.
 *
 * `recordEffect` writes the audit row and (when the verification snapshotted
 * a ticket) a system ticket comment plus outbox row — all in the CALLER's
 * transaction, so a rolled-back decision leaves no trace. Only a successful
 * status transition (CAS) calls it; that CAS is the idempotency boundary.
 *
 * `securityRecipients` is the smallest existing-permissions recipient rule
 * for rejection notifications: active users whose actual role grants
 * `alerts:read` (the incident-read permission) on this org — org members
 * without a site restriction, or partner members with `all` / this org
 * selected. Not a new preference setting.
 */
import { sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import type { VerificationRow } from './types';
import { addCallerVerificationSystemComment } from '../ticketService';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export async function recordEffect(row: VerificationRow, event: string, actorUserId?: string): Promise<void> {
  assertInTransaction('callerVerification.recordEffect');
  const details = {
    initiatedByUserId: row.initiatedByUserId, method: row.method, status: row.status,
    targetEntraTenantId: row.targetEntraTenantId, targetEntraOid: row.targetEntraOid, reason: row.reason,
  };
  await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result,details)
    VALUES(${row.orgId}::uuid,${actorUserId ? 'user' : 'system'}::actor_type,${actorUserId ?? SYSTEM_ACTOR}::uuid,
    ${`caller_verification.${event}`},'caller_verification',${row.id}::uuid,'success',${JSON.stringify(details)}::jsonb)`);
  if (row.ticketRef) {
    await addCallerVerificationSystemComment({ orgId: row.orgId, ticketId: row.ticketRef, verificationId: row.id, event });
  }
}

export async function securityRecipients(orgId: string): Promise<Array<{ id: string; email: string }>> {
  const rows = await db.execute(sql`SELECT DISTINCT u.id, u.email FROM users u WHERE u.status='active' AND EXISTS (
    SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
    WHERE p.resource IN ('alerts','*') AND p.action IN ('read','*') AND (
      EXISTS(SELECT 1 FROM organization_users ou WHERE ou.user_id = u.id AND ou.org_id = ${orgId}::uuid AND ou.role_id = rp.role_id AND ou.site_ids IS NULL)
      OR EXISTS(SELECT 1 FROM partner_users pu JOIN organizations o ON o.partner_id = pu.partner_id
        WHERE o.id = ${orgId}::uuid AND pu.user_id = u.id AND pu.role_id = rp.role_id
        AND (pu.org_access = 'all' OR (pu.org_access = 'selected' AND o.id = ANY(pu.org_ids))))))`);
  return rows as unknown as Array<{ id: string; email: string }>;
}
