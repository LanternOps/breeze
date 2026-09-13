import { Hono } from 'hono';
import { setDeviceFunctionSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  DeviceFunctionError,
  clearDeviceFunction,
  getDeviceFunction,
  upsertDeviceFunction,
} from '../../services/deviceFunction';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

/**
 * Device function (Fleet Designer W02, #5652): `GET/PUT /devices/:id/function`.
 *
 * The device page's Function field reads the projection off the device DTO
 * (`devices.device_function` / `device_function_source`) and the assessment
 * detail (confidence, evidence) from the GET here. A PUT writes a `manual`
 * assessment through `services/deviceFunction.ts` — the only writer — which
 * supersedes whatever is active and rewrites the projection in the same
 * transaction; `functionKey: null` clears it. Manual rows are never
 * superseded by the designer's `ai` rows.
 *
 * Session auth only (mirrors `PATCH /devices/:id`: `devices:write` + MFA on
 * the write, `devices:read` on the read); both routes go through
 * `getDeviceWithOrgAndSiteCheck` so a site-restricted technician cannot read
 * or relabel a device outside their sites.
 */
export const functionRoutes = new Hono();

functionRoutes.use('*', authMiddleware);

functionRoutes.get(
  '/:id/function',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const device = await getDeviceWithOrgAndSiteCheck(c, c.req.param('id')!, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    return c.json(await getDeviceFunction(device.id, device.orgId));
  },
);

functionRoutes.put(
  '/:id/function',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', setDeviceFunctionSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const device = await getDeviceWithOrgAndSiteCheck(c, c.req.param('id')!, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);

    let outcome: string;
    try {
      if (body.functionKey === null) {
        const cleared = await clearDeviceFunction({ deviceId: device.id, orgId: device.orgId, userId: auth.user.id });
        outcome = cleared.outcome;
      } else {
        const written = await upsertDeviceFunction({
          deviceId: device.id,
          orgId: device.orgId,
          functionKey: body.functionKey,
          label: body.label,
          source: 'manual',
          userId: auth.user.id,
        });
        outcome = written.outcome;
      }
    } catch (err) {
      if (err instanceof DeviceFunctionError) {
        // The access check above and the service's FOR UPDATE lock are separate
        // statements; a device deleted or moved in between is a 404, not a 400.
        return c.json({ error: err.code }, err.code === 'device_not_found' ? 404 : 400);
      }
      throw err;
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.function.set',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname ?? device.displayName ?? undefined,
      details: { functionKey: body.functionKey, outcome },
    });

    return c.json(await getDeviceFunction(device.id, device.orgId));
  },
);
