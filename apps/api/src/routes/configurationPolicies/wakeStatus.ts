import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import type { AuthContext } from '../../middleware/auth';
import { requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { getConfigPolicy } from '../../services/configurationPolicy';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { WAKE_PANEL_STATES, allowWakeAgain, listWakeStatusForPolicy } from '../../services/wakeStatusPanel';

// Wake-on-LAN status panel for a policy's WOL tab (#10838 W02). Test wake
// deliberately has no route here: it reuses POST /devices/:id/commands
// { type: 'wake', payload: { testWake: true } }, one authorization path.
export const wakeStatusRoutes = new Hono();

const requireDevicesRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireDevicesExecute = requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action);

const policyParamSchema = z.object({ id: z.string().guid() });
const policyDeviceParamSchema = z.object({ id: z.string().guid(), deviceId: z.string().guid() });
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  state: z.enum(WAKE_PANEL_STATES).optional(),
});

wakeStatusRoutes.get(
  '/:id/wake-status',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  zValidator('param', policyParamSchema),
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const { id } = c.req.valid('param');
    const { page, limit, state } = c.req.valid('query');

    const policy = await getConfigPolicy(id, auth, { access: 'read' });
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    const result = await listWakeStatusForPolicy({
      policyId: id,
      allowedSiteIds: permissions?.allowedSiteIds,
      page,
      limit,
      state,
    });
    return c.json(result);
  },
);

wakeStatusRoutes.post(
  '/:id/wake-status/:deviceId/allow',
  requireScope('organization', 'partner', 'system'),
  requireDevicesExecute,
  zValidator('param', policyDeviceParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const { id, deviceId } = c.req.valid('param');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    const device = await allowWakeAgain({ policyId: id, deviceId, allowedSiteIds: permissions?.allowedSiteIds });
    if (!device) return c.json({ error: 'Device not found for this policy' }, 404);

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.wake_on_lan.allow_again',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: { policyId: id },
    });
    return c.json({ ok: true });
  },
);
