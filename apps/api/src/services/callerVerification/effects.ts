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
 * `alerts:read` (the incident-read permission, own or inherited through
 * `parent_role_id`, #11702) on this org — org members
 * without a site restriction, or partner members with `all` / this org
 * selected. Not a new preference setting.
 */
import { sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import type { VerificationRow } from './types';
import { addCallerVerificationSystemComment } from '../ticketService';
import { markRequestAuditWritten } from '../auditRequestTracking';
import { permissionGrantMatches } from '../permissionMatching';
import { getRolesPermissionGrants } from '../roleInheritance';

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
  markRequestAuditWritten();
  if (row.ticketRef) {
    await addCallerVerificationSystemComment({ orgId: row.orgId, ticketId: row.ticketRef, verificationId: row.id, event });
  }
}

export async function securityRecipients(orgId: string): Promise<Array<{ id: string; email: string }>> {
  // Candidate memberships only (the membership rules, no permission join); the
  // role's grants — own + inherited via parent_role_id (#9600/#11702) — resolve
  // in TS. Stays on the ambient db: this runs in the caller's transaction.
  const candidates = (await db.execute(sql`
    SELECT u.id, u.email, ou.role_id
    FROM users u
    JOIN organization_users ou ON ou.user_id = u.id
    WHERE u.status = 'active' AND ou.org_id = ${orgId}::uuid AND ou.site_ids IS NULL
    UNION
    SELECT u.id, u.email, pu.role_id
    FROM users u
    JOIN partner_users pu ON pu.user_id = u.id
    JOIN organizations o ON o.partner_id = pu.partner_id
    WHERE u.status = 'active' AND o.id = ${orgId}::uuid
      AND (pu.org_access = 'all' OR (pu.org_access = 'selected' AND o.id = ANY(pu.org_ids)))`,
  )) as unknown as Array<{ id: string; email: string; role_id: string }>;
  if (candidates.length === 0) return [];
  const grants = await getRolesPermissionGrants([...new Set(candidates.map((c) => c.role_id))]);
  const out = new Map<string, { id: string; email: string }>();
  for (const c of candidates) {
    if (out.has(c.id)) continue;
    if ((grants.get(c.role_id) ?? []).some((g) => permissionGrantMatches(g, 'alerts', 'read'))) {
      out.set(c.id, { id: c.id, email: c.email });
    }
  }
  return [...out.values()];
}
