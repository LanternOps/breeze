import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, sql, desc } from 'drizzle-orm';
import { db } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getPagination, getDeviceWithOrgCheck } from './helpers';
import { createCommandSchema, bulkCommandSchema, maintenanceModeSchema } from './schemas';
import { writeRouteAudit } from '../../services/auditEvents';

export const commandsRoutes = new Hono();

commandsRoutes.use('*', authMiddleware);

function hasScriptId(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  return typeof (payload as Record<string, unknown>).scriptId === 'string';
}

// POST /devices/bulk/commands - Queue a command for multiple devices
commandsRoutes.post(
  '/bulk/commands',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', bulkCommandSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Validate payload based on command type
    if (data.type === 'script' && !hasScriptId(data.payload)) {
      return c.json({ error: 'Script commands require a scriptId in payload' }, 400);
    }

    const commandList: Array<{
      id: string;
      deviceId: string;
      type: string;
      status: string;
      createdAt: Date;
    }> = [];
    const failed: string[] = [];
    const deviceIds = [...new Set(data.deviceIds)];

    for (const deviceId of deviceIds) {
      const device = await getDeviceWithOrgCheck(deviceId, auth);
      if (!device || device.status === 'decommissioned') {
        failed.push(deviceId);
        continue;
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
        failed.push(deviceId);
        continue;
      }

      commandList.push({
        id: command.id,
        deviceId: command.deviceId,
        type: command.type,
        status: command.status,
        createdAt: command.createdAt
      });

      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'device.command.queue',
        resourceType: 'device_command',
        resourceId: command.id,
        resourceName: data.type,
        details: {
          deviceId,
          commandType: data.type,
          bulk: true
        }
      });
    }

    return c.json({ commands: commandList, failed }, 201);
  }
);

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
    if (data.type === 'script' && !hasScriptId(data.payload)) {
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

// POST /devices/:id/maintenance - Toggle maintenance mode
commandsRoutes.post(
  '/:id/maintenance',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', maintenanceModeSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot change maintenance mode for a decommissioned device' }, 400);
    }

    const targetStatus = data.enable ? 'maintenance' : 'online';
    const [updatedDevice] = await db
      .update(devices)
      .set({
        status: targetStatus,
        updatedAt: new Date()
      })
      .where(eq(devices.id, deviceId))
      .returning();

    if (!updatedDevice) {
      return c.json({ error: 'Failed to update maintenance mode' }, 500);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: data.enable ? 'device.maintenance.enable' : 'device.maintenance.disable',
      resourceType: 'device',
      resourceId: updatedDevice.id,
      resourceName: updatedDevice.hostname ?? updatedDevice.displayName ?? device.hostname,
      details: {
        durationHours: data.durationHours ?? null
      }
    });

    return c.json({ success: true, device: updatedDevice });
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
