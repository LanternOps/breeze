import { Hono, type Context } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { eq, and, desc, asc, inArray } from 'drizzle-orm';
import { db } from '../db';
import { drPlans, drPlanGroups, drExecutions, devices } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  drPlanCreateSchema,
  drPlanUpdateSchema,
  drGroupCreateSchema,
  drGroupUpdateSchema,
  drExecutionTriggerSchema,
  drExecutionsQuerySchema,
} from './backup/schemas';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';
import type { AuthContext } from '../middleware/auth';
import { isSiteRestrictedPrincipalKind } from '../services/resilienceSiteAuthorization';
import {
  classifyDrExecutionAuthorizationError,
  createDrExecutionAndEnqueue,
} from '../services/drExecutionService';

export const drRoutes = new Hono();
const requireDrRead = requirePermission(
  PERMISSIONS.DEVICES_READ.resource,
  PERMISSIONS.DEVICES_READ.action,
);
const requireDrWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);
const requireDrExecute = requirePermission(
  PERMISSIONS.DEVICES_EXECUTE.resource,
  PERMISSIONS.DEVICES_EXECUTE.action,
);

drRoutes.use('*', authMiddleware);

const idParamSchema = z.object({ id: z.string().guid() });
const groupParamSchema = z.object({ id: z.string().guid(), gid: z.string().guid() });

type DeviceScopeDenial = { status: 403; error: string };

const ORG_DENIAL: DeviceScopeDenial = {
  status: 403,
  error: 'One or more devices do not belong to this organization',
};
const SITE_DENIAL: DeviceScopeDenial = { status: 403, error: 'site_access_denied' };

function denyDeviceScope(c: Context, denial: DeviceScopeDenial) {
  return c.json({ error: denial.error }, denial.status);
}

function uniqueDeviceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string'))];
}

/**
 * The caller's site restriction, or null when they carry none.
 *
 * RLS enforces the org axis but has no concept of a site, so for every route in
 * this file the app layer is the ONLY barrier between a site-restricted
 * technician and another site's disaster-recovery configuration (#3653). The
 * shape mirrors `resolveRouteAuthorizedDeviceIds` in
 * routes/backup/resilienceAuthorization.ts so both read the grant identically.
 */
function siteRestriction(c: Context): UserPermissions | null {
  const auth = c.get('auth') as AuthContext;
  if (!isSiteRestrictedPrincipalKind(auth?.principal?.kind)) return null;

  // Fall back to the token's own grant rather than treating a missing
  // `permissions` as "unrestricted". Every route here is behind
  // requirePermission, which always publishes it — but a route added later
  // without that middleware would otherwise fail OPEN on a boundary Postgres
  // does not enforce. Mirrors authorizeRouteResilienceResources.
  const permissions = (c.get('permissions') as UserPermissions | undefined) ?? {
    permissions: [],
    partnerId: auth.partnerId,
    orgId: auth.orgId,
    roleId: '',
    scope: auth.scope,
    allowedSiteIds: auth.allowedSiteIds,
  };

  return permissions.allowedSiteIds ? permissions : null;
}

function loadDeviceSites(deviceIds: string[], orgId: string) {
  return db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(and(inArray(devices.id, deviceIds), eq(devices.orgId, orgId)));
}

/**
 * Authorize the device ids a caller is asking to STORE on a DR group.
 *
 * Org axis: DR group commands are dispatched under withSystemDbAccessContext
 * (RLS off), so a foreign-org device id slipping into devices[] would let a
 * destructive restore command target another tenant's device.
 *
 * Site axis: `devices:write` is a role permission orthogonal to allowedSiteIds,
 * so a site-restricted technician normally holds it; without this check they
 * could point a recovery group at another site's machines.
 */
async function authorizeProposedDevices(
  c: Context,
  deviceIds: string[],
  orgId: string,
): Promise<DeviceScopeDenial | null> {
  const uniqueIds = uniqueDeviceIds(deviceIds);
  if (uniqueIds.length === 0) return null;

  const owned = await loadDeviceSites(uniqueIds, orgId);
  if (owned.length !== uniqueIds.length) return ORG_DENIAL;

  const restriction = siteRestriction(c);
  if (!restriction) return null;
  return owned.every((row) => canAccessSite(restriction, row.siteId)) ? null : SITE_DENIAL;
}

/**
 * Authorize the membership a group ALREADY holds, before replacing or removing it.
 *
 * Validating only the submitted array is bypassable: a site-restricted caller
 * can PATCH devices:[theirOwnDevice] over a stored [theirOwnDevice,
 * otherSiteDevice] and silently drop the out-of-site device from the recovery
 * plan without ever naming it — degrading DR for a site they cannot see. So
 * every mutation that replaces or removes stored membership is authorized
 * against what is already there.
 *
 * Costs an unrestricted caller nothing: it returns before issuing any query.
 */
