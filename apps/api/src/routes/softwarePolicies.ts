import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  devices,
  softwareComplianceStatus,
  softwarePolicies,
} from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { scheduleSoftwareComplianceCheck } from '../jobs/softwareComplianceWorker';
import { scheduleSoftwareRemediation } from '../jobs/softwareRemediationWorker';
import {
  normalizeSoftwarePolicyRules,
  recordSoftwarePolicyAudit,
} from '../services/softwarePolicyService';

export const softwarePoliciesRoutes = new Hono();

softwarePoliciesRoutes.use('*', authMiddleware);
softwarePoliciesRoutes.use('*', requireScope('organization', 'partner', 'system'));

const policyIdParamSchema = z.object({
  id: z.string().uuid(),
});

const softwareRuleSchema = z.object({
  name: z.string().min(1).max(500),
  vendor: z.string().min(1).max(200).optional(),
  minVersion: z.string().min(1).max(100).optional(),
  maxVersion: z.string().min(1).max(100).optional(),
  catalogId: z.string().uuid().optional(),
  reason: z.string().min(1).max(1000).optional(),
});

const softwareRulesSchema = z.object({
  software: z.array(softwareRuleSchema).min(1),
  allowUnknown: z.boolean().optional(),
});

const remediationOptionsSchema = z.object({
  autoUninstall: z.boolean().optional(),
  notifyUser: z.boolean().optional(),
  gracePeriod: z.number().int().min(0).max(24 * 90).optional(),
  cooldownMinutes: z.number().int().min(1).max(24 * 90 * 60).optional(),
  maintenanceWindowOnly: z.boolean().optional(),
});

const targetTypeSchema = z.enum(['organization', 'site', 'device_group', 'devices']);

const listPoliciesQuerySchema = z.object({
  mode: z.enum(['allowlist', 'blocklist', 'audit']).optional(),
  targetType: targetTypeSchema.optional(),
  isActive: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createPolicySchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  mode: z.enum(['allowlist', 'blocklist', 'audit']),
  rules: softwareRulesSchema,
  targetType: targetTypeSchema,
  targetIds: z.array(z.string().uuid()).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  enforceMode: z.boolean().optional(),
  remediationOptions: remediationOptionsSchema.optional(),
});

const updatePolicySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  mode: z.enum(['allowlist', 'blocklist', 'audit']).optional(),
  rules: softwareRulesSchema.optional(),
  targetType: targetTypeSchema.optional(),
  targetIds: z.array(z.string().uuid()).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
  enforceMode: z.boolean().optional(),
  remediationOptions: remediationOptionsSchema.optional(),
});

const violationsQuerySchema = z.object({
  policyId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const optionalDeviceIdsSchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1).max(500).optional(),
});

export function resolveOrgIdForWrite(
  auth: AuthContext,
  requestedOrgId?: string
): { orgId?: string; error?: string } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required' };
    }
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Cannot write outside your organization' };
    }
    return { orgId: auth.orgId };
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access denied to this organization' };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  return { error: 'orgId is required for this scope' };
}

function normalizeTargetIds(
  targetType: z.infer<typeof targetTypeSchema>,
  targetIds?: string[] | null
): { targetIds: string[] | null; error?: string } {
  const normalized = Array.isArray(targetIds)
    ? Array.from(new Set(targetIds.filter((id) => typeof id === 'string' && id.length > 0)))
    : [];

  if (targetType === 'organization') {
    return { targetIds: null };
  }

  if (normalized.length === 0) {
    return { targetIds: null, error: `targetIds are required for targetType "${targetType}"` };
  }

  return { targetIds: normalized };
}

async function getPolicyWithAccess(policyId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(softwarePolicies.id, policyId)];
  const orgCondition = auth.orgCondition(softwarePolicies.orgId);
  if (orgCondition) conditions.push(orgCondition);

  const [policy] = await db
    .select()
    .from(softwarePolicies)
    .where(and(...conditions))
    .limit(1);

  return policy ?? null;
}

