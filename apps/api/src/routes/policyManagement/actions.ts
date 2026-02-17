import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { automationPolicies, automationRuns, automations } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { evaluatePolicy, resolvePolicyRemediationAutomationId } from '../../services/policyEvaluationService';
import { AuthContext, policyIdSchema } from './schemas';
import { getPolicyWithOrgCheck, normalizePolicyResponse } from './helpers';

export const actionRoutes = new Hono();

// POST /policies/:id/activate
actionRoutes.post(
  '/:id/activate',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const [updated] = await db
      .update(automationPolicies)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(automationPolicies.id, id))
      .returning();

    return c.json(updated ? normalizePolicyResponse(updated) : policy);
  }
);

// POST /policies/:id/deactivate
actionRoutes.post(
  '/:id/deactivate',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const [updated] = await db
      .update(automationPolicies)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(automationPolicies.id, id))
      .returning();

    return c.json(updated ? normalizePolicyResponse(updated) : policy);
  }
);

// POST /policies/:id/evaluate
actionRoutes.post(
  '/:id/evaluate',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
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
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const targetAutomationId = await resolvePolicyRemediationAutomationId(policy);
    if (!targetAutomationId) {
      return c.json({
        error: 'No remediation automation is configured on this policy',
        hint: 'Set rule.remediationAutomationId, rule.remediation.automationId, or link remediationScriptId to an automation action',
      }, 400);
    }

    const [automation] = await db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.id, targetAutomationId),
          eq(automations.orgId, policy.orgId)
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
