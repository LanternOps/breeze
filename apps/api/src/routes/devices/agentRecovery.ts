import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { deviceCommands } from '../../db/schema';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getDeviceWithOrgCheck, canAccessDeviceSite } from './helpers';
import { WATCHDOG_RECOVERY_COMMAND_TYPES, enqueueWatchdogCommand } from '../../services/commandQueue';
import { writeRouteAudit } from '../../services/auditEvents';
import { trustDenyBody, type TrustDenyCode } from '../../services/partnerTrust';

export const agentRecoveryRoutes = new Hono();

agentRecoveryRoutes.use('*', authMiddleware);

const agentRecoverySchema = z.object({
  // The watchdog's agent-binary update command is deliberately not offered:
  // it needs a target version and the artifact-edition gate (#4093), which is
  // a release decision, not a button. (Not named here: agentEditionCompat.test
  // scans for the literal.)
  action: z.enum(WATCHDOG_RECOVERY_COMMAND_TYPES),
});

// POST /devices/:id/agent-recovery — ask the device's WATCHDOG to restart
// (`restart_agent`) or start (`start_agent`) the Breeze agent (#9234 step 1).
//
// For the case where the agent itself is what is broken: the watchdog is a
// separate service with its own failover poll, so this works when the agent
// has no live socket and will not run commands. It is the same path the
// `trigger_agent_restart` AI tool takes (no new trust path), behind its own
// permission and its own audit event.
//
// The watchdog only polls while it is in FAILOVER, i.e. while the agent is
// down. With a healthy agent its last-seen goes stale and the dispatch
// precheck refuses with "Watchdog is not reporting" (409) rather than queueing
// a command nothing will claim.
//
// Answers 202: the command is queued, not done. The watchdog claims it on its
// next poll (~30s) and reports the result on the command row.
agentRecoveryRoutes.post(
  '/:id/agent-recovery',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_RECOVER_AGENT.resource, PERMISSIONS.DEVICES_RECOVER_AGENT.action),
  requireMfa(),
  zValidator('json', agentRecoverySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { action } = c.req.valid('json');

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

    // One recovery in flight per device. A second click while the watchdog
    // has not yet claimed (pending) or finished (sent) the first would only
    // queue a duplicate restart behind it — the same narrow dedup
    // refresh_inventory uses in commands.ts (#830).
    const [inFlight] = await db
      .select({ id: deviceCommands.id, type: deviceCommands.type })
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.targetRole, 'watchdog'),
          inArray(deviceCommands.type, [...WATCHDOG_RECOVERY_COMMAND_TYPES]),
          inArray(deviceCommands.status, ['pending', 'sent']),
        ),
      )
      .limit(1);
    if (inFlight) {
      return c.json(
        {
          error: 'An agent restart is already waiting for the watchdog on this device',
          code: 'ALREADY_PENDING',
          commandId: inFlight.id,
        },
        409,
      );
    }

    const queued = await enqueueWatchdogCommand(deviceId, action, {
      userId: auth.user.id,
      expectedOrgId: device.orgId,
    });

    if (queued.status === 'failed') {
      if (queued.trust) {
        return c.json(
          trustDenyBody(
            {
              allow: false,
              code: queued.error as TrustDenyCode,
              capability: queued.trust.capability,
              reason: queued.trust.reason,
            },
            false,
          ),
          403,
        );
      }
      if (queued.error === 'Device not found') {
        return c.json({ error: 'Device not found' }, 404);
      }
      // Watchdog not reporting, parked device, or the row failed to insert:
      // the device is not in a state that can take the command right now.
      return c.json({ error: queued.error, code: 'WATCHDOG_REFUSED' }, 409);
    }

    const watchdogLastSeen = device.watchdogLastSeen ? device.watchdogLastSeen.toISOString() : null;

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.agent_recovery.request',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        deviceId,
        commandId: queued.commandId,
        commandType: action,
        targetRole: 'watchdog',
        watchdogStatus: device.watchdogStatus ?? null,
        watchdogLastSeen,
        mainAgentSilentSince: device.mainAgentSilentSince ? device.mainAgentSilentSince.toISOString() : null,
      },
    });

    return c.json(
      {
        commandId: queued.commandId,
        action,
        status: 'queued' as const,
        watchdogStatus: device.watchdogStatus ?? null,
        watchdogLastSeen,
      },
      202,
    );
  },
);