softwarePoliciesRoutes.get(
  '/',
  zValidator('query', listPoliciesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(softwarePolicies.orgId);
    if (orgCondition) conditions.push(orgCondition);
    if (query.mode) conditions.push(eq(softwarePolicies.mode, query.mode));
    if (query.targetType) conditions.push(eq(softwarePolicies.targetType, query.targetType));
    if (query.isActive !== undefined) conditions.push(eq(softwarePolicies.isActive, query.isActive === 'true'));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(softwarePolicies)
      .where(where);

    const rows = await db
      .select()
      .from(softwarePolicies)
      .where(where)
      .orderBy(desc(softwarePolicies.priority), desc(softwarePolicies.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows,
      pagination: {
        total: Number(countRow?.count ?? 0),
        limit,
        offset,
      },
    });
  }
);

softwarePoliciesRoutes.post(
  '/',
  zValidator('json', createPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    const resolvedOrg = resolveOrgIdForWrite(auth, payload.orgId);
    if (!resolvedOrg.orgId) {
      return c.json({ error: resolvedOrg.error ?? 'Organization resolution failed' }, 400);
    }

    const target = normalizeTargetIds(payload.targetType, payload.targetIds);
    if (target.error) {
      return c.json({ error: target.error }, 400);
    }

    const rules = normalizeSoftwarePolicyRules(payload.rules);
    if (rules.software.length === 0) {
      return c.json({ error: 'At least one software rule is required' }, 400);
    }

    const [policy] = await db
      .insert(softwarePolicies)
      .values({
        orgId: resolvedOrg.orgId,
        name: payload.name,
        description: payload.description ?? null,
        mode: payload.mode,
        rules,
        targetType: payload.targetType,
        targetIds: target.targetIds,
        priority: payload.priority ?? 50,
        enforceMode: payload.enforceMode ?? false,
        remediationOptions: payload.remediationOptions ?? null,
        createdBy: auth.user.id,
      })
      .returning();

    let scheduleWarning: string | undefined;
    try {
      await scheduleSoftwareComplianceCheck(policy.id);
    } catch (error) {
      scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule compliance check';
      console.error('[softwarePolicies] Failed to schedule compliance check', {
        policyId: policy.id,
        error,
      });
    }

    await recordSoftwarePolicyAudit({
      orgId: policy.orgId,
      policyId: policy.id,
      action: 'policy_created',
      actor: 'user',
      actorId: auth.user.id,
      details: {
        mode: policy.mode,
        targetType: policy.targetType,
      },
    });

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'software_policy.create',
      resourceType: 'software_policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: {
        mode: policy.mode,
        targetType: policy.targetType,
        enforceMode: policy.enforceMode,
        rules: rules.software.length,
        scheduleWarning,
      },
    });

    return c.json({ data: policy, warning: scheduleWarning }, 201);
  }
);

softwarePoliciesRoutes.get('/compliance/overview', async (c) => {
  const auth = c.get('auth');

  const conditions: SQL[] = [];
  const orgCondition = auth.orgCondition(devices.orgId);
  if (orgCondition) conditions.push(orgCondition);

  const rows = await db
    .select({
      deviceId: softwareComplianceStatus.deviceId,
      status: softwareComplianceStatus.status,
    })
    .from(softwareComplianceStatus)
    .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const byDevice = new Map<string, 'compliant' | 'violation' | 'unknown'>();
  for (const row of rows) {
    const status = row.status as 'compliant' | 'violation' | 'unknown';
    const current = byDevice.get(row.deviceId);
    if (!current) {
      byDevice.set(row.deviceId, status);
      continue;
    }

    if (status === 'violation') {
      byDevice.set(row.deviceId, 'violation');
      continue;
    }

    if (status === 'unknown' && current !== 'violation') {
      byDevice.set(row.deviceId, 'unknown');
    }
  }

  let compliant = 0;
  let violations = 0;
  let unknown = 0;
  for (const status of byDevice.values()) {
    if (status === 'compliant') compliant += 1;
    if (status === 'violation') violations += 1;
    if (status === 'unknown') unknown += 1;
  }

  return c.json({
    total: byDevice.size,
    compliant,
    violations,
    unknown,
  });
});

