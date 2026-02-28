import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  peripheralDeviceClassEnum,
  peripheralEventTypeEnum,
  peripheralEvents,
  peripheralPolicies,
  peripheralPolicyActionEnum,
  peripheralPolicyTargetTypeEnum,
  type PeripheralExceptionRule,
  type PeripheralPolicyTargetIds
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { schedulePeripheralPolicyDistribution } from '../jobs/peripheralJobs';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import { publishEvent } from '../services/eventBus';

export const peripheralControlRoutes = new Hono();
const MAX_ACTIVITY_WINDOW_DAYS = 90;

peripheralControlRoutes.use('*', authMiddleware);
peripheralControlRoutes.use('*', requireScope('organization', 'partner', 'system'));

const policySchema = z.object({
  id: z.string().uuid().optional(),
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  deviceClass: z.enum(peripheralDeviceClassEnum.enumValues),
  action: z.enum(peripheralPolicyActionEnum.enumValues),
  targetType: z.enum(peripheralPolicyTargetTypeEnum.enumValues).optional().default('organization'),
  targetIds: z.object({
    siteIds: z.array(z.string().uuid()).max(1000).optional(),
    groupIds: z.array(z.string().uuid()).max(1000).optional(),
    deviceIds: z.array(z.string().uuid()).max(5000).optional(),
  }).optional().default({}),
  exceptions: z.array(z.object({
    vendor: z.string().min(1).max(255).optional(),
    product: z.string().min(1).max(255).optional(),
    serialNumber: z.string().min(1).max(255).optional(),
    allow: z.boolean().optional(),
    reason: z.string().min(1).max(2000).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  }).superRefine((value, ctx) => {
    if (!value.vendor && !value.product && !value.serialNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of vendor, product, or serialNumber is required',
      });
    }
  })).max(2000).optional(),
  isActive: z.boolean().optional(),
});

const listPoliciesQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  isActive: z.enum(['true', 'false']).optional(),
  action: z.enum(peripheralPolicyActionEnum.enumValues).optional(),
  deviceClass: z.enum(peripheralDeviceClassEnum.enumValues).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const listActivityQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  policyId: z.string().uuid().optional(),
  eventType: z.enum(peripheralEventTypeEnum.enumValues).optional(),
  peripheralType: z.string().min(1).max(40).optional(),
  vendor: z.string().min(1).max(255).optional(),
  product: z.string().min(1).max(255).optional(),
  serialNumber: z.string().min(1).max(255).optional(),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const disablePolicyParamSchema = z.object({
  id: z.string().uuid(),
});

const exceptionsSchema = z.object({
  policyId: z.string().uuid(),
  operation: z.enum(['add', 'remove']),
  exception: z.object({
    vendor: z.string().min(1).max(255).optional(),
    product: z.string().min(1).max(255).optional(),
    serialNumber: z.string().min(1).max(255).optional(),
    allow: z.boolean().optional(),
    reason: z.string().min(1).max(2000).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  }).superRefine((value, ctx) => {
    if (!value.vendor && !value.product && !value.serialNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of vendor, product, or serialNumber is required',
      });
    }
  }).optional(),
  match: z.object({
    vendor: z.string().min(1).max(255).optional(),
    product: z.string().min(1).max(255).optional(),
    serialNumber: z.string().min(1).max(255).optional(),
  }).superRefine((value, ctx) => {
    if (!value.vendor && !value.product && !value.serialNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of vendor, product, or serialNumber is required',
      });
    }
  }).optional(),
}).superRefine((value, ctx) => {
  if (value.operation === 'add' && !value.exception) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exception is required for add operation',
      path: ['exception'],
    });
  }

  if (value.operation === 'remove' && !value.match) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'match is required for remove operation',
      path: ['match'],
    });
  }
});

function resolveOrgIdForWrite(
  auth: AuthContext,
  requestedOrgId?: string
): { orgId?: string; error?: string; status?: 400 | 403 } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required', status: 403 };
    }
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Cannot write outside your organization', status: 403 };
    }
    return { orgId: auth.orgId };
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access denied to this organization', status: 403 };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  return { error: 'orgId is required for this scope', status: 400 };
}