async function authorizeStoredDevices(
  c: Context,
  storedDeviceIds: unknown,
  orgId: string,
): Promise<DeviceScopeDenial | null> {
  const restriction = siteRestriction(c);
  if (!restriction) return null;

  const uniqueIds = uniqueDeviceIds(storedDeviceIds);
  if (uniqueIds.length === 0) return null;

  // Ids with no surviving device row cannot be restore targets, so they do not
  // gate the mutation — a deleted device must not wedge group maintenance.
  const owned = await loadDeviceSites(uniqueIds, orgId);
  return owned.every((row) => canAccessSite(restriction, row.siteId)) ? null : SITE_DENIAL;
}

/**
 * Authorize every device across a plan's groups. Plan status gates execution
 * and archival disables recovery outright, so those are control-plane actions
 * over every site the plan touches — not just the caller's own.
 */
async function authorizePlanStoredDevices(
  c: Context,
  planId: string,
  orgId: string,
): Promise<DeviceScopeDenial | null> {
  if (!siteRestriction(c)) return null;

  const groups = await db
    .select({ devices: drPlanGroups.devices })
    .from(drPlanGroups)
    .where(and(eq(drPlanGroups.planId, planId), eq(drPlanGroups.orgId, orgId)));

  return authorizeStoredDevices(c, groups.flatMap((group) => uniqueDeviceIds(group.devices)), orgId);
}

function resolveOrgId(
  auth: {
    orgId?: string | null;
    scope: string;
    accessibleOrgIds?: string[] | null;
    canAccessOrg?: (orgId: string) => boolean;
  },
  requestedOrgId?: string | null
): string | null {
  if (requestedOrgId) {
    if (auth.canAccessOrg && !auth.canAccessOrg(requestedOrgId)) return null;
    if (
      !auth.canAccessOrg &&
      Array.isArray(auth.accessibleOrgIds) &&
      !auth.accessibleOrgIds.includes(requestedOrgId)
    ) {
      return null;
    }
    return requestedOrgId;
  }
  if (auth.orgId) return auth.orgId;
  if (auth.scope === 'partner' && Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }
  return null;
}

// ── Plans CRUD ───────────────────────────────────────────────────────────────

drRoutes.post(
  '/plans',
  requireDrWrite,
  requireMfa(),
  zValidator('json', drPlanCreateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const payload = c.req.valid('json');
    const now = new Date();
    const [row] = await db
      .insert(drPlans)
      .values({
        orgId,
        name: payload.name,
        description: payload.description ?? null,
        status: 'draft',
        rpoTargetMinutes: payload.rpoTargetMinutes ?? null,
        rtoTargetMinutes: payload.rtoTargetMinutes ?? null,
        createdBy: auth.user?.id ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) return c.json({ error: 'Failed to create plan' }, 500);

    writeRouteAudit(c, {
      orgId,
      action: 'dr.plan.create',
      resourceType: 'dr_plan',
      resourceId: row.id,
      resourceName: row.name,
    });

    return c.json({ data: row }, 201);
  }
);

drRoutes.get('/plans', requireDrRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required' }, 400);

  const rows = await db
    .select()
    .from(drPlans)
    .where(eq(drPlans.orgId, orgId))
    .orderBy(desc(drPlans.createdAt));

  return c.json({ data: rows });
});

drRoutes.get(
  '/plans/:id',
  requireDrRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id } = c.req.valid('param');
    const [plan] = await db
      .select()
      .from(drPlans)
      .where(and(eq(drPlans.id, id), eq(drPlans.orgId, orgId)))
      .limit(1);

    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    const groups = await db
      .select()
      .from(drPlanGroups)
      .where(eq(drPlanGroups.planId, id))
      .orderBy(asc(drPlanGroups.sequence));

    return c.json({ data: { ...plan, groups } });
  }
);

drRoutes.patch(
  '/plans/:id',
  requireDrWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', drPlanUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [existing] = await db
      .select()
      .from(drPlans)
      .where(and(eq(drPlans.id, id), eq(drPlans.orgId, orgId)))
      .limit(1);

    if (!existing) return c.json({ error: 'Plan not found' }, 404);

    const planDenial = await authorizePlanStoredDevices(c, id, orgId);
    if (planDenial) return denyDeviceScope(c, planDenial);

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.description !== undefined) updateData.description = payload.description;
    if (payload.status !== undefined) updateData.status = payload.status;
    if (payload.rpoTargetMinutes !== undefined) updateData.rpoTargetMinutes = payload.rpoTargetMinutes;
    if (payload.rtoTargetMinutes !== undefined) updateData.rtoTargetMinutes = payload.rtoTargetMinutes;

    const [updated] = await db
      .update(drPlans)
      .set(updateData)
      .where(and(eq(drPlans.id, id), eq(drPlans.orgId, orgId)))
      .returning();

    writeRouteAudit(c, {
      orgId,
      action: 'dr.plan.update',
      resourceType: 'dr_plan',
      resourceId: id,
      details: payload,
    });

    return c.json({ data: updated });
  }
);

