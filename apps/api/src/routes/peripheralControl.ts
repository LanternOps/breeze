import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  organizations,
  peripheralDeviceClassEnum,
  peripheralEventTypeEnum,
  peripheralEvents,
  peripheralPolicies,
  peripheralPolicyActionEnum,
  peripheralPolicyTargetTypeEnum,
  devices,
  type PeripheralExceptionRule,
  type PeripheralPolicyTargetIds
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../services/partnerWideAccess';
import { schedulePeripheralPolicyDistribution } from '../jobs/peripheralJobs';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';
import { publishEvent } from '../services/eventBus';

export const peripheralControlRoutes = new Hono();
const MAX_ACTIVITY_WINDOW_DAYS = 90;

peripheralControlRoutes.use('*', authMiddleware);
peripheralControlRoutes.use('*', requireScope('organization', 'partner', 'system'));

const policySchema = z.object({
  id: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
  // 'partner' creates a partner-wide ("all orgs") policy: orgId NULL,
  // partnerId = caller's partner (#2131). Honored on CREATE only — this
  // schema doubles as the update body (id set), and updates never move a
  // policy between ownership axes.
  ownerScope: z.enum(['organization', 'partner']).optional(),
  name: z.string().min(1).max(200),
  deviceClass: z.enum(peripheralDeviceClassEnum.enumValues),
  action: z.enum(peripheralPolicyActionEnum.enumValues),
  targetType: z.enum(peripheralPolicyTargetTypeEnum.enumValues).optional().default('organization'),
  targetIds: z.object({
    siteIds: z.array(z.string().guid()).max(1000).optional(),
    groupIds: z.array(z.string().guid()).max(1000).optional(),
    deviceIds: z.array(z.string().guid()).max(5000).optional(),
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
  orgId: z.string().guid().optional(),
  isActive: z.enum(['true', 'false']).optional(),
  action: z.enum(peripheralPolicyActionEnum.enumValues).optional(),
  deviceClass: z.enum(peripheralDeviceClassEnum.enumValues).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const listActivityQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  deviceId: z.string().guid().optional(),
  policyId: z.string().guid().optional(),
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
  id: z.string().guid(),
});

const exceptionsSchema = z.object({
  policyId: z.string().guid(),
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

// Resolve the device IDs a site-restricted caller may read within their org,
// narrowed by `permissions.allowedSiteIds`. Returns null when the caller has no
// site restriction (no narrowing needed). Site is an app-layer concept only —
// Postgres RLS does NOT defend it — so a site-restricted org user must not read
// peripheral/USB events for devices in other sites within the same org.
// `allowedSiteIds` is only ever set for org-scope users (see permissions.ts), so
// `orgId` is guaranteed present whenever narrowing applies. Mirrors browserSecurity.ts.
async function resolveSiteAllowedDeviceIds(
  orgId: string,
  perms: UserPermissions | undefined,
): Promise<string[] | null> {
  if (!perms?.allowedSiteIds) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return orgDevices
    .filter((d) => typeof d.siteId === 'string' && canAccessSite(perms, d.siteId))
    .map((d) => d.id);
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

// Dual-axis access condition (#2131): org-owned rows the caller can reach OR
// partner-wide rows (org_id NULL) owned by the caller's own partner. Gated on
// partner scope — org tokens carry a partnerId but never pass
// breeze_has_partner_access, so RLS is stricter than this app condition.
function peripheralPolicyAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(peripheralPolicies.orgId);
  if (!orgCond) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${orgCond} OR (${peripheralPolicies.orgId} IS NULL AND ${peripheralPolicies.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}

async function getPolicyWithAccess(policyId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(peripheralPolicies.id, policyId)];
  const accessCondition = peripheralPolicyAccessCondition(auth);
  if (accessCondition) conditions.push(accessCondition);

  const [policy] = await db
    .select()
    .from(peripheralPolicies)
    .where(and(...conditions))
    .limit(1);

  return policy ?? null;
}

/**
 * The org(s) whose devices a policy applies to (#2131): its own org, or —
 * for a partner-wide policy — every org under the owning partner. Used to
 * fan out the org-keyed distribution jobs and change events.
 */
async function resolvePolicyTargetOrgIds(policy: { orgId: string | null; partnerId: string | null }): Promise<string[]> {
  if (policy.orgId) return [policy.orgId];
  if (!policy.partnerId) return [];
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.partnerId, policy.partnerId));
  return rows.map((row) => row.id);
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
  // Populates `permissions` in context (site-scope narrowing below depends on
  // it) and gates device-telemetry reads behind DEVICES_READ.
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listActivityQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
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

    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;

    // Narrow to the caller's accessible devices when site-restricted. RLS does
    // not defend the site axis, so a site-scoped org user must not read events
    // for devices outside their `allowedSiteIds`. Only org-scope users carry
    // `allowedSiteIds`, so `auth.orgId` is present whenever this applies.
    if (perms?.allowedSiteIds && auth.orgId) {
      const allowedDeviceIds = await resolveSiteAllowedDeviceIds(auth.orgId, perms);
      if (query.deviceId && !allowedDeviceIds!.includes(query.deviceId)) {
        return c.json({ error: 'Device not found or access denied' }, 403);
      }
      if (!allowedDeviceIds || allowedDeviceIds.length === 0) {
        return c.json({
          data: [],
          pagination: { total: 0, limit, offset }
        });
      }
      conditions.push(inArray(peripheralEvents.deviceId, allowedDeviceIds));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

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
  // Gate peripheral-policy reads behind DEVICES_READ, matching `/activity`.
  // Without this, any in-org user of any role could read the org's USB/
  // peripheral security posture (RLS contains it to their org, but intra-tenant
  // RBAC must still apply).
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
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
  // Gate peripheral-policy reads behind DEVICES_READ, matching `/activity`.
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', disablePolicyParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
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

      // Partner-wide templates are administrable only with the partner-wide
      // capability (#2131).
      if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
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

      const updateTargetOrgIds = await resolvePolicyTargetOrgIds(updated);

      let distributionWarning: string | undefined;
      try {
        for (const targetOrgId of updateTargetOrgIds) {
          await schedulePeripheralPolicyDistribution(targetOrgId, [updated.id], 'policy-updated');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        distributionWarning = combineWarning(distributionWarning, `distribution scheduling failed: ${message}`);
        console.error(`[peripheralControl] Failed to schedule policy distribution for policy ${updated.id}:`, error);
      }

      try {
        for (const targetOrgId of updateTargetOrgIds) {
          await emitPolicyChanged(targetOrgId, {
            policyId: updated.id,
            action: 'updated',
            changedBy: auth.user.id
          });
        }
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

    // Resolve the ownership axis (#2131): partner-wide creation requires the
    // partner-wide capability; the default path stays org-owned.
    let owner: { orgId: string | null; partnerId: string | null };
    if (payload.ownerScope === 'partner') {
      if (!canManagePartnerWidePolicies(auth) || !auth.partnerId) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const orgResolution = resolveOrgIdForWrite(auth, payload.orgId);
      if (!orgResolution.orgId) {
        return c.json({ error: orgResolution.error ?? 'Organization resolution failed' }, orgResolution.status ?? 400);
      }
      owner = { orgId: orgResolution.orgId, partnerId: null };
    }

    const [created] = await db
      .insert(peripheralPolicies)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
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

    const createTargetOrgIds = await resolvePolicyTargetOrgIds(created);

    let distributionWarning: string | undefined;
    try {
      for (const targetOrgId of createTargetOrgIds) {
        await schedulePeripheralPolicyDistribution(targetOrgId, [created.id], 'policy-created');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      distributionWarning = combineWarning(distributionWarning, `distribution scheduling failed: ${message}`);
      console.error(`[peripheralControl] Failed to schedule policy distribution for policy ${created.id}:`, error);
    }

    try {
      for (const targetOrgId of createTargetOrgIds) {
        await emitPolicyChanged(targetOrgId, {
          policyId: created.id,
          action: 'created',
          changedBy: auth.user.id
        });
      }
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

    // Partner-wide templates are administrable only with the partner-wide
    // capability (#2131).
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
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

    const disableTargetOrgIds = await resolvePolicyTargetOrgIds(updated);

    let distributionWarning: string | undefined;
    try {
      for (const targetOrgId of disableTargetOrgIds) {
        await schedulePeripheralPolicyDistribution(targetOrgId, [updated.id], 'policy-disabled');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      distributionWarning = combineWarning(distributionWarning, `distribution scheduling failed: ${message}`);
      console.error(`[peripheralControl] Failed to schedule policy distribution for policy ${updated.id}:`, error);
    }

    try {
      for (const targetOrgId of disableTargetOrgIds) {
        await emitPolicyChanged(targetOrgId, {
          policyId: updated.id,
          action: 'disabled',
          changedBy: auth.user.id
        });
      }
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

    // Partner-wide templates are administrable only with the partner-wide
    // capability (#2131).
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
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

    const exceptionsTargetOrgIds = await resolvePolicyTargetOrgIds(updated);

    let distributionWarning: string | undefined;
    try {
      for (const targetOrgId of exceptionsTargetOrgIds) {
        await schedulePeripheralPolicyDistribution(targetOrgId, [updated.id], 'policy-exceptions-updated');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      distributionWarning = combineWarning(distributionWarning, `distribution scheduling failed: ${message}`);
      console.error(`[peripheralControl] Failed to schedule policy distribution for policy ${updated.id}:`, error);
    }

    try {
      for (const targetOrgId of exceptionsTargetOrgIds) {
        await emitPolicyChanged(targetOrgId, {
          policyId: updated.id,
          action: 'exceptions_updated',
          changedBy: auth.user.id,
          operation: payload.operation,
          changed
        });
      }
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
