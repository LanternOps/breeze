import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { automationPolicies, automationPolicyCompliance, scripts } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  AuthContext,
  listPoliciesSchema,
  createPolicySchema,
  updatePolicySchema,
  policyIdSchema,
} from './schemas';
import {
  getPagination,
  ensureOrgAccess,
  getPolicyWithOrgCheck,
  sanitizeStringArray,
  normalizeTargets,
  validateTargetIdsForType,
  normalizePolicyResponse,
  getPolicyComplianceMap,
  buildComplianceSummary,
} from './helpers';

export const crudRoutes = new Hono();

// GET /policies
crudRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPoliciesSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions: ReturnType<typeof eq>[] = [];

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(automationPolicies.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(automationPolicies.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({ data: [], pagination: { page, limit, total: 0 } });
        }
        conditions.push(inArray(automationPolicies.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(automationPolicies.orgId, query.orgId));
    }

    if (query.enforcement) {
      conditions.push(eq(automationPolicies.enforcement, query.enforcement));
    }

    if (query.enabled !== undefined) {
      conditions.push(eq(automationPolicies.enabled, query.enabled === 'true'));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationPolicies)
      .where(whereCondition);

    const total = Number(countResult[0]?.count ?? 0);

    const policiesList = await db
      .select()
      .from(automationPolicies)
      .where(whereCondition)
      .orderBy(desc(automationPolicies.updatedAt))
      .limit(limit)
      .offset(offset);

    const complianceMap = await getPolicyComplianceMap(policiesList.map((policy) => policy.id));

    return c.json({
      data: policiesList.map((policy) => normalizePolicyResponse(policy, complianceMap.get(policy.id))),
      pagination: { page, limit, total },
    });
  }
);

// GET /policies/:id
crudRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    if (['compliance'].includes(id)) {
      return c.notFound();
    }

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const complianceRows = await db
      .select({
        status: automationPolicyCompliance.status,
        count: sql<number>`count(*)`,
      })
      .from(automationPolicyCompliance)
      .where(eq(automationPolicyCompliance.policyId, id))
      .groupBy(automationPolicyCompliance.status);

    let remediationScript: { id: string; name: string } | null = null;
    if (policy.remediationScriptId) {
      const [script] = await db
        .select({ id: scripts.id, name: scripts.name })
        .from(scripts)
        .where(eq(scripts.id, policy.remediationScriptId))
        .limit(1);

      remediationScript = script ?? null;
    }

    return c.json(normalizePolicyResponse(policy, buildComplianceSummary(complianceRows), remediationScript));
  }
);

// POST /policies
crudRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createPolicySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const data = c.req.valid('json');

    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const normalizedTargets = normalizeTargets({
      targets: data.targets,
      targetType: data.targetType,
      targetIds: data.targetIds,
    });
    const normalizedTargetIds = sanitizeStringArray(normalizedTargets.targetIds);

    const targetValidationError = validateTargetIdsForType(
      normalizedTargets.targetType,
      normalizedTargetIds
    );
    if (targetValidationError) {
      return c.json({ error: targetValidationError }, 400);
    }
    normalizedTargets.targetIds = normalizedTargetIds;

    if (data.remediationScriptId) {
      const [script] = await db
        .select({ id: scripts.id })
        .from(scripts)
        .where(
          and(
            eq(scripts.id, data.remediationScriptId),
            eq(scripts.orgId, orgId as string)
          )
        )
        .limit(1);

      if (!script) {
        return c.json({ error: 'Remediation script not found or belongs to different organization' }, 400);
      }
    }

    const [policy] = await db
      .insert(automationPolicies)
      .values({
        orgId: orgId as string,
        name: data.name,
        description: data.description,
        enabled: data.enabled,
        targets: normalizedTargets,
        rules: data.rules,
        enforcement: data.enforcement ?? data.enforcementLevel ?? 'monitor',
        checkIntervalMinutes: data.checkIntervalMinutes,
        remediationScriptId: data.remediationScriptId,
        createdBy: auth.user.id,
      })
      .returning();

    writeRouteAudit(c, {
      orgId: policy?.orgId,
      action: 'policy.create',
      resourceType: 'policy',
      resourceId: policy?.id,
      resourceName: policy?.name,
      details: {
        enabled: policy?.enabled,
        enforcement: policy?.enforcement,
      },
    });

    if (!policy) {
      return c.json({ error: 'Failed to create policy' }, 500);
    }

    return c.json(normalizePolicyResponse(policy), 201);
  }
);

