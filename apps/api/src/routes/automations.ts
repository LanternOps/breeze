import { randomUUID } from 'crypto';
import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  automations,
  automationRuns,
} from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  AutomationValidationError,
  createAutomationRunRecord,
  normalizeAutomationActions,
  normalizeAutomationTrigger,
  normalizeNotificationTargets,
  withWebhookDefaults,
} from '../services/automationRuntime';
import { enqueueAutomationRun } from '../jobs/automationWorker';

export const automationRoutes = new Hono();
export const automationWebhookRoutes = new Hono();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function ensureOrgAccess(orgId: string, auth: AuthContext) {
  return auth.canAccessOrg(orgId);
}

async function getAutomationWithOrgCheck(automationId: string, auth: AuthContext) {
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

function normalizeIncomingTrigger(input: {
  trigger?: unknown;
  triggerType?: 'schedule' | 'event' | 'webhook' | 'manual';
  triggerConfig?: unknown;
}): unknown {
  if (input.trigger !== undefined) {
    return input.trigger;
  }

  if (!input.triggerType) {
    return undefined;
  }

  const triggerConfig = isPlainRecord(input.triggerConfig) ? input.triggerConfig : {};

  if (input.triggerType === 'manual') {
    return { type: 'manual' };
  }

  if (input.triggerType === 'schedule') {
    return {
      type: 'schedule',
      cronExpression: asString(triggerConfig.cronExpression) ?? asString(triggerConfig.cron) ?? '0 9 * * *',
      timezone: asString(triggerConfig.timezone) ?? 'UTC',
    };
  }

  if (input.triggerType === 'event') {
    return {
      type: 'event',
      eventType: asString(triggerConfig.eventType) ?? 'device.offline',
      filter: isPlainRecord(triggerConfig.filter) ? triggerConfig.filter : undefined,
    };
  }

  return {
    type: 'webhook',
    secret: asString(triggerConfig.secret) ?? asString(triggerConfig.webhookSecret),
    webhookUrl: asString(triggerConfig.webhookUrl),
  };
}

function normalizeIncomingNotificationTargets(input: {
  notificationTargets?: unknown;
  notifyOnFailureChannelId?: string;
}): unknown {
  if (input.notificationTargets !== undefined) {
    return input.notificationTargets;
  }

  if (input.notifyOnFailureChannelId) {
    return { channelIds: [input.notifyOnFailureChannelId] };
  }

  return undefined;
}

function shapeAutomationForResponse(automation: typeof automations.$inferSelect) {
  const trigger = isPlainRecord(automation.trigger) ? automation.trigger : {};
  const triggerType = asString(trigger.type) ?? 'manual';

  const triggerConfig = {
    cronExpression: asString(trigger.cronExpression) ?? asString(trigger.cron),
    timezone: asString(trigger.timezone),
    eventType: asString(trigger.eventType),
    webhookUrl: asString(trigger.webhookUrl),
  };

  const notificationTargets = isPlainRecord(automation.notificationTargets)
    ? automation.notificationTargets
    : {};

  const channelIds = Array.isArray(notificationTargets.channelIds)
    ? notificationTargets.channelIds.filter((value): value is string => typeof value === 'string')
    : [];

  return {
    ...automation,
    triggerType,
    triggerConfig,
    notifyOnFailureChannelId: channelIds[0],
  };
}

function toRunStatus(status: (typeof automationRuns.$inferSelect)['status']) {
  if (status === 'completed') return 'success';
  return status;
}

function serializeRunLogs(logs: unknown): string[] {
  if (!Array.isArray(logs)) return [];
  return logs
    .map((entry) => {
      if (!isPlainRecord(entry)) return null;
      const level = asString(entry.level) ?? 'info';
      const message = asString(entry.message) ?? '';
      if (!message) return null;
      return `[${level}] ${message}`;
    })
    .filter((line): line is string => Boolean(line));
}

const listAutomationsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  enabled: z.enum(['true', 'false']).optional(),
});

const triggerTypeSchema = z.enum(['schedule', 'event', 'webhook', 'manual']);

const createAutomationSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  trigger: z.unknown().optional(),
  triggerType: triggerTypeSchema.optional(),
  triggerConfig: z.unknown().optional(),
  conditions: z.unknown().optional(),
  actions: z.unknown().optional(),
  onFailure: z.enum(['stop', 'continue', 'notify']).default('stop'),
  notificationTargets: z.unknown().optional(),
  notifyOnFailureChannelId: z.string().uuid().optional(),
});

const updateAutomationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  trigger: z.unknown().optional(),
  triggerType: triggerTypeSchema.optional(),
  triggerConfig: z.unknown().optional(),
  conditions: z.unknown().optional(),
  actions: z.unknown().optional(),
  onFailure: z.enum(['stop', 'continue', 'notify']).optional(),
  notificationTargets: z.unknown().optional(),
  notifyOnFailureChannelId: z.string().uuid().optional(),
});

const listRunsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'partial']).optional(),
});

automationRoutes.use('*', authMiddleware);

// ============================================
// Read-only routes
// ============================================

automationRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listAutomationsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions: SQL<unknown>[] = [];

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
            pagination: { page, limit, total: 0 },
          });
        }
        conditions.push(inArray(automations.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(automations.orgId, query.orgId));
    }

    if (query.enabled !== undefined) {
      conditions.push(eq(automations.enabled, query.enabled === 'true'));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automations)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const rows = await db
      .select()
      .from(automations)
      .where(whereCondition)
      .orderBy(desc(automations.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows.map(shapeAutomationForResponse),
      pagination: { page, limit, total },
    });
  },
);

automationRoutes.get(
  '/runs/:runId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('runId');

    const [run] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId))
      .limit(1);

    if (!run) {
      return c.json({ error: 'Automation run not found' }, 404);
    }

    // For config policy runs (automationId is null), return a lightweight response
    if (!run.automationId) {
      return c.json({
        ...run,
        status: toRunStatus(run.status),
        logs: serializeRunLogs(run.logs),
        automation: null,
        configPolicyId: run.configPolicyId,
        configItemName: run.configItemName,
      });
    }

    const automation = await getAutomationWithOrgCheck(run.automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation run not found' }, 404);
    }

    return c.json({
      ...run,
      status: toRunStatus(run.status),
      logs: serializeRunLogs(run.logs),
      automation: {
        id: automation.id,
        name: automation.name,
        orgId: automation.orgId,
      },
    });
  },
);

automationRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');

    if (automationId === 'runs') {
      return c.notFound();
    }

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    const recentRuns = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId))
      .orderBy(desc(automationRuns.startedAt))
      .limit(10);

    const runStats = await db
      .select({
        totalRuns: sql<number>`count(*)`,
        completedRuns: sql<number>`count(*) filter (where ${automationRuns.status} = 'completed')`,
        failedRuns: sql<number>`count(*) filter (where ${automationRuns.status} = 'failed')`,
        partialRuns: sql<number>`count(*) filter (where ${automationRuns.status} = 'partial')`,
      })
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId));

    return c.json({
      ...shapeAutomationForResponse(automation),
      recentRuns: recentRuns.map((run) => ({
        ...run,
        status: toRunStatus(run.status),
        logs: serializeRunLogs(run.logs),
      })),
      statistics: {
        totalRuns: Number(runStats[0]?.totalRuns ?? 0),
        completedRuns: Number(runStats[0]?.completedRuns ?? 0),
        failedRuns: Number(runStats[0]?.failedRuns ?? 0),
        partialRuns: Number(runStats[0]?.partialRuns ?? 0),
      },
    });
  },
);

automationRoutes.get(
  '/:id/runs',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listRunsSchema),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    const conditions: SQL<unknown>[] = [eq(automationRuns.automationId, automationId)];

    if (query.status) {
      conditions.push(eq(automationRuns.status, query.status));
    }

    const whereCondition = and(...conditions);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationRuns)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const rows = await db
      .select()
      .from(automationRuns)
      .where(whereCondition)
      .orderBy(desc(automationRuns.startedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows.map((run) => ({
        ...run,
        status: toRunStatus(run.status),
        logs: serializeRunLogs(run.logs),
      })),
      pagination: { page, limit, total },
    });
  },
);

// ============================================
// DEPRECATED: Automations are now managed via Configuration Policies.
// These mutation routes remain for legacy compatibility.
// ============================================

