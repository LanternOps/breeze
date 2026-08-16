import { Hono } from 'hono';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getDeviceWithOrgCheck, canAccessDeviceSite } from './helpers';
import { CommandTypes, queueCommandForExecution } from '../../services/commandQueue';
import { writeRouteAudit } from '../../services/auditEvents';
import { commandAuditDetails } from '../../services/commandAudit';
import { homebrewBootstrapPayload } from '../../services/homebrewBootstrap';

export const homebrewBootstrapRoutes = new Hono();

homebrewBootstrapRoutes.use('*', authMiddleware);

// POST /devices/:id/homebrew-bootstrap — install Homebrew itself on a macOS
// endpoint, from a pinned checksum-verified copy of the official installer.
//
// Explicitly opt-in: nothing in the software library ever triggers this
// implicitly. A Homebrew-backed deploy against a device without brew fails as
// `manager_unavailable`, and a tech decides — per device — whether bootstrapping
// a package manager onto that machine is acceptable.
homebrewBootstrapRoutes.post(
  '/:id/homebrew-bootstrap',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

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
    if (device.osType !== 'macos') {
      return c.json(
        { error: `Homebrew is macOS-only; this device runs ${device.osType}` },
        400
      );
    }

    const payload = homebrewBootstrapPayload();

    const queued = await queueCommandForExecution(
      deviceId,
      CommandTypes.HOMEBREW_BOOTSTRAP,
      payload,
      { userId: auth.user.id, preferHeartbeat: false }
    );

    if (!queued.command) {
      return c.json({ error: queued.error || 'Failed to queue homebrew_bootstrap command' }, 503);
    }

    const command = queued.command;
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.homebrew_bootstrap',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        ...commandAuditDetails(command.id, CommandTypes.HOMEBREW_BOOTSTRAP, payload),
        installerUrl: payload.installerUrl,
        installerSha256: payload.installerSha256,
      },
    });

    return c.json({
      success: true,
      commandId: command.id,
      commandStatus: command.status,
      action: 'homebrew_bootstrap',
      installerUrl: payload.installerUrl,
    });
  }
);
