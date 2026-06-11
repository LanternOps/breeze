import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  deviceCommands,
  devices,
  elevationAudit,
  elevationRequests,
} from '../../db/schema';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { canAccessSite, type UserPermissions } from '../../services/permissions';
import { getDeviceWithOrgCheck } from './helpers';

export const actuateElevationRoutes = new Hono();

actuateElevationRoutes.use('*', authMiddleware);

// Guard: PAM actuator is DISABLED by default. Enable only when JIT credentials
// + agent-side target re-validation (Track 6) are deployed. Same env-flag guard
// STYLE as devPush.ts, but disabled by default in ALL environments (devPush only
// gates production; it is on-by-default in dev).
actuateElevationRoutes.use('*', async (c, next) => {
  if (process.env.PAM_ACTUATOR_ENABLED !== 'true') {
    return c.json({ error: 'PAM actuator is disabled' }, 403);
  }
  return next();
});

/**
 * POST /devices/:id/actuate-elevation
 *
 * PAM Track 5: queue an `actuate_elevation` device_command that the agent
 * picks up as a go signal for the consent.exe prompt that's already up on
 * the user's screen. The agent mints the local dormant-admin credential and
 * passes it to the actuator in-process; the secret never crosses the wire.
 *
 * This is the server-side push half of the actuator. The agent-side
 * implementation lives in `agent/internal/pamactuator/`.
 *
 * Scope: this PR ships only the command-queueing contract. The wider
 * approval flow that decides WHEN to call this — match elevation_requests
 * row against software_policies and fan out to the right agent — is Track 6.
 *
 * Auth: organization+ scope, DEVICES_EXECUTE permission, MFA. Same gates
 * as POST /devices/:id/commands, because functionally that's what this
 * is: a typed wrapper that validates the elevationRequestId go-signal
 * payload before insertion.
 *
 * The command payload carries only the go signal; the credential is minted
 * locally by the agent and never shipped. device_commands is intentionally
 * system-scoped (see CLAUDE.md tenancy notes), but RLS still covers the
 * `devices` row we read on the way in.
 *
 * Single-use enforcement: SELECT + transactional UPDATE-status
 * 'approved' → 'actuating' + INSERT command happen in a single
 * `db.transaction`. The UPDATE only fires when status='approved'; if
 * zero rows are returned, we lost the TOCTOU race and refuse. After a
 * successful actuation the row sits in 'actuating' until the agent
 * reports completion (later track) — it cannot be replayed.
 */

const actuateElevationSchema = z.object({
  elevationRequestId: z.string().uuid(),
  username: z.string().min(1).max(255).optional(),
  password: z.string().min(1).max(1024).optional(),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
});

function canAccessDeviceSite(
  device: { siteId?: string | null },
  userPerms: UserPermissions | undefined,
): boolean {
  if (!userPerms?.allowedSiteIds) return true;
  return typeof device.siteId === 'string' && canAccessSite(userPerms, device.siteId);
}

