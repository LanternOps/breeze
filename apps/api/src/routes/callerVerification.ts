/**
 * Caller verification (anti-vishing, #6354 W01) — authenticated API.
 *
 * Thin router: permission/MFA gates live here, org/site reach and every
 * state transition live in services/callerVerification. Route-local
 * middleware (not a wildcard `.use`) so the readiness gate and auth never
 * bleed onto unrelated APIs mounted beside this one.
 *
 * While `CALLER_VERIFICATION_ENABLED` is not exactly 'true', every route here
 * returns 404 `feature_disabled` — but only AFTER authentication and scope, so
 * an anonymous request still gets 401 as the router auth-gate contract
 * requires. The feature does not exist for anyone who can reach it.
 *
 * Not mounted in W01: the administrative step-up route (W05) and the public
 * `/verify/:token` link route (W03).
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  startCallerVerificationSchema, attestCallerVerificationSchema, callerVerificationBindingSchema,
  callerVerificationPolicySchema, callerVerificationFenceOverrideSchema, callerVerificationMethodsQuerySchema,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireScope, requirePermission, requireMfa, withAuthDbAccessContext, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { canReachContactSite } from './orgContacts';
import { db } from '../db';
import {
  callerVerificationPolicies as p, callerVerificationSubjectBindings as b, callerVerificationDestinations as d,
} from '../db/schema/callerVerification';
import { organizations } from '../db/schema/orgs';
import { callerVerificationEnabled } from '../config/env';
import * as service from '../services/callerVerification/service';
import { bindingsForContact, revokeBinding } from '../services/callerVerification/subjects';
import { attestDestination, isEstablished } from '../services/callerVerification/destinations';
import { reachableContact } from '../services/callerVerification/access';
import { fenceOverride } from '../services/callerVerification/rejection';
import { getEffectivePolicy, resolveEffectivePolicy, getPolicyResponse } from '../services/callerVerification/policy';
import { directoryUsers, syncDirectory } from '../services/callerVerification/directory';
import { CallerVerificationRequiredError, CallerVerificationValidationError } from '../services/callerVerification/errors';
import { importDirectoryContact } from '../services/contacts/import';
import type { CallerVerificationActor } from '../services/callerVerification/types';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { createAuditLog } from '../services/auditService';

export const callerVerificationRoutes = new Hono();

/**
 * Readiness gate. Runs AFTER authentication, never before it: the repo's
 * router auth-gate contract (__tests__/routerAuthGate.contract.test.ts)
 * requires every mounted route to answer an unauthenticated request with 401,
 * and that contract wins over hiding the feature from anonymous probes. An
 * authenticated caller gets 404 `feature_disabled` while the flag is off, so
 * the feature is still invisible to everyone who can actually reach it.
 */
const enabled: MiddlewareHandler = async (c, next) =>
  (callerVerificationEnabled() ? next() : c.json({ error: 'Not found', code: 'feature_disabled' }, 404));
const read = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const write = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParams: MiddlewareHandler = async (c, next) => {
  for (const [key, value] of Object.entries(c.req.param())) {
    if (['orgId', 'contactId', 'id', 'bindingId', 'ticketId'].includes(key) && !UUID.test(String(value))) return c.json({ error: 'Invalid identifier' }, 400);
  }
  return next();
};
const base = [authMiddleware, requireScope('organization', 'partner', 'system'), enabled, uuidParams] as const;

const actor = (c: Context): CallerVerificationActor => {
  const a = c.get('auth') as AuthContext;
  return {
    userId: a.user.id, partnerId: a.partnerId, scope: a.scope === 'organization' ? 'organization' : 'partner',
    accessibleOrgIds: a.accessibleOrgIds, allowedSiteIds: a.allowedSiteIds ?? null, displayName: a.user.name ?? a.user.email,
  };
};
const oid = (c: Context) => c.req.param('orgId')!;
const cid = (c: Context) => c.req.param('contactId')!;
const orgPath = '/orgs/:orgId';
const cv = `${orgPath}/caller-verifications`;
const contact = `${orgPath}/contacts/:contactId`;

async function contactCheck(c: Context) {
  const a = c.get('auth') as AuthContext;
  const row = await reachableContact(actor(c), oid(c), cid(c));
  if (!canReachContactSite(a, row.siteId)) throw new CallerVerificationValidationError('not_found', 'Contact not found');
  return row;
}

