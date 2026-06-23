import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, sql, desc, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getPagination, getDeviceWithOrgCheck, canAccessDeviceSite } from './helpers';
import { createCommandSchema, bulkCommandSchema, maintenanceModeSchema } from './schemas';
import { writeRouteAudit } from '../../services/auditEvents';
import { commandAuditDetails, sanitizeCommandForHistory } from '../../services/commandAudit';
import type { CommandPayload } from '../../services/commandQueue';
import { dispatchWake, type WakeFailureCode } from '../../services/wakeOnLan';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import {
  resolveLegacyAgentUpdateTarget,
  resolveManualComponentTarget,
  type AgentUpdateComponent,
} from '../../services/agentUpdateTargets';

export const commandsRoutes = new Hono();

commandsRoutes.use('*', authMiddleware);

const COMMAND_SET_AUTO_UPDATE = 'set_auto_update';
const COMMAND_LEGACY_AGENT_UPDATE = 'legacy_agent_update';
const COMPONENT_UPDATE_TYPES: Record<AgentUpdateComponent, { type: string; targetRole: 'agent' | 'watchdog' }> = {
  agent: { type: 'update_agent', targetRole: 'watchdog' },
  watchdog: { type: 'update_watchdog', targetRole: 'agent' },
};

const componentUpdateSchema = z.object({
  component: z.enum(['agent', 'watchdog']),
  version: z.string().min(1).max(64).optional(),
});

const legacyAgentUpdateSchema = z.object({
  version: z.string().min(1).max(64).optional(),
});

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
        code: WakeFailureCode | 'DECOMMISSIONED' | 'TARGET_NOT_FOUND' | 'SITE_ACCESS_DENIED';
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
          // Per-device authorization — org filtering happens in
          // getDeviceWithOrgCheck and site filtering happens immediately
          // below. dispatchWake itself does NOT independently authorize the
          // caller, so these gates must run before the wake dispatches.
          const device = await getDeviceWithOrgCheck(deviceId, auth);
          if (!device) {
            failed.push({ deviceId, code: 'TARGET_NOT_FOUND', message: 'Device not found or access denied.' });
            continue;
          }
          if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
            failed.push({ deviceId, code: 'SITE_ACCESS_DENIED', message: 'Access to this site denied.' });
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
    // Typed per-device failures so the caller can distinguish "device gone"
    // from "site denied" from "decommissioned" from "insert failed". Matches
    // the wake worker shape above so the UI can render one summary toast.
    type BulkFailureCode =
      | 'TARGET_NOT_FOUND'
      | 'SITE_ACCESS_DENIED'
      | 'DECOMMISSIONED'
      | 'INSERT_FAILED';
    const failed: Array<{ deviceId: string; code: BulkFailureCode; message: string }> = [];
    // Devices that completed successfully on a prior call and would queue
    // a duplicate now (currently only the refresh_inventory dedup path).
    // Surfaced separately from `failed` so the caller can say "N queued,
    // M already pending" without misreporting deduped devices as failures.
    const skipped: Array<{ deviceId: string; code: 'ALREADY_PENDING'; commandId: string }> = [];

    for (const deviceId of deviceIds) {
      const device = await getDeviceWithOrgCheck(deviceId, auth);
      if (!device) {
        failed.push({ deviceId, code: 'TARGET_NOT_FOUND', message: 'Device not found or access denied.' });
        continue;
      }
      // Site denial must win over device-state denials: returning
      // `DECOMMISSIONED` to a site-restricted caller would confirm the
      // device exists, is in a reachable org, and is decommissioned.
      // Keep this in the same order as the wake/single/maintenance paths.
      if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
        failed.push({ deviceId, code: 'SITE_ACCESS_DENIED', message: 'Access to this site denied.' });
        continue;
      }
      if (device.status === 'decommissioned') {
        failed.push({ deviceId, code: 'DECOMMISSIONED', message: 'Cannot send commands to a decommissioned device.' });
        continue;
      }

      // Same dedup #856 added to /:id/commands. The bulk path was missed
      // — caught by @xxiaoxiong on #831. Record into `skipped` (not
      // `failed`) so the caller can show an accurate "N queued, M already
      // pending" without misreporting it as an error.
      if (data.type === 'refresh_inventory') {
        const [existingPending] = await db
          .select({ id: deviceCommands.id })
          .from(deviceCommands)
          .where(
            and(
              eq(deviceCommands.deviceId, deviceId),
              eq(deviceCommands.type, 'refresh_inventory'),
              eq(deviceCommands.status, 'pending'),
            ),
          )
          .limit(1);
        if (existingPending) {
          skipped.push({ deviceId, code: 'ALREADY_PENDING', commandId: existingPending.id });
          continue;
        }
      }

      // Wrap the insert so a constraint violation, pool exhaustion, or
      // other postgres error on one device records as INSERT_FAILED for
      // that device instead of throwing out of the whole loop and
      // 500-ing the entire batch (losing every prior success).
      let command: typeof deviceCommands.$inferSelect | undefined;
      try {
        [command] = await db
          .insert(deviceCommands)
          .values({
            deviceId,
            type: data.type,
            payload: data.payload || {},
            status: 'pending',
            createdBy: auth.user.id
          })
          .returning();
      } catch (err) {
        failed.push({
          deviceId,
          code: 'INSERT_FAILED',
          message: err instanceof Error ? err.message : 'Failed to queue command.',
        });
        continue;
      }

      if (!command) {
        // `returning()` on a successful insert always yields ≥1 row, so
        // this branch is defensive against a future driver change rather
        // than a path that fires in practice.
        failed.push({ deviceId, code: 'INSERT_FAILED', message: 'Failed to queue command.' });
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

    return c.json({ commands: commandList, failed, skipped }, 201);
  }
);

