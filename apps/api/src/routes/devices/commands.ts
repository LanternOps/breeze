import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, sql, desc, and } from 'drizzle-orm';
import { db } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../../middleware/auth';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getPagination, getDeviceWithOrgCheck } from './helpers';
import { createCommandSchema, bulkCommandSchema, maintenanceModeSchema } from './schemas';
import { writeRouteAudit } from '../../services/auditEvents';
import { commandAuditDetails, sanitizeCommandForHistory } from '../../services/commandAudit';

export const commandsRoutes = new Hono();

commandsRoutes.use('*', authMiddleware);

function canAccessDeviceSite(device: { siteId?: string | null }, userPerms: UserPermissions | undefined): boolean {
  if (!userPerms?.allowedSiteIds) return true;
  return typeof device.siteId === 'string' && canAccessSite(userPerms, device.siteId);
}

// POST /devices/bulk/commands - Queue a command for multiple devices
commandsRoutes.post(
  '/bulk/commands',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', bulkCommandSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    if (data.type === 'script') {
      return c.json({ error: 'Script commands must be executed through the scripts endpoint' }, 400);
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
          ...commandAuditDetails(command.id, data.type, data.payload || {}),
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
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', createCommandSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    if (data.type === 'script') {
      return c.json({ error: 'Script commands must be executed through the scripts endpoint' }, 400);
    }

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Don't allow commands to decommissioned devices
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
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
        ...commandAuditDetails(command.id, data.type, data.payload || {})
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
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  zValidator('json', maintenanceModeSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
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
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { page = '1', limit = '50' } = c.req.query();
    const pagination = getPagination({ page, limit });

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
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
      data: commands.map((command) => sanitizeCommandForHistory(command)),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total
      }
    });
  }
);

// GET /devices/:id/commands/:commandId - Get a single command
commandsRoutes.get(
  '/:id/commands/:commandId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const commandId = c.req.param('commandId')!;

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.deviceId, deviceId)
        )
      )
      .limit(1);

    if (!command) {
      return c.json({ error: 'Command not found' }, 404);
    }

    return c.json({ data: sanitizeCommandForHistory(command) });
  }
);