softwarePoliciesRoutes.get(
  '/violations',
  zValidator('query', violationsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const conditions: SQL[] = [eq(softwareComplianceStatus.status, 'violation')];
    const orgCondition = auth.orgCondition(devices.orgId);
    if (orgCondition) conditions.push(orgCondition);
    if (query.policyId) conditions.push(eq(softwareComplianceStatus.policyId, query.policyId));
    if (query.deviceId) conditions.push(eq(softwareComplianceStatus.deviceId, query.deviceId));

    const rows = await db
      .select({
        device: {
          id: devices.id,
          hostname: devices.hostname,
          status: devices.status,
          osType: devices.osType,
        },
        compliance: {
          id: softwareComplianceStatus.id,
          policyId: softwareComplianceStatus.policyId,
          status: softwareComplianceStatus.status,
          violations: softwareComplianceStatus.violations,
          lastChecked: softwareComplianceStatus.lastChecked,
          remediationStatus: softwareComplianceStatus.remediationStatus,
        },
      })
      .from(softwareComplianceStatus)
      .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
      .where(and(...conditions))
      .orderBy(desc(softwareComplianceStatus.lastChecked))
      .limit(query.limit ?? 100);

    return c.json({ data: rows, total: rows.length });
  }
);

softwarePoliciesRoutes.get(
  '/:id',
  zValidator('param', policyIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithAccess(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    return c.json({ data: policy });
  }
);

softwarePoliciesRoutes.patch(
  '/:id',
  zValidator('param', policyIdParamSchema),
  zValidator('json', updatePolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const policy = await getPolicyWithAccess(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const updates: Partial<typeof softwarePolicies.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (payload.name !== undefined) updates.name = payload.name;
    if (payload.description !== undefined) updates.description = payload.description;
    if (payload.mode !== undefined) updates.mode = payload.mode;
    if (payload.priority !== undefined) updates.priority = payload.priority;
    if (payload.isActive !== undefined) updates.isActive = payload.isActive;
    if (payload.enforceMode !== undefined) updates.enforceMode = payload.enforceMode;
    if (payload.remediationOptions !== undefined) updates.remediationOptions = payload.remediationOptions;

    if (payload.rules !== undefined) {
      const normalizedRules = normalizeSoftwarePolicyRules(payload.rules);
      if (normalizedRules.software.length === 0) {
        return c.json({ error: 'At least one software rule is required' }, 400);
      }
      updates.rules = normalizedRules;
    }

    if (payload.targetType !== undefined || payload.targetIds !== undefined) {
      const nextTargetType = payload.targetType ?? (policy.targetType as z.infer<typeof targetTypeSchema>);
      const nextTargetIds = payload.targetIds ?? (Array.isArray(policy.targetIds) ? policy.targetIds : undefined);
      const target = normalizeTargetIds(nextTargetType, nextTargetIds);
      if (target.error) {
        return c.json({ error: target.error }, 400);
      }
      updates.targetType = nextTargetType;
      updates.targetIds = target.targetIds;
    }

    const [updated] = await db
      .update(softwarePolicies)
      .set(updates)
      .where(eq(softwarePolicies.id, policy.id))
      .returning();

    let scheduleWarning: string | undefined;
    try {
      await scheduleSoftwareComplianceCheck(policy.id);
    } catch (error) {
      scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule compliance check';
      console.error('[softwarePolicies] Failed to schedule compliance check', {
        policyId: policy.id,
        error,
      });
    }

    await recordSoftwarePolicyAudit({
      orgId: policy.orgId,
      policyId: policy.id,
      action: 'policy_updated',
      actor: 'user',
      actorId: auth.user.id,
      details: {
        updatedFields: Object.keys(payload),
        scheduleWarning,
      },
    });

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'software_policy.update',
      resourceType: 'software_policy',
      resourceId: policy.id,
      resourceName: updated?.name ?? policy.name,
      details: {
        updatedFields: Object.keys(payload),
        scheduleWarning,
      },
    });

    return c.json({ data: updated ?? policy, warning: scheduleWarning });
  }
);