// POST /devices/:id/legacy-agent-update - Queue the old heartbeat-based updater path.
commandsRoutes.post(
  '/:id/legacy-agent-update',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', legacyAgentUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }

    const target = await resolveLegacyAgentUpdateTarget({
      device: {
        id: device.id,
        orgId: device.orgId,
        osType: device.osType,
        architecture: device.architecture,
        agentVersion: device.agentVersion,
        watchdogVersion: device.watchdogVersion,
      },
      version: data.version,
    });
    if (!target.ok) {
      return c.json({ error: target.message, code: target.code, decision: target.decision }, target.status as 400 | 409);
    }

    const [existingPending] = await db
      .select({
        id: deviceCommands.id,
        payload: deviceCommands.payload,
        status: deviceCommands.status,
      })
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.type, COMMAND_LEGACY_AGENT_UPDATE),
          eq(deviceCommands.targetRole, 'server'),
          inArray(deviceCommands.status, ['pending', 'sent']),
        ),
      )
      .limit(1);
    if (existingPending) {
      const payload = existingPending.payload as Record<string, unknown> | null;
      const existingVersion = typeof payload?.version === 'string' ? payload.version : null;
      return c.json({
        error: 'Legacy agent update is already pending for this device',
        code: 'ALREADY_PENDING',
        commandId: existingPending.id,
        existingVersion,
        status: existingPending.status,
      }, 409);
    }

    const queued = await db.transaction(async (tx) => {
      const [setAutoUpdateCommand] = await tx
        .insert(deviceCommands)
        .values({
          deviceId,
          type: COMMAND_SET_AUTO_UPDATE,
          payload: {
            enabled: true,
            reason: COMMAND_LEGACY_AGENT_UPDATE,
            targetVersion: target.targetVersion,
          },
          status: 'pending',
          targetRole: 'agent',
          createdBy: auth.user.id,
        })
        .returning();
      if (!setAutoUpdateCommand) return null;

      const [legacyCommand] = await tx
        .insert(deviceCommands)
        .values({
          deviceId,
          type: COMMAND_LEGACY_AGENT_UPDATE,
          payload: {
            component: 'agent',
            version: target.targetVersion,
            requestedVersion: data.version ?? null,
            manual: true,
            setAutoUpdateCommandId: setAutoUpdateCommand.id,
          },
          status: 'pending',
          targetRole: 'server',
          createdBy: auth.user.id,
        })
        .returning();
      if (!legacyCommand) return null;

      return { legacyCommand, setAutoUpdateCommand };
    });

    if (!queued) {
      return c.json({ error: 'Failed to queue legacy agent update' }, 500);
    }
    const { legacyCommand, setAutoUpdateCommand } = queued;

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.legacy_agent_update.request',
      resourceType: 'device_command',
      resourceId: legacyCommand.id,
      resourceName: COMMAND_LEGACY_AGENT_UPDATE,
      details: {
        deviceId,
        component: 'agent',
        targetVersion: target.targetVersion,
        setAutoUpdateCommandId: setAutoUpdateCommand.id,
        ...commandAuditDetails(legacyCommand.id, COMMAND_LEGACY_AGENT_UPDATE, (legacyCommand.payload ?? {}) as CommandPayload),
      },
    });

    return c.json({
      id: legacyCommand.id,
      deviceId: legacyCommand.deviceId,
      type: legacyCommand.type,
      status: legacyCommand.status,
      targetRole: legacyCommand.targetRole,
      targetVersion: target.targetVersion,
      component: 'agent',
      setAutoUpdateCommandId: setAutoUpdateCommand.id,
      createdAt: legacyCommand.createdAt,
    }, 202);
  },
);

