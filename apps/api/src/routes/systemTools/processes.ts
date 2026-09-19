import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { executeCommand, CommandTypes } from '../../services/commandQueue';
import { createAuditLog } from '../../services/auditService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED, getPagination } from './helpers';
import { deviceIdParamSchema, pidParamSchema, paginationQuerySchema } from './schemas';
import {
  isCommandFailure,
  buildCommandFailureResponse,
  auditErrorMessage,
} from './fileBrowserHelpers';

const processListQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().max(500).optional(),
});

export const processesRoutes = new Hono();

// GET /devices/:deviceId/processes - List all processes
processesRoutes.get(
  '/devices/:deviceId/processes',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', processListQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const query = c.req.valid('query');
    const { page, limit } = getPagination(query, 500);
    const search = query.search || '';

    const result = await executeCommand(deviceId, CommandTypes.LIST_PROCESSES, {
      page,
      limit,
      search
    }, { userId: auth.user?.id, timeoutMs: 60000 });

    if (isCommandFailure(result)) {
      const failure = buildCommandFailureResponse(result, 'Failed to get processes');
      return c.json(failure.body, failure.status);
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
      // 500, not 502: Cloudflare replaces an origin 502 body with its own
      // branded page, blanking this message on hosted deployments.
      return c.json({ error: 'Failed to parse agent response for process listing', code: 'invalid_agent_response' }, 500);
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

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.GET_PROCESS, {
      pid
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (isCommandFailure(result)) {
      const failure = buildCommandFailureResponse(result, 'Failed to get process details');
      return c.json(failure.body, failure.status);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      return c.json({ data: payload });
    } catch (error) {
      console.error('Failed to parse agent response for process details:', error);
      // 500, not 502: Cloudflare replaces an origin 502 body with its own
      // branded page, blanking this message on hosted deployments.
      return c.json({ error: 'Failed to parse agent response for process details', code: 'invalid_agent_response' }, 500);
    }
  }
);

// POST /devices/:deviceId/processes/:pid/kill - Kill a process
processesRoutes.post(
  '/devices/:deviceId/processes/:pid/kill',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', pidParamSchema),
  zValidator('query', z.object({
    force: z.enum(['true', 'false']).optional(),
  })),
  async (c) => {
    const { deviceId, pid } = c.req.valid('param');
    const auth = c.get('auth');
    const force = c.req.valid('query').force === 'true';

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
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
      ipAddress: getTrustedClientIpOrUndefined(c),
      result: isCommandFailure(result) ? 'failure' : 'success',
      errorMessage: auditErrorMessage(result)
    });

    if (isCommandFailure(result)) {
      const failure = buildCommandFailureResponse(result, 'Failed to kill process', { mutating: true });
      return c.json(failure.body, failure.status);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({
        success: true,
        message: `Process ${pid} (${data.name || 'unknown'}) terminated successfully`
      });
    } catch (parseError) {
      // The kill itself is confirmed — `isCommandFailure` above already ruled
      // out failed/timeout, so `status` is 'completed' and the agent acked the
      // termination. Only the metadata used to prettify the message failed to
      // parse, so reporting success is correct here. Logged rather than
      // swallowed: a bare catch in THIS handler is what let #4025 read as
      // routine, and an unparseable payload from a completed kill still says
      // something is wrong with the agent's response shape.
      console.error('Failed to parse agent response for process kill:', parseError);
      return c.json({
        success: true,
        message: `Process ${pid} terminated successfully`
      });
    }
  }
);