actuateElevationRoutes.post(
  '/:id/actuate-elevation',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', actuateElevationSchema),
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

    // Transactional single-use enforcement (PR #960 review, blocker 1).
    //
    // The route's "proof of approval" is `elevation_requests.status === 'approved'`. To
    // make that proof one-shot we must transition the row out of 'approved' in the same
    // transaction as the command insert. Otherwise an approved row can be POSTed N
    // times and each call queues a new actuate_elevation command — credential replay /
    // multi-spawn vector.
    //
    // The UPDATE WHERE status='approved' atomic-compare-and-swaps the row to
    // 'actuating'. If zero rows return, either it wasn't approved or we lost the race
    // against a concurrent POST; either way we refuse with 409.
    //
    // Org check (PR #960 review, blocker 3): the WHERE clause includes
    // `orgId = device.orgId` so the FK pair (id, deviceId, orgId) is the primary
    // gate, not a post-query assert.
    //
    // Audit (PR #960 review, blocker 2): every outcome — success, race-lost,
    // wrong-status — must land in `elevation_audit` with the cause. 404/decommission
    // paths above can't write elevation_audit (no valid FK target), so they get only
    // the route-level audit at the outer scope.
    const result = await db.transaction(async (tx) => {
      const [elevation] = await tx
        .select({
          id: elevationRequests.id,
          deviceId: elevationRequests.deviceId,
          orgId: elevationRequests.orgId,
          status: elevationRequests.status,
        })
        .from(elevationRequests)
        .where(
          and(
            eq(elevationRequests.id, data.elevationRequestId),
            eq(elevationRequests.deviceId, deviceId),
            // Blocker 3: org check inside the WHERE clause makes the FK pair the
            // primary gate (Shape-4 from #905). The cross-org "defensive" check below
            // becomes defense-in-depth instead of the only line of defense.
            eq(elevationRequests.orgId, device.orgId),
          ),
        )
        .limit(1);

      if (!elevation) {
        return { kind: 'not_found' as const };
      }

      if (elevation.status !== 'approved') {
        await tx.insert(elevationAudit).values({
          orgId: device.orgId,
          elevationRequestId: elevation.id,
          eventType: 'command_executed',
          actor: 'technician',
          actorUserId: auth.user.id,
          details: {
            deviceId,
            outcome: 'rejected_wrong_status',
            actualStatus: elevation.status,
          },
          occurredAt: new Date(),
        });
        return { kind: 'wrong_status' as const, status: elevation.status };
      }

      // Blocker 1: atomic CAS approved → actuating. If concurrent POSTs race, only
      // one wins; the loser sees rowCount=0 and we 409 with 'race_lost'.
      const updated = await tx
        .update(elevationRequests)
        .set({ status: 'actuating', updatedAt: new Date() })
        .where(
          and(
            eq(elevationRequests.id, elevation.id),
            eq(elevationRequests.status, 'approved'),
          ),
        )
        .returning({ id: elevationRequests.id });

      if (updated.length === 0) {
        await tx.insert(elevationAudit).values({
          orgId: device.orgId,
          elevationRequestId: elevation.id,
          eventType: 'command_executed',
          actor: 'technician',
          actorUserId: auth.user.id,
          details: { deviceId, outcome: 'race_lost' },
          occurredAt: new Date(),
        });
        return { kind: 'race_lost' as const };
      }

      const [command] = await tx
        .insert(deviceCommands)
        .values({
          deviceId,
          type: 'actuate_elevation',
          payload: {
            elevationRequestId: data.elevationRequestId,
            timeoutMs: data.timeoutMs ?? 8000,
          },
          status: 'pending',
          createdBy: auth.user.id,
        })
        .returning();

      if (!command) {
        // Should not happen with .returning(); rolled back by throwing.
        throw new Error('actuate-elevation: device_commands insert returned no row');
      }

      // Blocker 2: elevation_audit insert on the happy path. The password
      // is agent-local and never present here.
      await tx.insert(elevationAudit).values({
        orgId: device.orgId,
        elevationRequestId: elevation.id,
        eventType: 'command_executed',
        actor: 'technician',
        actorUserId: auth.user.id,
        details: {
          deviceId,
          commandId: command.id,
          timeoutMs: data.timeoutMs ?? 8000,
        },
        occurredAt: new Date(),
      });

      return { kind: 'success' as const, command };
    });

    if (result.kind === 'not_found') {
      // Route-level audit only — no elevation_audit because the FK target
      // doesn't exist for this caller's org.
      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'device.elevation.actuate.rejected',
        resourceType: 'device_command',
        resourceId: data.elevationRequestId,
        resourceName: 'actuate_elevation',
        details: { deviceId, outcome: 'elevation_request_not_found' },
      });
      return c.json({ error: 'Elevation request not found for this device' }, 404);
    }

    if (result.kind === 'race_lost') {
      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'device.elevation.actuate.rejected',
        resourceType: 'device_command',
        resourceId: data.elevationRequestId,
        resourceName: 'actuate_elevation',
        details: { deviceId, outcome: 'race_lost' },
      });
      return c.json(
        { error: 'Elevation request already being actuated', code: 'race_lost' },
        409,
      );
    }

    if (result.kind === 'wrong_status') {
      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'device.elevation.actuate.rejected',
        resourceType: 'device_command',
        resourceId: data.elevationRequestId,
        resourceName: 'actuate_elevation',
        details: { deviceId, outcome: 'wrong_status', status: result.status },
      });
      return c.json(
        { error: 'Elevation request is not approved', code: result.status },
        409,
      );
    }

    const command = result.command;

    // Audit log MUST NOT carry the password. The cleartext is minted by the
    // agent only and is never present in this request or command payload.
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.elevation.actuate',
      resourceType: 'device_command',
      resourceId: command.id,
      resourceName: 'actuate_elevation',
      details: {
        deviceId,
        elevationRequestId: data.elevationRequestId,
        timeoutMs: data.timeoutMs ?? 8000,
      },
    });

    return c.json(
      {
        id: command.id,
        deviceId: command.deviceId,
        type: command.type,
        status: command.status,
        elevationRequestId: data.elevationRequestId,
        createdAt: command.createdAt,
      },
      201,
    );
  },
);
