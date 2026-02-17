import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { executeCommand, CommandTypes } from '../../services/commandQueue';
import { createAuditLog } from '../../services/auditService';
import { getDeviceWithOrgCheck, getPagination } from './helpers';
import { deviceIdParamSchema, pidParamSchema, paginationQuerySchema } from './schemas';

export const processesRoutes = new Hono();

// GET /devices/:deviceId/processes - List all processes
processesRoutes.get(
  '/devices/:deviceId/processes',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', paginationQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const { page, limit } = getPagination(c.req.valid('query'));
    const search = c.req.query('search') || '';

    const result = await executeCommand(deviceId, CommandTypes.LIST_PROCESSES, {
      page,
      limit,
      search
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to get processes' }, 500);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({
        data: data.processes || [],
        meta: {
          total: data.total || 0,
          page: data.page || page,
          limit: data.limit || limit,
          totalPages: data.totalPages || 1
        }
      });
    } catch (parseError) {
      console.error('Failed to parse agent response for process listing:', parseError);
      return c.json({ error: 'Failed to parse agent response for process listing' }, 502);
    }
  }
);

// GET /devices/:deviceId/processes/:pid - Get process details
processesRoutes.get(
  '/devices/:deviceId/processes/:pid',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', pidParamSchema),
  async (c) => {
    const { deviceId, pid } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.GET_PROCESS, {
      pid
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to get process details';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      return c.json({ data: payload });
    } catch (error) {
      console.error('Failed to parse agent response for process details:', error);
      return c.json({ error: 'Failed to parse agent response for process details' }, 502);
    }
  }
);

// POST /devices/:deviceId/processes/:pid/kill - Kill a process
processesRoutes.post(
  '/devices/:deviceId/processes/:pid/kill',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', pidParamSchema),
  async (c) => {
    const { deviceId, pid } = c.req.valid('param');
    const auth = c.get('auth');
    const force = c.req.query('force') === 'true';

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.KILL_PROCESS, {
      pid,
      force
    }, { userId: auth.user?.id, timeoutMs: 15000 });

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'kill_process',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        pid,
        force,
        result: result.status
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to kill process' }, 500);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({
        success: true,
        message: `Process ${pid} (${data.name || 'unknown'}) terminated successfully`
      });
    } catch {
      return c.json({
        success: true,
        message: `Process ${pid} terminated successfully`
      });
    }
  }
);
