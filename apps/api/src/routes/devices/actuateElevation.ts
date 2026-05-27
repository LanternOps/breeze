import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { deviceCommands, devices, elevationRequests } from '../../db/schema';
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

/**
 * POST /devices/:id/actuate-elevation
 *
 * PAM Track 5: queue an `actuate_elevation` device_command that the agent
 * picks up and uses to type the dormant-admin credentials into the
 * consent.exe prompt that's already up on the user's screen.
 *
 * This is the server-side push half of the actuator. The agent-side
 * implementation lives in `agent/internal/pamactuator/`.
 *
 * Scope: this PR ships only the command-queueing contract. The wider
 * approval flow that decides WHEN to call this — match elevation_requests
 * row against software_policies, mint a JIT credential, fan out to the
 * right agent — is Track 6.
 *
 * Auth: organization+ scope, DEVICES_EXECUTE permission, MFA. Same gates
 * as POST /devices/:id/commands, because functionally that's what this
 * is: a typed wrapper that validates the elevationRequestId / credential
 * payload before insertion.
 *
 * The credential is shipped through the command payload exactly once; the
 * agent does not persist it. device_commands is intentionally
 * system-scoped (see CLAUDE.md tenancy notes), but RLS still covers the
 * `devices` row we read on the way in.
 */

const actuateElevationSchema = z.object({
  elevationRequestId: z.string().uuid(),
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
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

    // Verify the elevation request belongs to the same device + the
    // caller's org. Without this gate, a partner-scoped admin could
    // actuate an elevation row whose org they cannot see.
    const [elevation] = await db
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
        ),
      )
      .limit(1);

    if (!elevation) {
      return c.json({ error: 'Elevation request not found for this device' }, 404);
    }
    if (elevation.orgId !== device.orgId) {
      // Defensive: same-device + cross-org would mean the FK pair is
      // wrong. Refuse rather than queue.
      return c.json({ error: 'Elevation request org mismatch' }, 409);
    }
    if (elevation.status !== 'approved') {
      return c.json(
        { error: 'Elevation request is not approved', code: elevation.status },
        409,
      );
    }

    const [command] = await db
      .insert(deviceCommands)
      .values({
        deviceId,
        type: 'actuate_elevation',
        payload: {
          elevationRequestId: data.elevationRequestId,
          username: data.username,
          password: data.password,
          timeoutMs: data.timeoutMs ?? 8000,
        },
        status: 'pending',
        createdBy: auth.user.id,
      })
      .returning();

    if (!command) {
      return c.json({ error: 'Failed to queue command' }, 500);
    }

    // Audit log MUST NOT carry the password. elevationRequestId +
    // username + deviceId is enough to correlate; the cleartext only
    // exists in flight to the agent. (`commandAuditDetails` is not
    // imported here because the default sanitizer would still see the
    // password in the payload via deep-clone.)
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.elevation.actuate',
      resourceType: 'device_command',
      resourceId: command.id,
      resourceName: 'actuate_elevation',
      details: {
        deviceId,
        elevationRequestId: data.elevationRequestId,
        username: data.username,
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
