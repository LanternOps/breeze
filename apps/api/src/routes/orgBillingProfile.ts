import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { resolveBillingConfigurableOrg } from '../services/billingOrgAccess';
import { writeRouteAudit } from '../services/auditEvents';
import {
  getOrgAssignment, assignProfileToOrg, clearOrgAssignment, BillingProfileServiceError,
} from '../services/billingProfileService';

const orgIdSchema = z.string().uuid();
const assignmentSchema = z.object({ billingProfileId: z.string().uuid() });

async function resolveAccessibleOrg(c: Context): Promise<{ id: string; partnerId: string } | Response> {
  const auth = c.get('auth') as AuthContext;
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
  const parsed = orgIdSchema.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'Invalid organization ID' }, 400);
  // Shared with manage_billing_profiles (services/billingOrgAccess.ts, W14 #6784).
  const org = await resolveBillingConfigurableOrg(auth, parsed.data);
  if (!org) return c.json({ error: 'Organization not found' }, 404);
  return org;
}

function fail(c: Context, err: unknown) {
  if (err instanceof BillingProfileServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status as 400);
  }
  throw err;
}

// Registered on orgRoutes to inherit its authentication middleware.
export function registerOrgBillingProfileRoutes(orgRoutes: Hono) {
  const partnerOnly = requireScope('partner');
  const read = requirePermission(PERMISSIONS.BILLING_PROFILES_READ.resource, PERMISSIONS.BILLING_PROFILES_READ.action);
  const write = requirePermission(PERMISSIONS.BILLING_PROFILES_WRITE.resource, PERMISSIONS.BILLING_PROFILES_WRITE.action);

  orgRoutes.get('/organizations/:id/billing-profile', partnerOnly, read, async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    try {
      return c.json({ assignment: await getOrgAssignment(org.id, org.partnerId) });
    } catch (err) { return fail(c, err); }
  });

  orgRoutes.put('/organizations/:id/billing-profile', partnerOnly, write, requireMfa(), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const parsed = assignmentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid billing profile assignment', issues: parsed.error.issues }, 400);
    try {
      const before = await getOrgAssignment(org.id, org.partnerId);
      const assignment = await assignProfileToOrg(org.id, org.partnerId, parsed.data.billingProfileId, c.get('auth').user.id);
      writeRouteAudit(c, {
        orgId: org.id, action: 'organization.billing_profile.assign', resourceType: 'organization', resourceId: org.id,
        details: { before, after: assignment },
      });
      return c.json({ assignment });
    } catch (err) { return fail(c, err); }
  });

  orgRoutes.delete('/organizations/:id/billing-profile', partnerOnly, write, requireMfa(), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    try {
      const before = await getOrgAssignment(org.id, org.partnerId);
      await clearOrgAssignment(org.id, org.partnerId);
      writeRouteAudit(c, {
        orgId: org.id, action: 'organization.billing_profile.clear', resourceType: 'organization', resourceId: org.id,
        details: { before, after: null },
      });
      return c.json({ assignment: null });
    } catch (err) { return fail(c, err); }
  });
}