function combineWarning(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function normalizeExceptionRule(rule: z.infer<typeof exceptionsSchema>['exception']): PeripheralExceptionRule | null {
  if (!rule) return null;
  return {
    vendor: rule.vendor?.trim() || undefined,
    product: rule.product?.trim() || undefined,
    serialNumber: rule.serialNumber?.trim() || undefined,
    allow: rule.allow ?? true,
    reason: rule.reason?.trim() || undefined,
    expiresAt: rule.expiresAt
  };
}

function sanitizeTargetIds(targetIds: z.infer<typeof policySchema>['targetIds']): PeripheralPolicyTargetIds {
  if (!targetIds) return {};
  return {
    siteIds: targetIds.siteIds ?? [],
    groupIds: targetIds.groupIds ?? [],
    deviceIds: targetIds.deviceIds ?? [],
  };
}

async function getPolicyWithAccess(policyId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(peripheralPolicies.id, policyId)];
  const orgCondition = auth.orgCondition(peripheralPolicies.orgId);
  if (orgCondition) conditions.push(orgCondition);

  const [policy] = await db
    .select()
    .from(peripheralPolicies)
    .where(and(...conditions))
    .limit(1);

  return policy ?? null;
}

async function emitPolicyChanged(
  orgId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await publishEvent(
    'peripheral.policy_changed',
    orgId,
    payload,
    'peripheral-control-routes'
  );
}

peripheralControlRoutes.get(
  '/activity',
  zValidator('query', listActivityQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(peripheralEvents.orgId);
    if (orgCondition) conditions.push(orgCondition);

    if (query.orgId) conditions.push(eq(peripheralEvents.orgId, query.orgId));
    if (query.deviceId) conditions.push(eq(peripheralEvents.deviceId, query.deviceId));
    if (query.policyId) conditions.push(eq(peripheralEvents.policyId, query.policyId));
    if (query.eventType) conditions.push(eq(peripheralEvents.eventType, query.eventType));
    if (query.peripheralType) conditions.push(eq(peripheralEvents.peripheralType, query.peripheralType));
    if (query.vendor) conditions.push(eq(peripheralEvents.vendor, query.vendor));
    if (query.product) conditions.push(eq(peripheralEvents.product, query.product));
    if (query.serialNumber) conditions.push(eq(peripheralEvents.serialNumber, query.serialNumber));

    const start = query.start ? new Date(query.start) : null;
    const end = query.end ? new Date(query.end) : null;
    const effectiveStart = start ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const effectiveEnd = end ?? new Date();

    if (effectiveStart.getTime() > effectiveEnd.getTime()) {
      return c.json({ error: 'start must be before or equal to end' }, 400);
    }

    const maxWindowMs = MAX_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if ((effectiveEnd.getTime() - effectiveStart.getTime()) > maxWindowMs) {
      return c.json({ error: `Time range cannot exceed ${MAX_ACTIVITY_WINDOW_DAYS} days` }, 400);
    }

    conditions.push(gte(peripheralEvents.occurredAt, effectiveStart));
    conditions.push(lte(peripheralEvents.occurredAt, effectiveEnd));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(peripheralEvents)
      .where(where);

    const rows = await db
      .select()
      .from(peripheralEvents)
      .where(where)
      .orderBy(desc(peripheralEvents.occurredAt), desc(peripheralEvents.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows,
      pagination: {
        total: Number(countRow?.count ?? 0),
        limit,
        offset
      }
    });
  }
);

peripheralControlRoutes.get(
  '/policies',
  zValidator('query', listPoliciesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(peripheralPolicies.orgId);
    if (orgCondition) conditions.push(orgCondition);

    if (query.orgId) conditions.push(eq(peripheralPolicies.orgId, query.orgId));
    if (query.isActive !== undefined) conditions.push(eq(peripheralPolicies.isActive, query.isActive === 'true'));
    if (query.action) conditions.push(eq(peripheralPolicies.action, query.action));
    if (query.deviceClass) conditions.push(eq(peripheralPolicies.deviceClass, query.deviceClass));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(peripheralPolicies)
      .where(where);

    const rows = await db
      .select()
      .from(peripheralPolicies)
      .where(where)
      .orderBy(desc(peripheralPolicies.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows,
      pagination: {
        total: Number(countRow?.count ?? 0),
        limit,
        offset
      }
    });
  }
);

