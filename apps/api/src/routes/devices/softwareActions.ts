import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../../middleware/auth';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getDeviceWithOrgCheck } from './helpers';
import { CommandTypes, queueCommandForExecution } from '../../services/commandQueue';
import { writeRouteAudit } from '../../services/auditEvents';
import { commandAuditDetails } from '../../services/commandAudit';

export const softwareActionsRoutes = new Hono();

softwareActionsRoutes.use('*', authMiddleware);

function canAccessDeviceSite(
  device: { siteId?: string | null },
  userPerms: UserPermissions | undefined
): boolean {
  if (!userPerms?.allowedSiteIds) return true;
  return typeof device.siteId === 'string' && canAccessSite(userPerms, device.siteId);
}

// Same name/version constraints as the agent's validateSoftwareName /
// validateSoftwareVersion. Keeping these synchronized prevents a request
// that the API would accept from coming back as a generic validator error
// from the agent.
const SOFTWARE_NAME_UNSAFE = /[\\/\x00\r\n']/;
const SHELL_META = /[;&|><`$'"]/;

const softwareActionPayloadSchema = z
  .object({
    name: z
      .string()
      .min(1, 'name is required')
      .max(200, 'name exceeds 200 characters')
      .refine((v) => !v.startsWith('-'), { message: 'name must not start with "-"' })
      .refine((v) => !v.includes('..'), { message: 'name contains invalid traversal sequence' })
      .refine(
        (v) => !SOFTWARE_NAME_UNSAFE.test(v) && !SHELL_META.test(v),
        { message: 'name contains unsafe characters' }
      ),
    version: z
      .string()
      .max(100, 'version exceeds 100 characters')
      .refine((v) => v === '' || !v.startsWith('-'), { message: 'version must not start with "-"' })
      .refine((v) => !v.includes('..'), { message: 'version contains invalid traversal sequence' })
      .refine(
        (v) => !SOFTWARE_NAME_UNSAFE.test(v) && !SHELL_META.test(v),
        { message: 'version contains unsafe characters' }
      )
      .optional(),
    // Optional winget package identifier (e.g. "Mozilla.Firefox"). When the
    // Software tab has correlated the row to an available third-party update it
    // sends the winget Id so the agent can upgrade by `--id` (reliable) instead
    // of guessing from the display name. Matches the agent's validWingetPkgID.
    packageId: z
      .string()
      .max(256, 'packageId exceeds 256 characters')
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, { message: 'packageId contains invalid characters' })
      .optional(),
  })
  .strict();

// POST /devices/:id/software/update — queue a software upgrade for the named package
softwareActionsRoutes.post(
  '/:id/software/update',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', softwareActionPayloadSchema),
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
    // Version pinning is only honored by the agent's Windows update path
    // (winget --version). updateSoftwareMacOS/updateSoftwareLinux ignore the
    // version and always upgrade to the latest, so accepting a pin here would
    // silently violate the intended hold. Reject it up front instead. See #993.
    if (data.version && device.osType !== 'windows') {
      return c.json(
        {
          error: `Version pinning is only supported on Windows endpoints; this device runs ${device.osType}. Resubmit without a version to upgrade to the latest available.`,
        },
        422
      );
    }

    const payload: Record<string, unknown> = { name: data.name, source: 'device_software_tab' };
    if (data.version) payload.version = data.version;
    if (data.packageId) payload.packageId = data.packageId;

    const queued = await queueCommandForExecution(deviceId, CommandTypes.SOFTWARE_UPDATE, payload, {
      userId: auth.user.id,
      preferHeartbeat: false,
    });

    if (!queued.command) {
      return c.json({ error: queued.error || 'Failed to queue software_update command' }, 503);
    }

    const command = queued.command;
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.software.update.queue',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        ...commandAuditDetails(command.id, CommandTypes.SOFTWARE_UPDATE, payload),
        softwareName: data.name,
        softwareVersion: data.version ?? null,
      },
    });

    return c.json({
      success: true,
      commandId: command.id,
      commandStatus: command.status,
      name: data.name,
      version: data.version ?? null,
      action: 'update',
    });
  }
);

// POST /devices/:id/software/uninstall — queue a software uninstall for the named package
softwareActionsRoutes.post(
  '/:id/software/uninstall',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', softwareActionPayloadSchema),
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

    const payload: Record<string, unknown> = { name: data.name, source: 'device_software_tab' };
    if (data.version) payload.version = data.version;

    const queued = await queueCommandForExecution(deviceId, CommandTypes.SOFTWARE_UNINSTALL, payload, {
      userId: auth.user.id,
      preferHeartbeat: false,
    });

    if (!queued.command) {
      return c.json({ error: queued.error || 'Failed to queue software_uninstall command' }, 503);
    }

    const command = queued.command;
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.software.uninstall.queue',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        ...commandAuditDetails(command.id, CommandTypes.SOFTWARE_UNINSTALL, payload),
        softwareName: data.name,
        softwareVersion: data.version ?? null,
      },
    });

    return c.json({
      success: true,
      commandId: command.id,
      commandStatus: command.status,
      name: data.name,
      version: data.version ?? null,
      action: 'uninstall',
    });
  }
);
