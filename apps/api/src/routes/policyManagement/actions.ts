import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { automationPolicies } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { invalidateOrgPolicyProbeCache } from '../../services/agentOrgSettingsCache';
import { scheduleComplianceAlertReconcile } from '../../services/complianceAlertReconcileTrigger';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';
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
  requireMfa(),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    // Turning off compliance evaluation/remediation for a policy is an
    // org-wide governance write — same capability class as the other
    // objects in `canMutateOrgWideGovernance`'s family, even though
    // `automation_policies` isn't in the site-ceiling contract's hand-listed
    // table set. A site-restricted caller can silently stop enforcement for
    // devices at sites they cannot see. The route-local `AuthContext` (above)
    // doesn't carry `allowedSiteIds`/`allowedDeviceIds`, so check against the
    // raw context value, which does.
    if (!canMutateOrgWideGovernance(c.get('auth'))) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }

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

    // A disabled policy is never evaluated again, so no policy.compliant will
    // close the alerts it raised; the compliance-alert reconcile does.
    const owner = policy.orgId !== null
      ? { orgId: policy.orgId }
      : policy.partnerId ? { partnerId: policy.partnerId } : null;
    if (updated && owner) scheduleComplianceAlertReconcile(owner, 'automation-policy-deactivate');
    // Every agent of this org (every org, for a partner-wide policy) gets this
    // policy's probes from a 60 s per-org heartbeat cache (#8053).
    if (updated) invalidateOrgPolicyProbeCache(policy.orgId ?? undefined);

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
