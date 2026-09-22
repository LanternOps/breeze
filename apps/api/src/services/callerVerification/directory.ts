/**
 * Directory picker + authoritative sync for caller verification (#6354 W01).
 *
 * `directoryUsers` is the W04 picker feed: a bounded Graph search through the
 * org's `customer-graph-read` connection. `syncDirectory` binds selected
 * contacts from a fresh server-side snapshot and — ONLY when every import
 * succeeded and the snapshot was complete (not truncated) — revokes active
 * bindings in that tenant whose OID no longer appears. No connection, a
 * failed read, a malformed response, a partial page, or a tenant switch ever
 * implies deletion. Only full-org administrators may enumerate the directory:
 * site-constrained sessions and tokens without org access are refused before
 * any Graph call.
 *
 * Every DB phase opens its own short auth context (self-managed route); Graph
 * calls happen with no context held.
 */
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { m365Connections } from '../../db/schema/m365';
import { callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { withAuthDbAccessContext, type AuthContext } from '../../middleware/auth';
import { executeM365ReadAction } from '../m365ControlPlane/readActionService';
import { importDirectoryContact } from '../contacts/import';
import { withSubjectLocks } from './locks';
import { CallerVerificationValidationError as Invalid } from './errors';

export interface DirectoryUser { entraTenantId: string; entraOid: string; upn: string; displayName: string }
export interface DirectorySearch { available: boolean; users: DirectoryUser[]; truncated: boolean }

type Connection = { id: string; tenantId: string | null; status: string };
const ready = (c: Connection | undefined): c is Connection & { tenantId: string } =>
  !!c?.tenantId && ['active', 'degraded'].includes(c.status);

const directoryUserSchema = z.object({
  id: z.string().uuid(),
  userPrincipalName: z.string().min(1).max(320),
  displayName: z.string().max(255).nullable().optional(),
});

async function connection(auth: AuthContext, orgId: string): Promise<Connection | undefined> {
  if (auth.allowedSiteIds != null || (auth.scope !== 'system' && !auth.canAccessOrg(orgId))) {
    throw new Invalid('not_found', 'Directory not found');
  }
  return withAuthDbAccessContext(auth, async () => {
    const [c] = await db.select().from(m365Connections)
      .where(and(eq(m365Connections.orgId, orgId), eq(m365Connections.profile, 'customer-graph-read')))
      .limit(1);
    return c;
  });
}

async function snapshot(auth: AuthContext, orgId: string, search?: string) {
  const before = await connection(auth, orgId);
  if (!ready(before)) return null;
  const result = await executeM365ReadAction(auth, { type: 'm365.user.list', ...(search ? { search } : {}), pageSize: 50 }, orgId);
  // Upstream detail is never surfaced to the caller.
  if (!result.ok || result.kind !== 'collection') throw new Invalid('directory_unavailable', 'Directory read unavailable');
  const parsed = z.array(directoryUserSchema).safeParse(result.items);
  if (!parsed.success) throw new Invalid('directory_unavailable', 'Invalid directory response');
  const after = await connection(auth, orgId);
  if (!ready(after) || after.id !== before.id || after.tenantId !== before.tenantId) {
    throw new Invalid('directory_changed', 'Directory tenant changed');
  }
  return { connection: before, users: parsed.data, truncated: result.truncated };
}

export async function directoryUsers(auth: AuthContext, orgId: string, search: string): Promise<DirectorySearch> {
  const s = await snapshot(auth, orgId, search);
  if (!s) return { available: false, users: [], truncated: false };
  return {
    available: true,
    truncated: s.truncated,
    users: s.users.map((u) => ({
      entraTenantId: s.connection.tenantId, entraOid: u.id, upn: u.userPrincipalName, displayName: u.displayName ?? u.userPrincipalName,
    })),
  };
}

export async function syncDirectory(
  auth: AuthContext,
  orgId: string,
  mappings: { contactId: string; entraOid: string }[],
): Promise<{ imported: number; revoked: number; complete: boolean }> {
  const s = await snapshot(auth, orgId);
  if (!s) throw new Invalid('directory_unavailable', 'Directory unavailable');
  const seen = new Set(s.users.map((u) => u.id.toLowerCase()));
  for (const m of mappings) {
    if (!seen.has(m.entraOid.toLowerCase())) throw new Invalid('directory_unavailable', 'Selected user missing from sync');
    await importDirectoryContact(auth, { orgId, contactId: m.contactId, directoryObjectId: m.entraOid, expectedTenantId: s.connection.tenantId }, 'directory_sync');
  }
  if (s.truncated) return { imported: mappings.length, revoked: 0, complete: false };
  return withAuthDbAccessContext(auth, async () => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${orgId}`}))`);
    const [current] = await db.select().from(m365Connections)
      .where(and(eq(m365Connections.id, s.connection.id), eq(m365Connections.orgId, orgId))).limit(1).for('share');
    if (!ready(current) || current.tenantId !== s.connection.tenantId) throw new Invalid('directory_changed', 'Directory tenant changed');
    // Includes observed_login and technician_attested rows: source can change
    // without changing the canonical identity.
    const rows = await db.select().from(b)
      .where(and(eq(b.orgId, orgId), eq(b.entraTenantId, s.connection.tenantId), isNull(b.revokedAt)));
    const missing = rows.filter((r) => r.entraOid && !seen.has(r.entraOid.toLowerCase()));
    await withSubjectLocks(db, missing.map((r) => r.id), async () => {
      for (const row of missing) {
        await db.update(b).set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(b.id, row.id), eq(b.orgId, orgId), isNull(b.revokedAt)));
        await db.execute(sql`UPDATE caller_verifications SET status='revoked' WHERE org_id=${orgId}::uuid AND consumed_at IS NULL AND status IN ('pending','verified') AND (requester_binding_id=${row.id}::uuid OR target_binding_id=${row.id}::uuid)`);
        await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result) VALUES(${orgId}::uuid,'user',${auth.user.id}::uuid,'caller_verification.directory_missing','caller_verification',${row.id}::uuid,'success')`);
      }
    });
    return { imported: mappings.length, revoked: missing.length, complete: true };
  });
}
