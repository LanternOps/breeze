import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { executeCommand, CommandTypes } from '../../services/commandQueue';
import { createAuditLog } from '../../services/auditService';
import { getDeviceWithOrgCheck, getPagination, asRecord, asString, asOptionalNumber } from './helpers';
import {
  deviceIdParamSchema,
  taskPathParamSchema,
  taskHistoryQuerySchema,
  paginationQuerySchema
} from './schemas';
import type { ScheduledTaskInfo, TaskHistoryEntry } from './types';

function normalizeTaskState(value?: string): ScheduledTaskInfo['state'] {
  switch ((value ?? '').toLowerCase()) {
    case 'ready':
    case 'running':
    case 'disabled':
    case 'queued':
      return value!.toLowerCase() as ScheduledTaskInfo['state'];
    default:
      return 'unknown';
  }
}

function normalizeTaskTrigger(trigger: unknown): ScheduledTaskInfo['triggers'][number] | null {
  if (typeof trigger === 'string') {
    const text = trigger.trim();
    if (!text) return null;
    return { type: text, enabled: true };
  }

  const record = asRecord(trigger);
  if (!record) return null;

  const type = asString(record.type) ?? asString(record.name) ?? asString(record.description) ?? 'Schedule';
  const schedule = asString(record.schedule) ?? asString(record.startBoundary) ?? asString(record.nextRunTime);
  const enabledRaw = record.enabled;
  const enabled = typeof enabledRaw === 'boolean'
    ? enabledRaw
    : typeof enabledRaw === 'string'
      ? enabledRaw.toLowerCase() !== 'false'
      : true;

  return schedule ? { type, enabled, schedule } : { type, enabled };
}

function normalizeTaskAction(action: unknown): ScheduledTaskInfo['actions'][number] | null {
  if (typeof action === 'string') {
    const path = action.trim();
    if (!path) return null;
    return { type: 'execute', path };
  }

  const record = asRecord(action);
  if (!record) return null;

  const type = asString(record.type) ?? 'execute';
  const path = asString(record.path) ?? asString(record.command);
  const args = asString(record.arguments) ?? asString(record.args);

  return {
    type,
    ...(path ? { path } : {}),
    ...(args ? { arguments: args } : {})
  };
}

function normalizeScheduledTask(task: unknown): ScheduledTaskInfo | null {
  const record = asRecord(task);
  if (!record) return null;

  const path = asString(record.path) ?? asString(record.taskPath) ?? '';
  const derivedName = path.split('\\').filter(Boolean).pop() ?? path;
  const name = asString(record.name) ?? (derivedName || 'Unknown Task');

  const triggers = Array.isArray(record.triggers)
    ? record.triggers.map(normalizeTaskTrigger).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];
  const actions = Array.isArray(record.actions)
    ? record.actions.map(normalizeTaskAction).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];

  return {
    path,
    name,
    state: normalizeTaskState(asString(record.state) ?? asString(record.status)),
    lastRunTime: asString(record.lastRunTime) ?? asString(record.lastRun) ?? null,
    lastRunResult: asOptionalNumber(record.lastRunResult ?? record.lastResult),
    nextRunTime: asString(record.nextRunTime) ?? asString(record.nextRun) ?? null,
    author: asString(record.author) ?? '',
    description: asString(record.description) ?? '',
    triggers,
    actions
  };
}

function normalizeTaskHistoryLevel(value?: string): TaskHistoryEntry['level'] {
  switch ((value ?? '').toLowerCase()) {
    case 'error':
    case 'critical':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'info';
  }
}

function mapTaskHistoryFromAgent(entry: unknown): TaskHistoryEntry | null {
  const record = asRecord(entry);
  if (!record) return null;

  const id = asString(record.id);
  const eventId = asOptionalNumber(record.eventId);
  const timestamp = asString(record.timestamp);
  const message = asString(record.message);
  if (!id || eventId === null || !timestamp || !message) return null;

  const resultCode = asOptionalNumber(record.resultCode);

  return {
    id,
    eventId,
    timestamp,
    level: normalizeTaskHistoryLevel(asString(record.level)),
    message,
    ...(resultCode === null ? {} : { resultCode })
  };
}