// DEPRECATED: Automations are now managed via Configuration Policies. These routes remain for legacy compatibility.
automationRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createAutomationSchema),
  async (c) => {
    const auth = c.get('auth');
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

    const triggerInput = normalizeIncomingTrigger(data);
    if (triggerInput === undefined) {
      return c.json({ error: 'trigger or triggerType is required' }, 400);
    }

    if (data.actions === undefined) {
      return c.json({ error: 'actions are required' }, 400);
    }

    try {
      const automationId = randomUUID();
      const trigger = withWebhookDefaults(
        normalizeAutomationTrigger(triggerInput),
        automationId,
        c.req.url,
      );
      const actions = normalizeAutomationActions(data.actions);
      const notificationTargets = normalizeNotificationTargets(
        normalizeIncomingNotificationTargets(data),
      );

      const [automation] = await db
        .insert(automations)
        .values({
          id: automationId,
          orgId: orgId!,
          name: data.name,
          description: data.description,
          enabled: data.enabled,
          trigger,
          conditions: data.conditions,
          actions,
          onFailure: data.onFailure,
          notificationTargets,
          createdBy: auth.user.id,
        })
        .returning();

      if (!automation) {
        return c.json({ error: 'Failed to create automation' }, 500);
      }

      writeRouteAudit(c, {
        orgId: automation.orgId,
        action: 'automation.create',
        resourceType: 'automation',
        resourceId: automation.id,
        resourceName: automation.name,
        details: { enabled: automation.enabled },
      });

      return c.json(shapeAutomationForResponse(automation), 201);
    } catch (error) {
      if (error instanceof AutomationValidationError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  },
);

// DEPRECATED: Automations are now managed via Configuration Policies. These routes remain for legacy compatibility.
async function handleUpdateAutomation(c: Context) {
  const auth = c.get('auth');
  const automationId = c.req.param('id');
  const rawPayload = await c.req.json().catch(() => ({}));
  const parsedPayload = updateAutomationSchema.safeParse(rawPayload);
  if (!parsedPayload.success) {
    return c.json({ error: parsedPayload.error.issues[0]?.message ?? 'Invalid update payload' }, 400);
  }
  const data = parsedPayload.data;

  if (Object.keys(data).length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  const automation = await getAutomationWithOrgCheck(automationId, auth);
  if (!automation) {
    return c.json({ error: 'Automation not found' }, 404);
  }

  try {
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    if (data.conditions !== undefined) updates.conditions = data.conditions;
    if (data.onFailure !== undefined) updates.onFailure = data.onFailure;

    const triggerProvided = data.trigger !== undefined
      || data.triggerType !== undefined
      || data.triggerConfig !== undefined;

    if (triggerProvided) {
      const triggerInput = normalizeIncomingTrigger(data);
      if (triggerInput === undefined) {
        return c.json({ error: 'trigger update is invalid' }, 400);
      }

      let nextTrigger = normalizeAutomationTrigger(triggerInput);
      if (nextTrigger.type === 'webhook' && !nextTrigger.secret) {
        const currentTrigger = isPlainRecord(automation.trigger) ? automation.trigger : {};
        const currentSecret = asNonEmptyString(currentTrigger.secret) ?? asNonEmptyString(currentTrigger.webhookSecret);
        if (currentSecret) {
          nextTrigger = {
            ...nextTrigger,
            secret: currentSecret,
          };
        }
      }

      updates.trigger = withWebhookDefaults(
        nextTrigger,
        automation.id,
        c.req.url,
      );
    }

    if (data.actions !== undefined) {
      updates.actions = normalizeAutomationActions(data.actions);
    }

    const notificationTargetsProvided = data.notificationTargets !== undefined
      || data.notifyOnFailureChannelId !== undefined;

    if (notificationTargetsProvided) {
      updates.notificationTargets = normalizeNotificationTargets(
        normalizeIncomingNotificationTargets(data),
      );
    }

    const [updated] = await db
      .update(automations)
      .set(updates)
      .where(eq(automations.id, automationId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: automation.orgId,
      action: 'automation.update',
      resourceType: 'automation',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { changedFields: Object.keys(data) },
    });

    return c.json(shapeAutomationForResponse(updated));
  } catch (error) {
    if (error instanceof AutomationValidationError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
}

// DEPRECATED: Automations are now managed via Configuration Policies. These routes remain for legacy compatibility.
automationRoutes.put(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateAutomationSchema),
  handleUpdateAutomation,
);

// DEPRECATED: Automations are now managed via Configuration Policies. These routes remain for legacy compatibility.
automationRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateAutomationSchema),
  handleUpdateAutomation,
);

// DEPRECATED: Automations are now managed via Configuration Policies. These routes remain for legacy compatibility.
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

    const runningRuns = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationRuns)
      .where(and(eq(automationRuns.automationId, automationId), eq(automationRuns.status, 'running')));

    const runningCount = Number(runningRuns[0]?.count ?? 0);
    if (runningCount > 0) {
      return c.json({
        error: 'Cannot delete automation with running executions',
        runningExecutions: runningCount,
      }, 409);
    }

    await db
      .delete(automationRuns)
      .where(eq(automationRuns.automationId, automationId));

    await db
      .delete(automations)
      .where(eq(automations.id, automationId));

    writeRouteAudit(c, {
      orgId: automation.orgId,
      action: 'automation.delete',
      resourceType: 'automation',
      resourceId: automation.id,
      resourceName: automation.name,
    });

    return c.json({ success: true });
  },
);

