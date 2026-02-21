import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, sql, SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  playbookDefinitions,
  playbookExecutions,
  type PlaybookExecutionContext,
  type PlaybookExecutionStatus,
  type PlaybookStepResult,
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { checkPlaybookRequiredPermissions } from '../services/playbookPermissions';

const executionStatusSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'rolled_back',
  'cancelled',
]);

const playbookCategorySchema = z.enum(['disk', 'service', 'memory', 'patch', 'security']);

const uuidParamSchema = z.object({ id: z.string().uuid() });

const listPlaybooksQuerySchema = z.object({
  category: playbookCategorySchema.or(z.literal('all')).optional(),
});

const listExecutionsQuerySchema = z.object({
  deviceId: z.string().uuid().optional(),
  playbookId: z.string().uuid().optional(),
  status: executionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const executePlaybookBodySchema = z.object({
  deviceId: z.string().uuid(),
  variables: z.record(z.unknown()).optional(),
  context: z.record(z.unknown()).optional(),
});

const patchExecutionBodySchema = z.object({
  status: executionStatusSchema.optional(),
  currentStepIndex: z.number().int().min(0).optional(),
  steps: z.array(z.object({
    stepIndex: z.number().int().min(0),
    stepName: z.string().min(1).max(255),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
    toolUsed: z.string().max(100).optional(),
    toolInput: z.record(z.unknown()).optional(),
    toolOutput: z.string().max(200_000).optional(),
    error: z.string().max(5000).optional(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
  })).max(200).optional(),
  context: z.record(z.unknown()).optional(),
  errorMessage: z.string().max(5000).nullable().optional(),
  rollbackExecuted: z.boolean().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field is required',
});

const ALLOWED_STATUS_TRANSITIONS: Record<PlaybookExecutionStatus, PlaybookExecutionStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['waiting', 'completed', 'failed', 'rolled_back', 'cancelled'],
  waiting: ['running', 'completed', 'failed', 'rolled_back', 'cancelled'],
  completed: [],
  failed: [],
  rolled_back: [],
  cancelled: [],
};

function canTransitionExecutionStatus(
  from: PlaybookExecutionStatus,
  to: PlaybookExecutionStatus
): boolean {
  if (from === to) return true;
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

export const playbookRoutes = new Hono();

playbookRoutes.use('*', authMiddleware);

// GET /api/playbooks
playbookRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPlaybooksQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const conditions: SQL[] = [eq(playbookDefinitions.isActive, true)];
    if (query.category && query.category !== 'all') {
      conditions.push(eq(playbookDefinitions.category, query.category));
    }

    const orgCond = auth.orgCondition(playbookDefinitions.orgId);
    if (orgCond) {
      conditions.push(sql`(${playbookDefinitions.isBuiltIn} = true OR ${orgCond})`);
    }

    const playbooks = await db
      .select()
      .from(playbookDefinitions)
      .where(and(...conditions))
      .orderBy(playbookDefinitions.category, playbookDefinitions.name);

    return c.json({ playbooks });
  }
);

// GET /api/playbooks/executions
playbookRoutes.get(
  '/executions',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listExecutionsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const limit = query.limit ?? 50;

    const conditions: SQL[] = [];
    const orgCond = auth.orgCondition(playbookExecutions.orgId);
    if (orgCond) conditions.push(orgCond);
    if (query.deviceId) conditions.push(eq(playbookExecutions.deviceId, query.deviceId));
    if (query.playbookId) conditions.push(eq(playbookExecutions.playbookId, query.playbookId));
    if (query.status) conditions.push(eq(playbookExecutions.status, query.status));

    const executions = await db
      .select({
        execution: playbookExecutions,
        playbook: {
          id: playbookDefinitions.id,
          name: playbookDefinitions.name,
          category: playbookDefinitions.category,
        },
        device: {
          id: devices.id,
          hostname: devices.hostname,
        },
      })
      .from(playbookExecutions)
      .leftJoin(playbookDefinitions, eq(playbookExecutions.playbookId, playbookDefinitions.id))
      .leftJoin(devices, eq(playbookExecutions.deviceId, devices.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(playbookExecutions.createdAt))
      .limit(limit);

    return c.json({ executions });
  }
);

// GET /api/playbooks/executions/:id
playbookRoutes.get(
  '/executions/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', uuidParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const auth = c.get('auth');

    const conditions: SQL[] = [eq(playbookExecutions.id, id)];
    const orgCond = auth.orgCondition(playbookExecutions.orgId);
    if (orgCond) conditions.push(orgCond);

    const [execution] = await db
      .select({
        execution: playbookExecutions,
        playbook: playbookDefinitions,
        device: devices,
      })
      .from(playbookExecutions)
      .leftJoin(playbookDefinitions, eq(playbookExecutions.playbookId, playbookDefinitions.id))
      .leftJoin(devices, eq(playbookExecutions.deviceId, devices.id))
      .where(and(...conditions))
      .limit(1);

    if (!execution) {
      return c.json({ error: 'Execution not found' }, 404);
    }

    return c.json(execution);
  }
);

