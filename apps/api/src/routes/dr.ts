import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, desc, asc } from 'drizzle-orm';
import { db } from '../db';
import { drPlans, drPlanGroups, drExecutions } from '../db/schema';
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
import { PERMISSIONS } from '../services/permissions';

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

const idParamSchema = z.object({ id: z.string().uuid() });
const groupParamSchema = z.object({ id: z.string().uuid(), gid: z.string().uuid() });

function resolveOrgId(auth: { orgId?: string | null; scope: string; accessibleOrgIds?: string[] | null }): string | null {
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
    const orgId = resolveOrgId(auth);
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
  const orgId = resolveOrgId(auth);
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
    const orgId = resolveOrgId(auth);
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
    const orgId = resolveOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [existing] = await db
      .select()
      .from(drPlans)
      .where(and(eq(drPlans.id, id), eq(drPlans.orgId, orgId)))
      .limit(1);

    if (!existing) return c.json({ error: 'Plan not found' }, 404);

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
    const orgId = resolveOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id } = c.req.valid('param');
    const [existing] = await db
      .select()
      .from(drPlans)
      .where(and(eq(drPlans.id, id), eq(drPlans.orgId, orgId)))
      .limit(1);

    if (!existing) return c.json({ error: 'Plan not found' }, 404);

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
    const orgId = resolveOrgId(auth);
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
    const orgId = resolveOrgId(auth);
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
    const orgId = resolveOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required' }, 400);

    const { id: planId, gid } = c.req.valid('param');

    const [existing] = await db
      .select({ id: drPlanGroups.id })
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
    const orgId = resolveOrgId(auth);
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

    const now = new Date();
    const [execution] = await db
      .insert(drExecutions)
      .values({
        planId,
        orgId,
        executionType,
        status: 'pending',
        startedAt: now,
        initiatedBy: auth.user?.id ?? null,
        createdAt: now,
      })
      .returning();

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
    const orgId = resolveOrgId(auth);
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
    const orgId = resolveOrgId(auth);
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
    const orgId = resolveOrgId(auth);
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