// ============================================
// Manual trigger routes (kept for standalone automations)
// ============================================

async function triggerAutomationRun(
  c: Context,
  automationId: string,
  triggeredBy: string,
  details?: Record<string, unknown>,
) {
  const auth = c.get('auth');

  const automation = await getAutomationWithOrgCheck(automationId, auth);
  if (!automation) {
    return c.json({ error: 'Automation not found' }, 404);
  }

  if (!automation.enabled) {
    return c.json({ error: 'Cannot trigger disabled automation' }, 400);
  }

  const { run, targetDeviceIds } = await createAutomationRunRecord({
    automation,
    triggeredBy,
    details,
  });

  await enqueueAutomationRun(run.id, targetDeviceIds);

  writeRouteAudit(c, {
    orgId: automation.orgId,
    action: 'automation.trigger',
    resourceType: 'automation',
    resourceId: automation.id,
    resourceName: automation.name,
    details: {
      runId: run.id,
      devicesTargeted: targetDeviceIds.length,
      triggeredBy,
    },
  });

  return c.json({
    message: 'Automation triggered',
    run: {
      id: run.id,
      status: toRunStatus(run.status),
      devicesTargeted: run.devicesTargeted,
      startedAt: run.startedAt,
    },
  });
}

automationRoutes.post(
  '/:id/trigger',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');
    return triggerAutomationRun(c, automationId, `manual:${auth.user.id}`);
  },
);

automationRoutes.post(
  '/:id/run',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');
    return triggerAutomationRun(c, automationId, `manual:${auth.user.id}`);
  },
);

// ============================================
// Webhook trigger route
// ============================================

automationWebhookRoutes.post('/:id', async (c) => {
  const automationId = c.req.param('id');

  const [automation] = await db
    .select()
    .from(automations)
    .where(eq(automations.id, automationId))
    .limit(1);

  if (!automation || !automation.enabled) {
    return c.json({ error: 'Automation not found' }, 404);
  }

  let trigger;
  try {
    trigger = normalizeAutomationTrigger(automation.trigger);
  } catch {
    return c.json({ error: 'Invalid automation trigger configuration' }, 400);
  }

  if (trigger.type !== 'webhook') {
    return c.json({ error: 'Automation is not configured for webhook triggering' }, 400);
  }

  const providedSecret = c.req.header('x-automation-secret')
    ?? c.req.header('x-webhook-secret')
    ?? c.req.query('secret');

  if (trigger.secret && providedSecret !== trigger.secret) {
    return c.json({ error: 'Invalid webhook secret' }, 401);
  }

  const payload = await c.req.json().catch(() => ({}));

  const { run, targetDeviceIds } = await createAutomationRunRecord({
    automation,
    triggeredBy: 'webhook',
    details: {
      sourceIp: c.req.header('x-forwarded-for') ?? c.req.header('cf-connecting-ip') ?? 'unknown',
      userAgent: c.req.header('user-agent') ?? 'unknown',
      payload,
    },
  });

  await enqueueAutomationRun(run.id, targetDeviceIds);

  return c.json({
    accepted: true,
    run: {
      id: run.id,
      status: toRunStatus(run.status),
      devicesTargeted: run.devicesTargeted,
      startedAt: run.startedAt,
    },
  }, 202);
});
