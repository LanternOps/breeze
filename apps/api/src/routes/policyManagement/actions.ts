import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { automationPolicies, automationRuns, automations, organizations } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  canManagePartnerWidePolicies,
  canReadPartnerWideRows,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';
import {
  MANAGED_AUTOMATION_ERROR_CODE,
  isManagedAutomation,
} from '../../services/aiAgents/managedAutomation';
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
      // Runs in the CALLER's context, so the remediation-automation lookup must
      // apply the caller's partner-wide visibility rather than the worker's
      // system visibility (#4952).
      auth,
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

    const targetAutomationId = await resolvePolicyRemediationAutomationId(policy, auth);
    if (!targetAutomationId) {
      return c.json({
        error: 'No remediation automation is configured on this policy',
        hint: 'Set rule.remediationAutomationId, rule.remediation.automationId, or link remediationScriptId to an automation action',
      }, 400);
    }

    // Automations are dual-owned (#2133). An org-owned policy anchors the
    // lookup to its own org OR its partner's partner-wide automations; a
    // partner-wide policy (org_id NULL, #2129) accepts an explicit automation
    // from any org under the owning partner OR the partner's own
    // partner-wide automations.
    //
    // The partner-wide arm is gated on canReadPartnerWideRows (#4952). This
    // route enqueues with NO target argument, so automationRuntime expands a
    // partner-wide automation across every org under the partner: without the
    // gate an org admin holding devices:write on an org-owned policy could run
    // an automation against OTHER orgs' devices.
    //
    // RLS does not backstop this. Org tokens carry a partnerId
    // (DbAccessContext.currentPartnerId), and automations' partner-wide SELECT
    // branch deliberately makes those rows readable from an org context, so
    // this gate is the whole control — mirrors canAccessAutomation in
    // routes/automations.ts, which already restricts the same rows to partner
    // and system scope.
    let automationOwnerCondition;
    if (policy.orgId) {
      const [policyOrg] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, policy.orgId))
        .limit(1);
      const partnerWideVisible = canReadPartnerWideRows(auth, policyOrg?.partnerId ?? null);
      automationOwnerCondition = policyOrg?.partnerId && partnerWideVisible
        ? or(
            eq(automations.orgId, policy.orgId),
            and(isNull(automations.orgId), eq(automations.partnerId, policyOrg.partnerId))
          )
        : eq(automations.orgId, policy.orgId);
    } else {
      // A partner-wide policy already required partner-wide administration
      // above (partnerWideWriteDenied), so the caller is system or a full
      // partner admin; assert the partner match anyway rather than trusting a
      // second gate to have run.
      const orgOwnedArm = inArray(
        automations.orgId,
        db
          .select({ id: organizations.id })
          .from(organizations)
          // The hidden 'quick_support' org never owns automations — keep it out
          // of the partner-wide ownership set. (The by-id lookup above is left
          // alone; it resolves one known org.)
          .where(and(eq(organizations.partnerId, policy.partnerId ?? ''), ne(organizations.type, 'quick_support')))
      );
      automationOwnerCondition = canReadPartnerWideRows(auth, policy.partnerId)
        ? or(
            orgOwnedArm,
            and(isNull(automations.orgId), eq(automations.partnerId, policy.partnerId ?? ''))
          )
        : orgOwnedArm;
    }

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

    // Defense in depth on the loaded row (#4952). The WHERE above already
    // drops the partner-wide arm for a caller that may not read it, but this
    // route is the fleet-fan-out path — re-check the row itself so a future
    // edit to the condition builder cannot silently reopen it. 404, not 403:
    // no oracle distinguishing "absent" from "another tenant's".
    if (automation.orgId === null && !canReadPartnerWideRows(auth, automation.partnerId)) {
      return c.json({ error: 'Remediation automation not found for this organization' }, 404);
    }

    // This route enqueues with no target argument, so the runtime resolves the
    // automation's full configured target set. Pointing remediation at the
    // managed row would therefore be a literal fleet fan-out.
    if (isManagedAutomation(automation)) {
      return c.json({ error: MANAGED_AUTOMATION_ERROR_CODE, agentId: automation.managedByAgentId }, 409);
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

    if (!run) {
      // The insert returned no row, so there is nothing to dispatch. Fail
      // loudly rather than returning the "triggered" message for a run that
      // does not exist — claiming success we did not achieve is the very bug
      // this change removes.
      return c.json({ error: 'Failed to create remediation run' }, 500);
    }

    // Dispatch for real. Without this the row sits 'running' forever and no
    // script executes, while the response still claims the automation was
    // triggered — the same silent no-op fixed for the two policy-evaluation
    // sites in #3414. No target argument: this route remediates the policy's
    // own target set, so the runtime resolves targets from the automation
    // rather than a single device.
    //
    // Dynamically imported to keep the BullMQ worker graph out of this route's
    // module load, matching policyEvaluationService and drExecutionService.
    const { enqueueAutomationRun } = await import('../../jobs/automationWorker');
    await enqueueAutomationRun(run.id);

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
