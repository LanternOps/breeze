import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { automationPolicies, automationRuns, automations, organizations } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';
import { evaluatePolicy, resolvePolicyRemediationAutomationId } from '../../services/policyEvaluationService';
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

// POST /policies/:id/activate
actionRoutes.post(
  '/:id/activate',
  requireScope('organization', 'partner', 'system'),
  // requireScope only checks tenancy tier, not role. Toggling policy state
  // mutates enforcement that drives device automations, so gate on device-write.
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
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(automationPolicies.id, id))
      .returning();

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'policy.activate',
      resourceType: 'policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: { enabled: { from: policy.enabled, to: true } },
    });

    return c.json(updated ? normalizePolicyResponse(updated) : policy);
  }
);

// POST /policies/:id/deactivate
actionRoutes.post(
  '/:id/deactivate',
  requireScope('organization', 'partner', 'system'),
  // Mutates policy enforcement state (see activate) — requires device-write.
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

// POST /policies/:id/evaluate
actionRoutes.post(
  '/:id/evaluate',
  requireScope('organization', 'partner', 'system'),
  // Evaluate is a read-trigger (assesses compliance, may request remediation).
  // Gate on at least device-read so a no-permission user can't trigger it.
  requirePermission('devices', 'read'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    // Evaluate requests remediation, so for a partner-wide policy it fans
    // enforcement out to EVERY org under the partner — gate it like the
    // sibling mutators, not like a read (#2149 review).
    if (partnerWideWriteDenied(policy, auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    if (!policy.enabled) {
      return c.json({ error: 'Cannot evaluate disabled policy' }, 400);
    }

    const result = await evaluatePolicy(policy, {
      source: 'policies-route',
      requestRemediation: true,
    });

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'policy.evaluate',
      resourceType: 'policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: { devicesEvaluated: result.devicesEvaluated },
    });

    return c.json(result);
  }
);

// POST /policies/:id/remediate - trigger remediation without evaluation
actionRoutes.post(
  '/:id/remediate',
  requireScope('organization', 'partner', 'system'),
  // Triggers a remediation automation run against devices — a state-mutating,
  // execute-like action. Gate on device-write (mirrors activate/deactivate).
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

    const targetAutomationId = await resolvePolicyRemediationAutomationId(policy);
    if (!targetAutomationId) {
      return c.json({
        error: 'No remediation automation is configured on this policy',
        hint: 'Set rule.remediationAutomationId, rule.remediation.automationId, or link remediationScriptId to an automation action',
      }, 400);
    }

    // Automations are org-owned. An org-owned policy anchors the lookup to its
    // own org; a partner-wide policy (org_id NULL, #2129) accepts an explicit
    // automation from any org under the owning partner.
    const automationOwnerCondition = policy.orgId
      ? eq(automations.orgId, policy.orgId)
      : inArray(
          automations.orgId,
          db
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.partnerId, policy.partnerId ?? ''))
        );

    const [automation] = await db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.id, targetAutomationId),
          automationOwnerCondition
        )
      )
      .limit(1);

    if (!automation) {
      return c.json({ error: 'Remediation automation not found for this organization' }, 404);
    }

    if (!automation.enabled) {
      return c.json({ error: 'Remediation automation is disabled' }, 400);
    }

    const [run] = await db
      .insert(automationRuns)
      .values({
        automationId: automation.id,
        triggeredBy: `policy-remediation:${policy.id}`,
        status: 'running',
        devicesTargeted: 0,
        devicesSucceeded: 0,
        devicesFailed: 0,
        logs: [{
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `Triggered from policy ${policy.name}`,
          policyId: policy.id,
        }],
      })
      .returning({ id: automationRuns.id, status: automationRuns.status, startedAt: automationRuns.startedAt });

    await db
      .update(automations)
      .set({
        runCount: sql`${automations.runCount} + 1`,
        lastRunAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(automations.id, automation.id));

    return c.json({
      message: 'Remediation automation triggered',
      policyId: policy.id,
      automationId: automation.id,
      run,
    });
  }
);
