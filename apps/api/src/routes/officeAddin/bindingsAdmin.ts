import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { officeAddinUserBindings } from '../../db/schema/officeAddin';
import { users } from '../../db/schema/users';
import { authMiddleware, requireScope, requireMfa, type AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { revokeBinding } from '../../services/officeAddin/officeAddinBindings';
import { revokeTechSessionsForUser } from '../../services/officeAddin/techSession';
import { getRedis } from '../../services/redis';
import { writeAuditEvent, type RequestLike } from '../../services/auditEvents';

/**
 * Web-session admin surface for managing Office add-in technician bindings
 * (Task 13, spec §2.2/§9). Mounted at /office-addin/bindings*, distinct from
 * the tech-token routes (auth.ts, emailContext.ts, tickets.ts, time.ts) —
 * these run under the caller's normal Breeze JWT (authMiddleware), not the
 * techaddin: Redis session.
 *
 * Bindings are tenancy shape 3 (partner-axis, no org_id): RLS enforces the
 * partner axis on the request's db context, and every query here ALSO adds
 * an explicit eq(partnerId, ...) filter — belt and suspenders per the repo's
 * shape-3 convention (app-layer + RLS, never RLS alone).
 *
 * Write access additionally requires canManagePartnerWidePolicies (full
 * partner org_access='all', or system scope) — a 'selected'-access
 * technician must not see or revoke bindings outside their assigned orgs'
 * blast radius, and binding management is partner-wide by nature (it is not
 * scoped to any single org).
 */
export const officeAddinBindingsAdminRoutes = new Hono();

const adminChain = [authMiddleware, requireScope('partner', 'system'), requireMfa()] as const;

/**
 * Resolve the partner id to scope this request to. Partner scope always
 * carries a partnerId (enforced by authMiddleware's live-membership check).
 * System scope has no inherent partner context — simplest correct behavior
 * is to require the caller's own auth.partnerId (set when a platform admin
 * is also a partner member) and 400 otherwise, rather than accepting an
 * unauthenticated partnerId from the request.
 */
function resolvePartnerId(auth: AuthContext): { partnerId: string } | { error: string; status: 400 } {
  if (!auth.partnerId) {
    return { error: 'partner_context_required', status: 400 };
  }
  return { partnerId: auth.partnerId };
}

function auditBindingRevoked(
  c: RequestLike,
  params: { actorId: string; actorEmail: string | null; bindingId: string; targetUserId: string }
): void {
  writeAuditEvent(c, {
    orgId: null,
    action: 'office_addin.binding.revoked',
    resourceType: 'office_addin_binding',
    resourceId: params.bindingId,
    actorType: 'user',
    actorId: params.actorId,
    actorEmail: params.actorEmail,
    result: 'success',
    details: { principalType: 'user', targetUserId: params.targetUserId },
  });
}

officeAddinBindingsAdminRoutes.get('/bindings', ...adminChain, async (c) => {
  const auth = c.get('auth');
  if (!canManagePartnerWidePolicies(auth)) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  const resolved = resolvePartnerId(auth);
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);

  const rows = await db
    .select({
      id: officeAddinUserBindings.id,
      userId: officeAddinUserBindings.userId,
      userName: users.name,
      userEmail: users.email,
      entraTenantId: officeAddinUserBindings.entraTenantId,
      mfaVerifiedAt: officeAddinUserBindings.mfaVerifiedAt,
      createdAt: officeAddinUserBindings.createdAt,
    })
    .from(officeAddinUserBindings)
    .innerJoin(users, eq(users.id, officeAddinUserBindings.userId))
    .where(
      and(
        eq(officeAddinUserBindings.partnerId, resolved.partnerId),
        isNull(officeAddinUserBindings.revokedAt)
      )
    );

  return c.json({ bindings: rows });
});

officeAddinBindingsAdminRoutes.delete('/bindings/:id', ...adminChain, async (c) => {
  const auth = c.get('auth');
  if (!canManagePartnerWidePolicies(auth)) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  const resolved = resolvePartnerId(auth);
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);

  // Sessions are Redis-only (techSession.ts) — without Redis, revoking the DB
  // row alone would leave a live techaddin: session usable, defeating the
  // point of an admin revoke. Fail closed rather than silently skip it.
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'service_unavailable' }, 503);
  }

  const bindingId = c.req.param('id');
  if (!bindingId) {
    return c.json({ error: 'not_found' }, 404);
  }

  const [binding] = await db
    .select({
      id: officeAddinUserBindings.id,
      userId: officeAddinUserBindings.userId,
      partnerId: officeAddinUserBindings.partnerId,
    })
    .from(officeAddinUserBindings)
    .where(
      and(
        eq(officeAddinUserBindings.id, bindingId),
        eq(officeAddinUserBindings.partnerId, resolved.partnerId),
        isNull(officeAddinUserBindings.revokedAt)
      )
    )
    .limit(1);

  if (!binding) {
    return c.json({ error: 'not_found' }, 404);
  }

  await revokeBinding(binding.id, auth.user.id);
  await revokeTechSessionsForUser(redis, binding.userId);

  auditBindingRevoked(c, {
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    bindingId: binding.id,
    targetUserId: binding.userId,
  });

  return c.json({ revoked: true });
});