drRoutes.delete(
  '/plans/:id',
  requireDrWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id } = c.req.valid('param');
    const [existing] = await db
      .select()
      .from(drPlans)
      .where(and(eq(drPlans.id, id), eq(drPlans.orgId, orgId)))
      .limit(1);

    if (!existing) return c.json({ error: 'Plan not found' }, 404);

    const planDenial = await authorizePlanStoredDevices(c, id, orgId);
    if (planDenial) return denyDeviceScope(c, planDenial);

    // Archive instead of hard delete
    const [updated] = await db
      .update(drPlans)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(and(eq(drPlans.id, id), eq(drPlans.orgId, orgId)))
      .returning();

    writeRouteAudit(c, {
      orgId,
      action: 'dr.plan.archive',
      resourceType: 'dr_plan',
      resourceId: id,
    });

    return c.json({ data: updated });
  }
);

// ── Groups ───────────────────────────────────────────────────────────────────

drRoutes.post(
  '/plans/:id/groups',
  requireDrWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', drGroupCreateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id: planId } = c.req.valid('param');

    // Verify plan exists and belongs to org
    const [plan] = await db
      .select()
      .from(drPlans)
      .where(and(eq(drPlans.id, planId), eq(drPlans.orgId, orgId)))
      .limit(1);

    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    const payload = c.req.valid('json');
    if (payload.devices) {
      const denial = await authorizeProposedDevices(c, payload.devices, orgId);
      if (denial) return denyDeviceScope(c, denial);
    }

    const [row] = await db
      .insert(drPlanGroups)
      .values({
        planId,
        orgId,
        name: payload.name,
        sequence: payload.sequence ?? 0,
        dependsOnGroupId: payload.dependsOnGroupId ?? null,
        devices: payload.devices ?? [],
        restoreConfig: payload.restoreConfig ?? {},
        estimatedDurationMinutes: payload.estimatedDurationMinutes ?? null,
      })
      .returning();

    if (!row) return c.json({ error: 'Failed to create group' }, 500);

    return c.json({ data: row }, 201);
  }
);

drRoutes.patch(
  '/plans/:id/groups/:gid',
  requireDrWrite,
  requireMfa(),
  zValidator('param', groupParamSchema),
  zValidator('json', drGroupUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id: planId, gid } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [existing] = await db
      .select()
      .from(drPlanGroups)
      .where(
        and(
          eq(drPlanGroups.id, gid),
          eq(drPlanGroups.planId, planId),
          eq(drPlanGroups.orgId, orgId)
        )
      )
      .limit(1);

    if (!existing) return c.json({ error: 'Group not found' }, 404);

    // Authorize what the group already holds BEFORE what the caller proposes:
    // a replace that merely omits an out-of-site device never names it.
    const storedDenial = await authorizeStoredDevices(c, existing.devices, orgId);
    if (storedDenial) return denyDeviceScope(c, storedDenial);

    if (payload.devices !== undefined) {
      const denial = await authorizeProposedDevices(c, payload.devices, orgId);
      if (denial) return denyDeviceScope(c, denial);
    }

    const updateData: Record<string, unknown> = {};
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.sequence !== undefined) updateData.sequence = payload.sequence;
    if (payload.dependsOnGroupId !== undefined) updateData.dependsOnGroupId = payload.dependsOnGroupId;
    if (payload.devices !== undefined) updateData.devices = payload.devices;
    if (payload.restoreConfig !== undefined) updateData.restoreConfig = payload.restoreConfig;
    if (payload.estimatedDurationMinutes !== undefined) updateData.estimatedDurationMinutes = payload.estimatedDurationMinutes;

    const [updated] = await db
      .update(drPlanGroups)
      .set(updateData)
      .where(
        and(
          eq(drPlanGroups.id, gid),
          eq(drPlanGroups.planId, planId),
          eq(drPlanGroups.orgId, orgId)
        )
      )
      .returning();

    return c.json({ data: updated });
  }
);