// POST /devices/:id/component-update - Queue an explicit agent/watchdog update or repair
commandsRoutes.post(
  '/:id/component-update',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', componentUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }
    if (data.component === 'agent' && !device.watchdogVersion) {
      return c.json({
        error: 'Watchdog is required to update the main agent. Repair watchdog first.',
        code: 'WATCHDOG_REQUIRED',
      }, 409);
    }

    const target = await resolveManualComponentTarget({
      device: {
        id: device.id,
        orgId: device.orgId,
        osType: device.osType,
        architecture: device.architecture,
        agentVersion: device.agentVersion,
        watchdogVersion: device.watchdogVersion,
      },
      component: data.component,
      version: data.version,
    });
    if (!target.ok) {
      return c.json({ error: target.message, code: target.code, decision: target.decision }, target.status as 400 | 409);
    }

    const commandSpec = COMPONENT_UPDATE_TYPES[data.component];
    const existingPending = await db
      .select({
        id: deviceCommands.id,
        payload: deviceCommands.payload,
        status: deviceCommands.status,
      })
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.type, commandSpec.type),
          eq(deviceCommands.targetRole, commandSpec.targetRole),
          inArray(deviceCommands.status, ['pending', 'sent']),
        ),
      )
      .limit(20);
    const duplicate = existingPending[0];
    if (duplicate) {
      const payload = duplicate.payload as Record<string, unknown> | null;
      const existingVersion = typeof payload?.version === 'string' ? payload.version : null;
      return c.json({
        error: `${data.component} update is already pending for this device`,
        code: 'ALREADY_PENDING',
        commandId: duplicate.id,
        existingVersion,
        status: duplicate.status,
      }, 409);
    }

    const [command] = await db
      .insert(deviceCommands)
      .values({
        deviceId,
        type: commandSpec.type,
        payload: {
          component: data.component,
          version: target.targetVersion,
          requestedVersion: data.version ?? null,
          manual: true,
        },
        status: 'pending',
        targetRole: commandSpec.targetRole,
        createdBy: auth.user.id,
      })
      .returning();

    if (!command) {
      return c.json({ error: 'Failed to queue component update' }, 500);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.component_update.request',
      resourceType: 'device_command',
      resourceId: command.id,
      resourceName: commandSpec.type,
      details: {
        deviceId,
        component: data.component,
        targetVersion: target.targetVersion,
        targetRole: commandSpec.targetRole,
        ...commandAuditDetails(command.id, commandSpec.type, (command.payload ?? {}) as CommandPayload),
      },
    });

    return c.json({
      id: command.id,
      deviceId: command.deviceId,
      type: command.type,
      status: command.status,
      targetRole: command.targetRole,
      targetVersion: target.targetVersion,
      component: data.component,
      createdAt: command.createdAt,
    }, 202);
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
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    // Don't allow commands to decommissioned devices
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }

    // Dedup refresh_inventory: each click fans out ~12 collectors on the
    // agent, and the API returns 201 as soon as the row is inserted, so a
    // fast clicker could queue an unbounded backlog. Reject when a pending
    // refresh_inventory already exists for this device. Other commands
    // are self-limiting (reboot/shutdown — the device goes away) or rare
    // (containment, evidence collection) so this guard is scoped narrowly.
    // (#830)
    if (data.type === 'refresh_inventory') {
      const [existingPending] = await db
        .select({ id: deviceCommands.id })
        .from(deviceCommands)
        .where(
          and(
            eq(deviceCommands.deviceId, deviceId),
            eq(deviceCommands.type, 'refresh_inventory'),
            eq(deviceCommands.status, 'pending'),
          ),
        )
        .limit(1);
      if (existingPending) {
        return c.json(
          {
            error: 'An inventory refresh is already pending for this device',
            code: 'ALREADY_PENDING',
            commandId: existingPending.id,
          },
          409,
        );
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
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
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
    // Site denial must win over device-state denials — see bulk-generic
    // for rationale.
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
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