callerVerificationRoutes.onError((e, c) => {
  if (e instanceof CallerVerificationRequiredError) return c.json({ error: 'caller_verification_required', requiresCallerVerification: e.payload }, 409);
  if (e instanceof CallerVerificationValidationError) {
    const status = e.code === 'not_found' || e.code === 'feature_disabled' ? 404 : e.code === 'attempt_cap' ? 429 : 400;
    return c.json({ error: e.message, code: e.code }, status);
  }
  throw e;
});

// --- Verifications -----------------------------------------------------------

callerVerificationRoutes.post(cv, ...base, write, requireMfa(), zValidator('json', startCallerVerificationSchema), async (c) => {
  const limit = await rateLimiter(getRedis(), `caller-start:${actor(c).userId}`, 10, 600);
  if (!limit.allowed) return c.json({ error: 'Rate limited' }, 429);
  return c.json({ data: await service.start(actor(c), { ...c.req.valid('json'), orgId: oid(c) }) }, 202);
});
callerVerificationRoutes.get(`${cv}/:id`, ...base, read, async (c) => c.json({ data: await service.get(actor(c), oid(c), c.req.param('id')) }));
callerVerificationRoutes.post(`${cv}/:id/cancel`, ...base, write, requireMfa(), async (c) => c.json({ data: await service.cancel(actor(c), oid(c), c.req.param('id')) }));
callerVerificationRoutes.post(`${cv}/:id/attest`, ...base, write, requireMfa(), zValidator('json', attestCallerVerificationSchema), async (c) =>
  c.json({ data: await service.attest(actor(c), oid(c), c.req.param('id'), c.req.valid('json').note) }));

// --- Per-contact -------------------------------------------------------------

callerVerificationRoutes.get(`${contact}/caller-verifications`, ...base, read, async (c) => {
  await contactCheck(c);
  const orgId = oid(c);
  const contactId = cid(c);
  const policy = await getEffectivePolicy(orgId);
  const destinations = await db.select().from(d).where(and(eq(d.orgId, orgId), eq(d.contactId, contactId), isNull(d.supersededAt)));
  return c.json({ data: {
    ...await service.listForContact(actor(c), orgId, contactId),
    bindings: await bindingsForContact(orgId, contactId),
    destinations: destinations.map((r) => ({
      id: r.id, kind: r.kind, valueRedacted: r.valueRedacted, setAt: r.setAt, source: r.source, attestedAt: r.attestedAt, established: isEstablished(r, policy),
    })),
  } });
});
callerVerificationRoutes.get(`${contact}/caller-verifications/methods`, ...base, read, zValidator('query', callerVerificationMethodsQuerySchema), async (c) => {
  await contactCheck(c);
  return c.json({ data: await service.methodsForContact(actor(c), oid(c), cid(c), c.req.valid('query').actionScope) });
});
// Graph-backed (self-managed DB context): every DB phase opens its own short
// auth context; the Graph read runs with no transaction held.
callerVerificationRoutes.post(`${contact}/caller-verification-bindings`, ...base, write, requireMfa(), zValidator('json', callerVerificationBindingSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const body = c.req.valid('json');
  await withAuthDbAccessContext(auth, () => contactCheck(c));
  const row = await importDirectoryContact(auth, { orgId: oid(c), contactId: cid(c), directoryObjectId: body.entraOid, expectedTenantId: body.entraTenantId }, 'technician_attested');
  return c.json({ data: row }, row.revokedAt ? 409 : 201);
});
callerVerificationRoutes.delete(`${contact}/caller-verification-bindings/:bindingId`, ...base, write, requireMfa(), async (c) => {
  await contactCheck(c);
  const [row] = await db.select().from(b).where(and(eq(b.id, c.req.param('bindingId')), eq(b.orgId, oid(c)), eq(b.contactId, cid(c)))).limit(1);
  if (!row) return c.json({ error: 'Not found' }, 404);
  await revokeBinding(actor(c), oid(c), row.id);
  return c.json({ data: { ok: true } });
});
callerVerificationRoutes.post(`${contact}/caller-verification-destinations/:id/attest`, ...base, write, requireMfa(), async (c) => {
  await contactCheck(c);
  const [row] = await db.select().from(d).where(and(eq(d.id, c.req.param('id')), eq(d.orgId, oid(c)), eq(d.contactId, cid(c)))).limit(1);
  if (!row) return c.json({ error: 'Not found' }, 404);
  const result = await attestDestination(actor(c), oid(c), row.id);
  return c.json({ data: { id: result.id, attestedAt: result.attestedAt } });
});
callerVerificationRoutes.post(`${contact}/caller-verifications/fence-override`, ...base, write, requireMfa(), zValidator('json', callerVerificationFenceOverrideSchema), async (c) => {
  await contactCheck(c);
  await fenceOverride(actor(c), oid(c), cid(c), c.req.valid('json').reason);
  return c.json({ data: { ok: true } });
});
callerVerificationRoutes.get(`${orgPath}/tickets/:ticketId/caller-verification`, ...base, read, async (c) =>
  c.json({ data: await service.freshForTicket(actor(c), oid(c), c.req.param('ticketId')) }));