// POST /api/playbooks/:id/execute
playbookRoutes.post(
  '/:id/execute',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', uuidParamSchema),
  zValidator('json', executePlaybookBodySchema),
  async (c) => {
    const { id: playbookId } = c.req.valid('param');
    const auth = c.get('auth');
    const body = c.req.valid('json');

    try {
      const playbookConditions: SQL[] = [
        eq(playbookDefinitions.id, playbookId),
        eq(playbookDefinitions.isActive, true),
      ];

      const playbookOrgCond = auth.orgCondition(playbookDefinitions.orgId);
      if (playbookOrgCond) {
        playbookConditions.push(sql`(${playbookDefinitions.isBuiltIn} = true OR ${playbookOrgCond})`);
      }

      const [playbook] = await db
        .select()
        .from(playbookDefinitions)
        .where(and(...playbookConditions))
        .limit(1);

      if (!playbook) {
        return c.json({ error: 'Playbook not found or access denied' }, 404);
      }

      const permissionCheck = await checkPlaybookRequiredPermissions(playbook.requiredPermissions, auth);
      if (!permissionCheck.allowed) {
        return c.json({
          error: permissionCheck.error ?? 'Missing required permissions for this playbook',
          missingPermissions: permissionCheck.missingPermissions,
        }, 403);
      }

      const deviceConditions: SQL[] = [eq(devices.id, body.deviceId)];
      const deviceOrgCond = auth.orgCondition(devices.orgId);
      if (deviceOrgCond) deviceConditions.push(deviceOrgCond);

      const [device] = await db
        .select({
          id: devices.id,
          orgId: devices.orgId,
          hostname: devices.hostname,
        })
        .from(devices)
        .where(and(...deviceConditions))
        .limit(1);

      if (!device) {
        return c.json({ error: 'Device not found or access denied' }, 404);
      }

      if (playbook.orgId !== null && playbook.orgId !== device.orgId) {
        return c.json({ error: 'Playbook and device must belong to the same organization' }, 403);
      }

      const baseContext = (body.context ?? {}) as PlaybookExecutionContext;
      const mergedContext: PlaybookExecutionContext = {
        ...baseContext,
        variables: {
          ...(baseContext.variables ?? {}),
          ...(body.variables ?? {}),
        },
      };

      const [execution] = await db
        .insert(playbookExecutions)
        .values({
          orgId: device.orgId,
          deviceId: device.id,
          playbookId: playbook.id,
          status: 'pending',
          context: mergedContext,
          triggeredBy: 'ai',
          triggeredByUserId: auth.user.id,
        })
        .returning();

      if (!execution) {
        return c.json({ error: 'Failed to create playbook execution' }, 500);
      }

      return c.json({
        execution,
        playbook: {
          id: playbook.id,
          name: playbook.name,
          description: playbook.description,
          category: playbook.category,
          steps: playbook.steps,
        },
        device,
        message: 'Execution created. Execute playbook steps sequentially and update status as progress is made.',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[playbooks] Execute playbook error:', message);
      if (message.includes('violates foreign key')) {
        return c.json({ error: 'Referenced resource no longer exists' }, 409);
      }
      return c.json({ error: 'Failed to execute playbook' }, 500);
    }
  }
);

// PATCH /api/playbooks/executions/:id
playbookRoutes.patch(
  '/executions/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', uuidParamSchema),
  zValidator('json', patchExecutionBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const auth = c.get('auth');
    const body = c.req.valid('json');

    try {
      const accessConditions: SQL[] = [eq(playbookExecutions.id, id)];
      const orgCond = auth.orgCondition(playbookExecutions.orgId);
      if (orgCond) accessConditions.push(orgCond);

      const [existing] = await db
        .select({
          id: playbookExecutions.id,
          status: playbookExecutions.status,
        })
        .from(playbookExecutions)
        .where(and(...accessConditions))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Execution not found' }, 404);
      }

      const updateData: Partial<typeof playbookExecutions.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (body.status !== undefined) {
        if (!canTransitionExecutionStatus(existing.status, body.status)) {
          return c.json({
            error: `Invalid execution status transition from "${existing.status}" to "${body.status}"`,
          }, 400);
        }
        updateData.status = body.status;
      }
      if (body.currentStepIndex !== undefined) updateData.currentStepIndex = body.currentStepIndex;
      if (body.steps !== undefined) updateData.steps = body.steps as PlaybookStepResult[];
      if (body.context !== undefined) updateData.context = body.context as PlaybookExecutionContext;
      if (body.errorMessage !== undefined) updateData.errorMessage = body.errorMessage;
      if (body.rollbackExecuted !== undefined) updateData.rollbackExecuted = body.rollbackExecuted;
      if (body.startedAt !== undefined) {
        updateData.startedAt = body.startedAt ? new Date(body.startedAt) : null;
      }
      if (body.completedAt !== undefined) {
        updateData.completedAt = body.completedAt ? new Date(body.completedAt) : null;
      }

      // Optimistic lock: include current status in WHERE to prevent race conditions
      const [updated] = await db
        .update(playbookExecutions)
        .set(updateData)
        .where(and(...accessConditions, eq(playbookExecutions.status, existing.status)))
        .returning();

      if (!updated) {
        return c.json({ error: 'Execution was modified concurrently, please retry' }, 409);
      }

      return c.json({ execution: updated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[playbooks] Update execution error:', message);
      if (message.includes('violates foreign key')) {
        return c.json({ error: 'Referenced resource no longer exists' }, 409);
      }
      return c.json({ error: 'Failed to update execution' }, 500);
    }
  }
);

// GET /api/playbooks/:id
playbookRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', uuidParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const auth = c.get('auth');

    const conditions: SQL[] = [eq(playbookDefinitions.id, id)];
    const orgCond = auth.orgCondition(playbookDefinitions.orgId);
    if (orgCond) {
      conditions.push(sql`(${playbookDefinitions.isBuiltIn} = true OR ${orgCond})`);
    }

    const [playbook] = await db
      .select()
      .from(playbookDefinitions)
      .where(and(...conditions))
      .limit(1);

    if (!playbook) {
      return c.json({ error: 'Playbook not found' }, 404);
    }

    return c.json({ playbook });
  }
);
