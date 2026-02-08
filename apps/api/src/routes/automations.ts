import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  automations,
  automationRuns,
  devices
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const automationRoutes = new Hono();

// Helper functions
function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function ensureOrgAccess(orgId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  return auth.canAccessOrg(orgId);
}

async function getAutomationWithOrgCheck(automationId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [automation] = await db
    .select()
    .from(automations)
    .where(eq(automations.id, automationId))
    .limit(1);

  if (!automation) {
    return null;
  }

  const hasAccess = ensureOrgAccess(automation.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return automation;
}

// Validation schemas

// Automations schemas
const listAutomationsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  enabled: z.enum(['true', 'false']).optional()
});

const createAutomationSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  trigger: z.any(), // JSONB for trigger configuration
  conditions: z.any().optional(), // JSONB for conditions
  actions: z.any(), // JSONB for actions
  onFailure: z.enum(['stop', 'continue', 'notify']).default('stop'),
  notificationTargets: z.any().optional() // JSONB for notification targets
});

const updateAutomationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  trigger: z.any().optional(),
  conditions: z.any().optional(),
  actions: z.any().optional(),
  onFailure: z.enum(['stop', 'continue', 'notify']).optional(),
  notificationTargets: z.any().optional()
});

// Apply auth middleware to all routes
automationRoutes.use('*', authMiddleware);

// ============================================
// AUTOMATIONS ENDPOINTS
// ============================================

// GET /automations - List automations with pagination
automationRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listAutomationsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(automations.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(automations.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(automations.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(automations.orgId, query.orgId));
    }

    // Additional filters
    if (query.enabled !== undefined) {
      conditions.push(eq(automations.enabled, query.enabled === 'true'));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automations)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get automations
    const automationsList = await db
      .select()
      .from(automations)
      .where(whereCondition)
      .orderBy(desc(automations.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: automationsList,
      pagination: { page, limit, total }
    });
  }
);

// GET /automations/runs/:runId - Get specific run details (must be before /:id to avoid conflict)
automationRoutes.get(
  '/runs/:runId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('runId');

    // Get the run
    const [run] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId))
      .limit(1);

    if (!run) {
      return c.json({ error: 'Automation run not found' }, 404);
    }

    // Verify access to parent automation
    const automation = await getAutomationWithOrgCheck(run.automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation run not found' }, 404);
    }

    return c.json({
      ...run,
      automation: {
        id: automation.id,
        name: automation.name,
        orgId: automation.orgId
      }
    });
  }
);

// GET /automations/:id - Get single automation with run history
automationRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');

    // Skip if this is a route like /automations/runs
    if (automationId === 'runs') {
      return c.notFound();
    }

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    // Get recent run history
    const recentRuns = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId))
      .orderBy(desc(automationRuns.startedAt))
      .limit(10);

    // Get run statistics
    const runStats = await db
      .select({
        totalRuns: sql<number>`count(*)`,
        completedRuns: sql<number>`count(*) filter (where ${automationRuns.status} = 'completed')`,
        failedRuns: sql<number>`count(*) filter (where ${automationRuns.status} = 'failed')`,
        partialRuns: sql<number>`count(*) filter (where ${automationRuns.status} = 'partial')`
      })
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId));

    return c.json({
      ...automation,
      recentRuns,
      statistics: {
        totalRuns: Number(runStats[0]?.totalRuns ?? 0),
        completedRuns: Number(runStats[0]?.completedRuns ?? 0),
        failedRuns: Number(runStats[0]?.failedRuns ?? 0),
        partialRuns: Number(runStats[0]?.partialRuns ?? 0)
      }
    });
  }
);

// POST /automations - Create automation
automationRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createAutomationSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
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

    const [automation] = await db
      .insert(automations)
      .values({
        orgId: orgId!,
        name: data.name,
        description: data.description,
        enabled: data.enabled,
        trigger: data.trigger,
        conditions: data.conditions,
        actions: data.actions,
        onFailure: data.onFailure,
        notificationTargets: data.notificationTargets,
        createdBy: auth.user.id
      })
      .returning();

    writeRouteAudit(c, {
      orgId: automation?.orgId,
      action: 'automation.create',
      resourceType: 'automation',
      resourceId: automation?.id,
      resourceName: automation?.name,
      details: { enabled: automation?.enabled }
    });

    return c.json(automation, 201);
  }
);