// --- Directory (Graph-backed, self-managed DB context) -----------------------

callerVerificationRoutes.get(`${orgPath}/caller-verification-directory-users`, ...base, read,
  zValidator('query', z.object({ search: z.string().trim().min(1).max(120).regex(/^[^"'\\]+$/) })), async (c) =>
    c.json({ data: await directoryUsers(c.get('auth') as AuthContext, oid(c), c.req.valid('query').search) }));
callerVerificationRoutes.post(`${orgPath}/caller-verification-directory-sync`, ...base, write, requireMfa(),
  zValidator('json', z.object({ mappings: z.array(z.object({ contactId: z.string().uuid(), entraOid: z.string().uuid() }).strict()).max(200) }).strict()), async (c) =>
    c.json({ data: await syncDirectory(c.get('auth') as AuthContext, oid(c), c.req.valid('json').mappings) }));

// --- Policy (org override + partner baseline) --------------------------------

for (const owner of ['org', 'partner'] as const) {
  const path = owner === 'org' ? `${orgPath}/caller-verification-policy` : '/partner/caller-verification-policy';
  const ownerWhere = async (c: Context) => {
    const a = c.get('auth') as AuthContext;
    if (owner === 'partner') {
      if (!a.partnerId || a.scope === 'organization') throw new CallerVerificationValidationError('not_found', 'Policy not found');
      return and(eq(p.partnerId, a.partnerId), isNull(p.orgId))!;
    }
    if (a.scope !== 'system' && !a.canAccessOrg(oid(c))) throw new CallerVerificationValidationError('not_found', 'Policy not found');
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, oid(c))).limit(1);
    if (!org) throw new CallerVerificationValidationError('not_found', 'Policy not found');
    return eq(p.orgId, oid(c));
  };
  const ownerId = (c: Context) => (owner === 'org' ? oid(c) : (c.get('auth') as AuthContext).partnerId!);
  callerVerificationRoutes.get(path, ...base, read, async (c) => {
    await ownerWhere(c);
    return c.json({ data: await getPolicyResponse(owner, ownerId(c)) });
  });
  callerVerificationRoutes.put(path, ...base, write, requireMfa(), zValidator('json', callerVerificationPolicySchema), async (c) => {
    const a = c.get('auth') as AuthContext;
    if (owner === 'partner' && !canManagePartnerWidePolicies(a)) return c.json({ error: 'Partner-wide administration required' }, 403);
    const where = await ownerWhere(c);
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-policy:${owner}:${ownerId(c)}`}))`);
    const [before] = await db.select().from(p).where(where).limit(1);
    const patch = c.req.valid('json');
    const [row] = before
      ? await db.update(p).set({ ...patch, updatedByUserId: a.user.id, updatedAt: new Date() }).where(where).returning()
      : await db.insert(p).values({ ...patch, orgId: owner === 'org' ? oid(c) : null, partnerId: owner === 'partner' ? a.partnerId : null, updatedByUserId: a.user.id }).returning();
    // A partner baseline that LOOSENS is audited under its own action name.
    const old = resolveEffectivePolicy(before ?? null, null);
    const next = resolveEffectivePolicy(row!, null);
    const weakened = owner === 'partner' && (
      next.requiredTierResetPassword < old.requiredTierResetPassword
      || next.requiredTierDisableUser < old.requiredTierDisableUser
      || (next.destinationMinAgeDays === 0 && old.destinationMinAgeDays !== 0)
      || (!old.allowCrossTechnicianUse && next.allowCrossTechnicianUse)
    );
    // Partner rows have org_id NULL, which the audit_logs org policy refuses
    // from a partner-scoped request transaction; the canonical audit writer
    // persists in its own system-scoped context. A config write does not need
    // the in-transaction atomicity the verification effects require.
    await createAuditLog({
      orgId: owner === 'org' ? oid(c) : null, actorType: 'user', actorId: a.user.id, actorEmail: a.user.email,
      action: weakened ? 'caller_verification.policy_weakened' : 'caller_verification.policy_updated',
      resourceType: 'caller_verification', resourceId: row!.id, result: 'success',
      details: { owner, before: before ?? null, after: row },
    });
    return c.json({ data: await getPolicyResponse(owner, ownerId(c)) });
  });
}
