import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { automationPolicies } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';
import { AuthContext, policyIdSchema } from './schemas';
import { getPolicyWithOrgCheck, normalizePolicyResponse } from './helpers';

export const actionRoutes = new Hono();

/**
 * Partner-wide policies (org_id NULL, #2129) mutate enforcement across every
 * org under the partner — administrable only with the partner-wide capability
 * (partner_users.org_access = 'all', same gate as the config-policy routes).
 */
function partnerWideWriteDenied(policy: { orgId: string | null }, auth: AuthContext): boolean {
  // The route-local AuthContext types scope as plain string; narrow for the
  // shared capability check (unknown scopes fail closed inside it anyway).
  return (
    policy.orgId === null &&
    !canManagePartnerWidePolicies({
      scope: auth.scope as 'system' | 'partner' | 'organization',
      partnerOrgAccess: auth.partnerOrgAccess ?? null,
    })
  );
}

// POST /policies/:id/activate, /policies/:id/evaluate, and /policies/:id/remediate
// were retired as a security hardening measure: they turned plain
// devices:read/devices:write into automation execution without the MFA,
// automations:write permission, or site-scoped-target checks the modern
// manual automation trigger (`POST /automations/:id/trigger`) enforces.
// Migrate callers to that endpoint. `deactivate` is unaffected — it only
// flips the policy's own `enabled` flag and does not execute automations.

// POST /policies/:id/deactivate
actionRoutes.post(
  '/:id/deactivate',
  requireScope('organization', 'partner', 'system'),
  // Mutates policy enforcement state — requires device-write.
  requirePermission('devices', 'write'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (partnerWideWriteDenied(policy, auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const [updated] = await db
      .update(automationPolicies)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(automationPolicies.id, id))
      .returning();

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'policy.deactivate',
      resourceType: 'policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: { enabled: { from: policy.enabled, to: false } },
    });

    return c.json(updated ? normalizePolicyResponse(updated) : policy);
  }
);
