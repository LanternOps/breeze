import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, sql, desc, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../../middleware/auth';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getPagination, getDeviceWithOrgCheck } from './helpers';
import { createCommandSchema, bulkCommandSchema, maintenanceModeSchema } from './schemas';
import { writeRouteAudit } from '../../services/auditEvents';
import { commandAuditDetails, sanitizeCommandForHistory } from '../../services/commandAudit';
import { dispatchWake, type WakeFailureCode } from '../../services/wakeOnLan';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';

export const commandsRoutes = new Hono();

commandsRoutes.use('*', authMiddleware);

const COMMAND_SET_AUTO_UPDATE = 'set_auto_update';

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

    const deviceIds = [...new Set(data.deviceIds)];

    // Wake-on-LAN takes a separate path from the generic device_commands
    // insertion: each device needs a relay picked on its LAN, the command
    // row is addressed to that relay (not the offline target), and the
    // dispatch result includes per-device failure codes (NO_RELAY,
    // NO_MACS, etc.) that the UI surfaces in a grouped summary. See
    // services/wakeOnLan.ts + Discussion #694.
    if (data.type === 'wake') {
      const bulkId = randomUUID();
      const succeeded: Array<{
        deviceId: string;
        commandId: string;
        wakeAttemptId: string;
        relayDeviceId: string;
        relayHostname: string;
        broadcast: string;
      }> = [];
      const failed: Array<{
        deviceId: string;
        code: WakeFailureCode | 'DECOMMISSIONED' | 'TARGET_NOT_FOUND';
        message: string;
      }> = [];
      const ipAddress = getTrustedClientIpOrUndefined(c);
      const userAgent = c.req.header('user-agent');

      // Inline worker pool. dispatchWake does 5-7 DB selects + 2 inserts +
      // 1 update + 1 WS write per device (no locks/transactions per
      // services/wakeOnLan.ts). Concurrency 8 caps overlap on the
      // breeze_app pool (~10-20 conns) and keeps wall time on a 500-device
      // bulk well under Cloudflare's ~100s proxy timeout. Avoided a
      // p-limit dependency by inlining — the loop is trivial.
      const CONCURRENCY = 8;
      const queue = [...deviceIds];
      async function worker(): Promise<void> {
        for (;;) {
          const deviceId = queue.shift();
          if (!deviceId) return;
          // Per-device authorization — partner-scope filtering happens in
          // getDeviceWithOrgCheck (helpers.ts). dispatchWake itself does
          // NOT independently authorize the caller, so this gate must run
          // before the wake dispatches.
          const device = await getDeviceWithOrgCheck(deviceId, auth);
          if (!device) {
            failed.push({ deviceId, code: 'TARGET_NOT_FOUND', message: 'Device not found or access denied.' });
            continue;
          }
          if (device.status === 'decommissioned') {
            failed.push({ deviceId, code: 'DECOMMISSIONED', message: 'Cannot wake a decommissioned device.' });
            continue;
          }
          const result = await dispatchWake(deviceId, auth.user.id, {
            ipAddress,
            userAgent,
            bulkId,
          });
          if (result.ok) {
            succeeded.push({
              deviceId,
              commandId: result.commandId,
              wakeAttemptId: result.wakeAttemptId,
              relayDeviceId: result.relayDeviceId,
              relayHostname: result.relayHostname,
              broadcast: result.broadcast,
            });
          } else {
            failed.push({ deviceId, code: result.code, message: result.message });
          }
        }
      }
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, deviceIds.length) },
        () => worker(),
      );
      await Promise.all(workers);

      return c.json({ bulkId, succeeded, failed }, 202);
    }

    const commandList: Array<{
      id: string;
      deviceId: string;
      type: string;
      status: string;
      createdAt: Date;
    }> = [];
    const failed: string[] = [];

    for (const deviceId of deviceIds) {
      const device = await getDeviceWithOrgCheck(deviceId, auth);
      if (!device || device.status === 'decommissioned') {
        failed.push(deviceId);
        continue;
      }

      // Prevent spam: skip refresh_inventory if one is already pending for this device
      if (data.type === 'refresh_inventory') {
        const [existingPending] = await db
          .select()
          .from(deviceCommands)
          .where(
            and(
              eq(deviceCommands.deviceId, deviceId),
              eq(deviceCommands.type, 'refresh_inventory'),
              eq(deviceCommands.status, 'pending')
            )
          )
          .limit(1);

        if (existingPending) {
          failed.push(deviceId);
          continue;
        }
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

    // Prevent spam: reject refresh_inventory if one is already pending for this device
    if (data.type === 'refresh_inventory') {
      const [existingPending] = await db
        .select()
        .from(deviceCommands)
        .where(
          and(
            eq(deviceCommands.deviceId, deviceId),
            eq(deviceCommands.type, 'refresh_inventory'),
            eq(deviceCommands.status, 'pending')
          )
        )
        .limit(1);

      if (existingPending) {
        return c.json({ error: 'A refresh_inventory command is already pending for this device' }, 409);
      }
    }

    // Wake-on-LAN takes a separate path: the command row must be addressed to
    // an online relay agent on the target's LAN, not the offline target.
    if (data.type === 'wake') {
      const wake = await dispatchWake(deviceId, auth.user.id, {
        ipAddress: getTrustedClientIpOrUndefined(c),
        userAgent: c.req.header('user-agent'),
      });
      if (!wake.ok) {
        return c.json({ error: wake.message, code: wake.code }, 412);
      }
      return c.json({
        id: wake.commandId,
        deviceId,
        type: 'wake_on_lan',
        status: 'sent',
        wakeAttemptId: wake.wakeAttemptId,
        relay: { deviceId: wake.relayDeviceId, hostname: wake.relayHostname },
        network: wake.network,
        broadcast: wake.broadcast,
        macs: wake.macs,
      }, 202);
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


// POST /devices/:id/auto-update - Set auto_update configuration
commandsRoutes.post(
  '/:id/auto-update',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', z.object({ enabled: z.boolean() })),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }

    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const [command] = await db
      .insert(deviceCommands)
      .values({
        deviceId,
        type: COMMAND_SET_AUTO_UPDATE,
        payload: { enabled: data.enabled },
        status: 'pending',
        createdBy: auth.user.id
      })
      .returning();

    if (!command) {
      return c.json({ error: 'Failed to queue command' }, 500);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.auto_update.set',
      resourceType: 'device_command',
      resourceId: command.id,
      resourceName: 'set_auto_update',
      details: {
        deviceId,
        enabled: data.enabled,
        ...commandAuditDetails(command.id, 'set_auto_update', { enabled: data.enabled })
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