peripheralControlRoutes.get(
  '/policies/:id',
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id');
    const policy = await getPolicyWithAccess(id, auth);
    if (!policy) return c.json({ error: 'Policy not found' }, 404);
    return c.json({ data: policy });
  }
);

peripheralControlRoutes.post(
  '/policies',
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', policySchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    const policyId = payload.id;
    const now = new Date();

    if (policyId) {
      const existing = await getPolicyWithAccess(policyId, auth);
      if (!existing) {
        return c.json({ error: 'Policy not found' }, 404);
      }

      const [updated] = await db
        .update(peripheralPolicies)
        .set({
          name: payload.name,
          deviceClass: payload.deviceClass,
          action: payload.action,
          targetType: payload.targetType,
          targetIds: sanitizeTargetIds(payload.targetIds),
          exceptions: payload.exceptions ?? [],
          isActive: payload.isActive ?? existing.isActive,
          updatedAt: now
        })
        .where(eq(peripheralPolicies.id, existing.id))
        .returning();

      if (!updated) {
        return c.json({ error: 'Failed to update policy' }, 500);
      }

      let distributionWarning: string | undefined;
      try {
        await schedulePeripheralPolicyDistribution(updated.orgId, [updated.id], 'policy-updated');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        distributionWarning = combineWarning(distributionWarning, `distribution scheduling failed: ${message}`);
        console.error(`[peripheralControl] Failed to schedule policy distribution for policy ${updated.id}:`, error);
      }

      try {
        await emitPolicyChanged(updated.orgId, {
          policyId: updated.id,
          action: 'updated',
          changedBy: auth.user.id
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        distributionWarning = combineWarning(distributionWarning, `event publish failed: ${message}`);
        console.error(`[peripheralControl] Failed to emit policy change event for policy ${updated.id}:`, error);
      }

      try {
        writeRouteAudit(c, {
          orgId: updated.orgId,
          action: 'peripheral.policy.update',
          resourceType: 'peripheral_policy',
          resourceId: updated.id,
          resourceName: updated.name,
          details: {
            deviceClass: updated.deviceClass,
            actionMode: updated.action,
            targetType: updated.targetType,
            distributionWarning
          }
        });
      } catch (error) {
        console.error(`[peripheralControl] Failed to write audit for policy ${updated.id}:`, error);
      }

      return c.json({ data: updated, warning: distributionWarning });
    }

    const orgResolution = resolveOrgIdForWrite(auth, payload.orgId);
    if (!orgResolution.orgId) {
      return c.json({ error: orgResolution.error ?? 'Organization resolution failed' }, orgResolution.status ?? 400);
    }

    const [created] = await db
      .insert(peripheralPolicies)
      .values({
        orgId: orgResolution.orgId,
        name: payload.name,
        deviceClass: payload.deviceClass,
        action: payload.action,
        targetType: payload.targetType,
        targetIds: sanitizeTargetIds(payload.targetIds),
        exceptions: payload.exceptions ?? [],
        isActive: payload.isActive ?? true,
        createdBy: auth.user.id,
      })
      .returning();

    if (!created) {
      return c.json({ error: 'Failed to create policy' }, 500);
    }

    let distributionWarning: string | undefined;
    try {
      await schedulePeripheralPolicyDistribution(created.orgId, [created.id], 'policy-created');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      distributionWarning = combineWarning(distributionWarning, `distribution scheduling failed: ${message}`);
      console.error(`[peripheralControl] Failed to schedule policy distribution for policy ${created.id}:`, error);
    }

    try {
      await emitPolicyChanged(created.orgId, {
        policyId: created.id,
        action: 'created',
        changedBy: auth.user.id
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      distributionWarning = combineWarning(distributionWarning, `event publish failed: ${message}`);
      console.error(`[peripheralControl] Failed to emit policy change event for policy ${created.id}:`, error);
    }

    try {
      writeRouteAudit(c, {
        orgId: created.orgId,
        action: 'peripheral.policy.create',
        resourceType: 'peripheral_policy',
        resourceId: created.id,
        resourceName: created.name,
        details: {
          deviceClass: created.deviceClass,
          actionMode: created.action,
          targetType: created.targetType,
          distributionWarning
        }
      });
    } catch (error) {
      console.error(`[peripheralControl] Failed to write audit for policy ${created.id}:`, error);
    }

    return c.json({ data: created, warning: distributionWarning }, 201);
  }
);

peripheralControlRoutes.post(
  '/policies/:id/disable',
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', disablePolicyParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithAccess(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const [updated] = await db
      .update(peripheralPolicies)
      .set({
        isActive: false,
        updatedAt: new Date()
      })
      .where(eq(peripheralPolicies.id, policy.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to disable policy' }, 500);
    }

    let distributionWarning: string | undefined;
    try {
      await schedulePeripheralPolicyDistribution(updated.orgId, [updated.id], 'policy-disabled');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      distributionWarning = combineWarning(distributionWarning, `distribution scheduling failed: ${message}`);
      console.error(`[peripheralControl] Failed to schedule policy distribution for policy ${updated.id}:`, error);
    }

    try {
      await emitPolicyChanged(updated.orgId, {
        policyId: updated.id,
        action: 'disabled',
        changedBy: auth.user.id
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      distributionWarning = combineWarning(distributionWarning, `event publish failed: ${message}`);
      console.error(`[peripheralControl] Failed to emit policy change event for policy ${updated.id}:`, error);
    }

    try {
      writeRouteAudit(c, {
        orgId: updated.orgId,
        action: 'peripheral.policy.disable',
        resourceType: 'peripheral_policy',
        resourceId: updated.id,
        resourceName: updated.name,
        details: {
          distributionWarning
        }
      });
    } catch (error) {
      console.error(`[peripheralControl] Failed to write audit for policy ${updated.id}:`, error);
    }

    return c.json({ data: updated, warning: distributionWarning });
  }
);

peripheralControlRoutes.post(
  '/exceptions',
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', exceptionsSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    const policy = await getPolicyWithAccess(payload.policyId, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const currentExceptions = Array.isArray(policy.exceptions)
      ? policy.exceptions as PeripheralExceptionRule[]
      : [];

    let nextExceptions = currentExceptions;
    let changed = 0;

    if (payload.operation === 'add') {
      const nextRule = normalizeExceptionRule(payload.exception);
      if (!nextRule) {
        return c.json({ error: 'Invalid exception rule' }, 400);
      }
      nextExceptions = [...currentExceptions, nextRule];
      changed = 1;
    } else {
      const match = payload.match!;
      nextExceptions = currentExceptions.filter((rule) => {
        const vendorMatch = match.vendor ? rule.vendor === match.vendor : true;
        const productMatch = match.product ? rule.product === match.product : true;
        const serialMatch = match.serialNumber ? rule.serialNumber === match.serialNumber : true;
        const shouldRemove = vendorMatch && productMatch && serialMatch;
        if (shouldRemove) changed++;
        return !shouldRemove;
      });
    }

    if (payload.operation === 'remove' && changed === 0) {
      return c.json({ error: 'No matching exception rule found' }, 404);
    }

    const [updated] = await db
      .update(peripheralPolicies)
      .set({
        exceptions: nextExceptions,
        updatedAt: new Date()
      })
      .where(eq(peripheralPolicies.id, policy.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update policy exceptions' }, 500);
    }

    let distributionWarning: string | undefined;
    try {
      await schedulePeripheralPolicyDistribution(updated.orgId, [updated.id], 'policy-exceptions-updated');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      distributionWarning = combineWarning(distributionWarning, `distribution scheduling failed: ${message}`);
      console.error(`[peripheralControl] Failed to schedule policy distribution for policy ${updated.id}:`, error);
    }

    try {
      await emitPolicyChanged(updated.orgId, {
        policyId: updated.id,
        action: 'exceptions_updated',
        changedBy: auth.user.id,
        operation: payload.operation,
        changed
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      distributionWarning = combineWarning(distributionWarning, `event publish failed: ${message}`);
      console.error(`[peripheralControl] Failed to emit policy change event for policy ${updated.id}:`, error);
    }

    try {
      writeRouteAudit(c, {
        orgId: updated.orgId,
        action: 'peripheral.policy.exceptions',
        resourceType: 'peripheral_policy',
        resourceId: updated.id,
        resourceName: updated.name,
        details: {
          operation: payload.operation,
          changed,
          distributionWarning
        }
      });
    } catch (error) {
      console.error(`[peripheralControl] Failed to write audit for policy ${updated.id}:`, error);
    }

    return c.json({
      data: updated,
      changed,
      warning: distributionWarning
    });
  }
);