async function handleUpdatePolicy(c: any) {
  const auth = c.get('auth') as AuthContext;
  const policyId = c.req.param('id');
  const data = c.req.valid('json') as z.infer<typeof updatePolicySchema>;

  if (Object.keys(data).length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  const policy = await getPolicyWithOrgCheck(policyId, auth);
  if (!policy) {
    return c.json({ error: 'Policy not found' }, 404);
  }

  if (data.remediationScriptId !== undefined && data.remediationScriptId !== null) {
    const [script] = await db
      .select({ id: scripts.id })
      .from(scripts)
      .where(
        and(
          eq(scripts.id, data.remediationScriptId),
          eq(scripts.orgId, policy.orgId)
        )
      )
      .limit(1);

    if (!script) {
      return c.json({ error: 'Remediation script not found or belongs to different organization' }, 400);
    }
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.enabled !== undefined) updates.enabled = data.enabled;
  if (data.rules !== undefined) updates.rules = data.rules;
  if (data.enforcement !== undefined) updates.enforcement = data.enforcement;
  if (data.enforcementLevel !== undefined) updates.enforcement = data.enforcementLevel;
  if (data.checkIntervalMinutes !== undefined) updates.checkIntervalMinutes = data.checkIntervalMinutes;
  if (data.remediationScriptId !== undefined) updates.remediationScriptId = data.remediationScriptId;

  if (data.targets !== undefined || data.targetType !== undefined || data.targetIds !== undefined) {
    const normalizedTargets = normalizeTargets({
      targets: data.targets,
      targetType: data.targetType,
      targetIds: data.targetIds,
    });
    const normalizedTargetIds = sanitizeStringArray(normalizedTargets.targetIds);

    const targetValidationError = validateTargetIdsForType(
      normalizedTargets.targetType,
      normalizedTargetIds
    );
    if (targetValidationError) {
      return c.json({ error: targetValidationError }, 400);
    }
    normalizedTargets.targetIds = normalizedTargetIds;

    updates.targets = normalizedTargets;
  }

  const [updated] = await db
    .update(automationPolicies)
    .set(updates)
    .where(eq(automationPolicies.id, policyId))
    .returning();

  writeRouteAudit(c, {
    orgId: policy.orgId,
    action: 'policy.update',
    resourceType: 'policy',
    resourceId: updated?.id,
    resourceName: updated?.name,
    details: { changedFields: Object.keys(data) },
  });

  if (!updated) {
    return c.json({ error: 'Failed to update policy' }, 500);
  }

  return c.json(normalizePolicyResponse(updated));
}

// PUT /policies/:id
crudRoutes.put(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  zValidator('json', updatePolicySchema),
  async (c) => handleUpdatePolicy(c)
);

// PATCH /policies/:id
crudRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  zValidator('json', updatePolicySchema),
  async (c) => handleUpdatePolicy(c)
);

// DELETE /policies/:id
crudRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithOrgCheck(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    await db
      .delete(automationPolicyCompliance)
      .where(eq(automationPolicyCompliance.policyId, id));

    await db
      .delete(automationPolicies)
      .where(eq(automationPolicies.id, id));

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'policy.delete',
      resourceType: 'policy',
      resourceId: policy.id,
      resourceName: policy.name,
    });

    return c.json({ success: true });
  }
);
