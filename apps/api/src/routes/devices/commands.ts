import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, sql, desc } from 'drizzle-orm';
import { db } from '../../db';
import { deviceCommands } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getPagination, getDeviceWithOrgCheck } from './helpers';
import { createCommandSchema } from './schemas';
import { writeRouteAudit } from '../../services/auditEvents';

export const commandsRoutes = new Hono();

commandsRoutes.use('*', authMiddleware);

// POST /devices/:id/commands - Queue a command for device
commandsRoutes.post(
  '/:id/commands',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createCommandSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Don't allow commands to decommissioned devices
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }

    // Validate payload based on command type
    if (data.type === 'script' && (!data.payload || !data.payload.scriptId)) {
      return c.json({ error: 'Script commands require a scriptId in payload' }, 400);
    }

    const [command] = await db
      .insert(deviceCommands)
      .values({
        deviceId,
        type: data.type,
        payload: data.payload || {},
        status: 'pending',
        createdBy: auth.user.id
      })
      .returning();

    if (!command) {
      return c.json({ error: 'Failed to queue command' }, 500);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.command.queue',
      resourceType: 'device_command',
      resourceId: command.id,
      resourceName: data.type,
      details: {
        deviceId,
        commandType: data.type
      }
    });

    return c.json({
      id: command.id,
      deviceId: command.deviceId,
      type: command.type,
      status: command.status,
      createdAt: command.createdAt
    }, 201);
  }
);

// GET /devices/:id/commands - Get command history
commandsRoutes.get(
  '/:id/commands',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const { page = '1', limit = '50' } = c.req.query();
    const pagination = getPagination({ page, limit });

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, deviceId));
    const total = Number(countResult[0]?.count ?? 0);

    const commands = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, deviceId))
      .orderBy(desc(deviceCommands.createdAt))
      .limit(pagination.limit)
      .offset(pagination.offset);

    return c.json({
      data: commands,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total
      }
    });
  }
);