export const scheduledTasksRoutes = new Hono();

// GET /devices/:deviceId/tasks - List scheduled tasks
scheduledTasksRoutes.get(
  '/devices/:deviceId/tasks',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', paginationQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { page, limit } = getPagination(c.req.valid('query'));
    const folder = c.req.query('folder') || '\\';
    const search = c.req.query('search') || '';
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.TASKS_LIST, {
      folder,
      search,
      page,
      limit
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to list tasks' }, 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      const tasks = rawTasks
        .map(normalizeScheduledTask)
        .filter((task: ScheduledTaskInfo | null): task is ScheduledTaskInfo => Boolean(task));

      return c.json({
        data: tasks,
        meta: {
          total: typeof payload.total === 'number' ? payload.total : tasks.length,
          page: typeof payload.page === 'number' ? payload.page : page,
          limit: typeof payload.limit === 'number' ? payload.limit : limit,
          totalPages: typeof payload.totalPages === 'number' ? payload.totalPages : 1
        }
      });
    } catch (error) {
      console.error('Failed to parse agent response for task listing:', error);
      return c.json({ error: 'Failed to parse agent response for task listing' }, 502);
    }
  }
);

// GET /devices/:deviceId/tasks/:path - Get task details
scheduledTasksRoutes.get(
  '/devices/:deviceId/tasks/:path',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.TASK_GET, {
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to get task';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const task = normalizeScheduledTask(payload);
      if (!task) {
        return c.json({ error: 'Invalid task payload from agent' }, 502);
      }
      return c.json({ data: task });
    } catch (error) {
      console.error('Failed to parse agent response for task details:', error);
      return c.json({ error: 'Failed to parse agent response for task details' }, 502);
    }
  }
);

// GET /devices/:deviceId/tasks/:path/history - Get task history
scheduledTasksRoutes.get(
  '/devices/:deviceId/tasks/:path/history',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  zValidator('query', taskHistoryQuerySchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const { limit: limitRaw } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const limitParsed = Number.parseInt(limitRaw ?? '50', 10);
    const limit = Number.isFinite(limitParsed) ? Math.min(200, Math.max(1, limitParsed)) : 50;

    const result = await executeCommand(deviceId, CommandTypes.TASK_HISTORY, {
      path,
      limit
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to get task history';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const history = (Array.isArray(payload.history) ? payload.history : [])
        .map(mapTaskHistoryFromAgent)
        .filter((entry: TaskHistoryEntry | null): entry is TaskHistoryEntry => Boolean(entry));

      return c.json({
        data: history,
        meta: {
          total: typeof payload.total === 'number' ? payload.total : history.length,
          path: typeof payload.path === 'string' ? payload.path : path,
          limit
        }
      });
    } catch (error) {
      console.error('Failed to parse agent response for task history:', error);
      return c.json({ error: 'Failed to parse agent response for task history' }, 502);
    }
  }
);

// POST /devices/:deviceId/tasks/:path/run - Run task
scheduledTasksRoutes.post(
  '/devices/:deviceId/tasks/:path/run',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.TASK_RUN, {
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'run_scheduled_task',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: { path },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to run task';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    return c.json({
      success: true,
      message: `Task ${path} started successfully`
    });
  }
);

// POST /devices/:deviceId/tasks/:path/enable - Enable task
scheduledTasksRoutes.post(
  '/devices/:deviceId/tasks/:path/enable',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.TASK_ENABLE, {
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'enable_scheduled_task',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: { path },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to enable task';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    return c.json({
      success: true,
      message: `Task ${path} enabled successfully`
    });
  }
);

// POST /devices/:deviceId/tasks/:path/disable - Disable task
scheduledTasksRoutes.post(
  '/devices/:deviceId/tasks/:path/disable',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.TASK_DISABLE, {
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'disable_scheduled_task',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: { path },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to disable task';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    return c.json({
      success: true,
      message: `Task ${path} disabled successfully`
    });
  }
);