softwarePoliciesRoutes.delete(
  '/:id',
  zValidator('param', policyIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithAccess(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    await db.transaction(async (tx) => {
      await tx
        .update(softwarePolicies)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(softwarePolicies.id, id));

      await tx
        .delete(softwareComplianceStatus)
        .where(eq(softwareComplianceStatus.policyId, id));
    });

    await recordSoftwarePolicyAudit({
      orgId: policy.orgId,
      policyId: policy.id,
      action: 'policy_deleted',
      actor: 'user',
      actorId: auth.user.id,
      details: { name: policy.name },
    });

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'software_policy.delete',
      resourceType: 'software_policy',
      resourceId: policy.id,
      resourceName: policy.name,
    });

    return c.json({ success: true, id: policy.id });
  }
);

softwarePoliciesRoutes.post(
  '/:id/check',
  zValidator('param', policyIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithAccess(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    let rawPayload: unknown;
    try {
      rawPayload = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400);
    }
    const parsed = optionalDeviceIdsSchema.safeParse(rawPayload);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((issue) => issue.message).join('; ') }, 400);
    }

    const jobId = await scheduleSoftwareComplianceCheck(policy.id, parsed.data.deviceIds);

    await recordSoftwarePolicyAudit({
      orgId: policy.orgId,
      policyId: policy.id,
      action: 'compliance_check_requested',
      actor: 'user',
      actorId: auth.user.id,
      details: { jobId, deviceIds: parsed.data.deviceIds ?? null },
    });

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'software_policy.check',
      resourceType: 'software_policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: { jobId, deviceCount: parsed.data.deviceIds?.length ?? 0 },
    });

    return c.json({ message: 'Compliance check scheduled', jobId });
  }
);

softwarePoliciesRoutes.post(
  '/:id/remediate',
  zValidator('param', policyIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithAccess(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (policy.mode === 'audit') {
      return c.json({ error: 'Remediation is not available for audit-only policies' }, 400);
    }

    let rawPayload: unknown;
    try {
      rawPayload = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400);
    }
    const parsed = optionalDeviceIdsSchema.safeParse(rawPayload);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((issue) => issue.message).join('; ') }, 400);
    }

    let targetDeviceIds = parsed.data.deviceIds ?? [];

    if (targetDeviceIds.length > 0) {
      const deviceConditions: SQL[] = [inArray(devices.id, targetDeviceIds)];
      const orgCondition = auth.orgCondition(devices.orgId);
      if (orgCondition) deviceConditions.push(orgCondition);

      const allowedDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...deviceConditions));
      targetDeviceIds = allowedDevices.map((device) => device.id);
    } else {
      const complianceConditions: SQL[] = [
        eq(softwareComplianceStatus.policyId, policy.id),
        eq(softwareComplianceStatus.status, 'violation'),
      ];
      const orgCondition = auth.orgCondition(devices.orgId);
      if (orgCondition) complianceConditions.push(orgCondition);

      const rows = await db
        .select({ deviceId: softwareComplianceStatus.deviceId })
        .from(softwareComplianceStatus)
        .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
        .where(and(...complianceConditions));

      targetDeviceIds = Array.from(new Set(rows.map((row) => row.deviceId)));
    }

    if (targetDeviceIds.length === 0) {
      return c.json({ message: 'No matching violating devices found for remediation', queued: 0 });
    }

    const queued = await scheduleSoftwareRemediation(policy.id, targetDeviceIds);

    if (queued > 0) {
      await db
        .update(softwareComplianceStatus)
        .set({
          remediationStatus: 'pending',
          lastRemediationAttempt: new Date(),
        })
        .where(and(
          eq(softwareComplianceStatus.policyId, policy.id),
          inArray(softwareComplianceStatus.deviceId, targetDeviceIds),
        ));
    }

    await recordSoftwarePolicyAudit({
      orgId: policy.orgId,
      policyId: policy.id,
      action: 'remediation_requested',
      actor: 'user',
      actorId: auth.user.id,
      details: {
        requestedCount: targetDeviceIds.length,
        queued,
      },
    });

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'software_policy.remediate',
      resourceType: 'software_policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: {
        requestedCount: targetDeviceIds.length,
        queued,
      },
    });

    return c.json({
      message: `Remediation scheduled for ${queued} device(s)`,
      queued,
      deviceIds: targetDeviceIds,
    });
  }
);