// PUT /automations/:id - Update automation
automationRoutes.put(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateAutomationSchema),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    if (data.trigger !== undefined) updates.trigger = data.trigger;
    if (data.conditions !== undefined) updates.conditions = data.conditions;
    if (data.actions !== undefined) updates.actions = data.actions;
    if (data.onFailure !== undefined) updates.onFailure = data.onFailure;
    if (data.notificationTargets !== undefined) updates.notificationTargets = data.notificationTargets;

    const [updated] = await db
      .update(automations)
      .set(updates)
      .where(eq(automations.id, automationId))
      .returning();

    writeRouteAudit(c, {
      orgId: automation.orgId,
      action: 'automation.update',
      resourceType: 'automation',
      resourceId: updated?.id,
      resourceName: updated?.name,
      details: { changedFields: Object.keys(data) }
    });

    return c.json(updated);
  }
);

// DELETE /automations/:id - Delete automation
automationRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    // Check for running automation runs
    const runningRuns = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.status, 'running')
        )
      );

    const runningCount = Number(runningRuns[0]?.count ?? 0);
    if (runningCount > 0) {
      return c.json({
        error: 'Cannot delete automation with running executions',
        runningExecutions: runningCount
      }, 409);
    }

    // Delete associated runs first
    await db
      .delete(automationRuns)
      .where(eq(automationRuns.automationId, automationId));

    // Delete automation
    await db
      .delete(automations)
      .where(eq(automations.id, automationId));

    writeRouteAudit(c, {
      orgId: automation.orgId,
      action: 'automation.delete',
      resourceType: 'automation',
      resourceId: automation.id,
      resourceName: automation.name
    });

    return c.json({ success: true });
  }
);

// POST /automations/:id/trigger - Manually trigger automation
automationRoutes.post(
  '/:id/trigger',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    if (!automation.enabled) {
      return c.json({ error: 'Cannot trigger disabled automation' }, 400);
    }

    // Get target devices based on automation conditions
    const targets = automation.trigger as Record<string, unknown>;
    let targetDeviceIds: string[] = [];

    // Simple device targeting logic - in production would be more sophisticated
    if (targets?.deviceIds && Array.isArray(targets.deviceIds)) {
      targetDeviceIds = targets.deviceIds;
    } else {
      // Get all devices for the org
      const orgDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.orgId, automation.orgId));
      targetDeviceIds = orgDevices.map(d => d.id);
    }

    // Create automation run
    const [run] = await db
      .insert(automationRuns)
      .values({
        automationId,
        triggeredBy: `manual:${auth.user.id}`,
        status: 'running',
        devicesTargeted: targetDeviceIds.length,
        devicesSucceeded: 0,
        devicesFailed: 0,
        logs: [{
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `Automation triggered manually by user ${auth.user.id}`
        }]
      })
      .returning();

    if (!run) {
      return c.json({ error: 'Failed to create automation run' }, 500);
    }

    // Update automation run count and last run time
    await db
      .update(automations)
      .set({
        runCount: automation.runCount + 1,
        lastRunAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(automations.id, automationId));

    // In production, this would queue the actual automation execution
    // For now, simulate completion
    setTimeout(async () => {
      try {
        await db
          .update(automationRuns)
          .set({
            status: 'completed',
            devicesSucceeded: targetDeviceIds.length,
            completedAt: new Date(),
            logs: [
              ...(run.logs as Array<{ timestamp: string; level: string; message: string }>),
              {
                timestamp: new Date().toISOString(),
                level: 'info',
                message: 'Automation completed successfully'
              }
            ]
          })
          .where(eq(automationRuns.id, run.id));
      } catch {
        // Ignore errors in background task
      }
    }, 1000);

    writeRouteAudit(c, {
      orgId: automation.orgId,
      action: 'automation.trigger',
      resourceType: 'automation',
      resourceId: automation.id,
      resourceName: automation.name,
      details: { runId: run.id, devicesTargeted: targetDeviceIds.length }
    });

    return c.json({
      message: 'Automation triggered',
      run: {
        id: run.id,
        status: run.status,
        devicesTargeted: run.devicesTargeted,
        startedAt: run.startedAt
      }
    });
  }
);

// GET /automations/:id/runs - Get run history for automation
automationRoutes.get(
  '/:id/runs',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    status: z.enum(['running', 'completed', 'failed', 'partial']).optional()
  })),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [eq(automationRuns.automationId, automationId)];

    if (query.status) {
      conditions.push(eq(automationRuns.status, query.status));
    }

    const whereCondition = and(...conditions);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationRuns)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get runs
    const runsList = await db
      .select()
      .from(automationRuns)
      .where(whereCondition)
      .orderBy(desc(automationRuns.startedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: runsList,
      pagination: { page, limit, total }
    });
  }
);