drRoutes.delete(
  '/plans/:id/groups/:gid',
  requireDrWrite,
  requireMfa(),
  zValidator('param', groupParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id: planId, gid } = c.req.valid('param');

    const [existing] = await db
      .select({ id: drPlanGroups.id, devices: drPlanGroups.devices })
      .from(drPlanGroups)
      .where(
        and(
          eq(drPlanGroups.id, gid),
          eq(drPlanGroups.planId, planId),
          eq(drPlanGroups.orgId, orgId)
        )
      )
      .limit(1);

    if (!existing) return c.json({ error: 'Group not found' }, 404);

    const storedDenial = await authorizeStoredDevices(c, existing.devices, orgId);
    if (storedDenial) return denyDeviceScope(c, storedDenial);

    await db
      .delete(drPlanGroups)
      .where(
        and(
          eq(drPlanGroups.id, gid),
          eq(drPlanGroups.planId, planId),
          eq(drPlanGroups.orgId, orgId)
        )
      );

    return c.json({ success: true });
  }
);

// ── Executions ───────────────────────────────────────────────────────────────

drRoutes.post(
  '/plans/:id/execute',
  requireDrExecute,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', drExecutionTriggerSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id: planId } = c.req.valid('param');
    const { executionType } = c.req.valid('json');

    const [plan] = await db
      .select()
      .from(drPlans)
      .where(and(eq(drPlans.id, planId), eq(drPlans.orgId, orgId)))
      .limit(1);

    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    if (plan.status === 'archived') {
      return c.json({ error: 'Cannot execute an archived plan' }, 400);
    }

    // createDrExecutionAndEnqueue authorizes every group device against the
    // caller's site grant before an execution row exists, so a denial here is an
    // expected outcome — not a fault. Uncaught it would reach the global handler
    // and render as a 500 plus a Sentry event (#3653).
    let execution;
    try {
      execution = await createDrExecutionAndEnqueue({
        planId,
        orgId,
        executionType,
        initiatedBy: auth.user?.id ?? null,
        auth,
      });
    } catch (error) {
      const failure = classifyDrExecutionAuthorizationError(error);
      if (!failure) throw error;
      return c.json({ error: failure.code }, failure.status);
    }

    if (!execution) return c.json({ error: 'Failed to create execution' }, 500);

    writeRouteAudit(c, {
      orgId,
      action: 'dr.execution.start',
      resourceType: 'dr_execution',
      resourceId: execution.id,
      details: { planId, executionType },
    });

    return c.json({ data: execution }, 201);
  }
);

drRoutes.get(
  '/executions',
  requireDrRead,
  zValidator('query', drExecutionsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const query = c.req.valid('query');
    const conditions = [eq(drExecutions.orgId, orgId)];

    if (query.planId) {
      conditions.push(eq(drExecutions.planId, query.planId));
    }
    if (query.status) {
      conditions.push(eq(drExecutions.status, query.status));
    }

    const limit = query.limit ?? 100;

    const rows = await db
      .select()
      .from(drExecutions)
      .where(and(...conditions))
      .orderBy(desc(drExecutions.createdAt))
      .limit(limit);

    return c.json({ data: rows });
  }
);

drRoutes.get(
  '/executions/:id',
  requireDrRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id } = c.req.valid('param');
    const [execution] = await db
      .select()
      .from(drExecutions)
      .where(and(eq(drExecutions.id, id), eq(drExecutions.orgId, orgId)))
      .limit(1);

    if (!execution) return c.json({ error: 'Execution not found' }, 404);

    // Include the plan and groups for context
    const [plan] = await db
      .select()
      .from(drPlans)
      .where(eq(drPlans.id, execution.planId))
      .limit(1);

    const groups = plan
      ? await db
          .select()
          .from(drPlanGroups)
          .where(eq(drPlanGroups.planId, plan.id))
          .orderBy(asc(drPlanGroups.sequence))
      : [];

    return c.json({
      data: {
        ...execution,
        plan: plan ?? null,
        groups,
      },
    });
  }
);

drRoutes.post(
  '/executions/:id/abort',
  requireDrExecute,
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id } = c.req.valid('param');
    const [execution] = await db
      .select()
      .from(drExecutions)
      .where(and(eq(drExecutions.id, id), eq(drExecutions.orgId, orgId)))
      .limit(1);

    if (!execution) return c.json({ error: 'Execution not found' }, 404);

    if (execution.status === 'completed' || execution.status === 'aborted') {
      return c.json({ error: `Cannot abort execution in ${execution.status} state` }, 400);
    }

    // Aborting halts recovery for every site the plan touches, so a caller who
    // cannot reach all of them must not be able to stop it.
    const abortDenial = await authorizePlanStoredDevices(c, execution.planId, orgId);
    if (abortDenial) return denyDeviceScope(c, abortDenial);

    const [updated] = await db
      .update(drExecutions)
      .set({ status: 'aborted', completedAt: new Date() })
      .where(and(eq(drExecutions.id, id), eq(drExecutions.orgId, orgId)))
      .returning();

    writeRouteAudit(c, {
      orgId,
      action: 'dr.execution.abort',
      resourceType: 'dr_execution',
      resourceId: id,
    });

    return c.json({ data: updated });
  }
);
