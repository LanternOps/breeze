import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { startNetworkIsolationSchema, releaseNetworkIsolationSchema, extendNetworkIsolationSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireInteractiveSession, requireScope, requirePermission, requireMfa, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { getDeviceWithOrgCheck, canAccessDeviceSite } from './helpers';
import { startNetworkIsolation, releaseNetworkIsolation, extendNetworkIsolation, acknowledgeNetworkIsolation, getBreakGlassCodes, listDeviceIsolations } from '../../services/networkIsolation/service';

export const networkIsolationRoutes = new Hono();
networkIsolationRoutes.use('*', authMiddleware);
const params = z.object({ id: z.uuid(), isolationId: z.uuid().optional() });
async function deviceFor(c: Context) {
  const device = await getDeviceWithOrgCheck(c.req.param('id')!, c.get('auth') as AuthContext);
  if (!device) return { response: c.json({ error: 'Device not found' }, 404) };
  if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) return { response: c.json({ error: 'Access to this site denied' }, 403) };
  return { device };
}
function response(c: Context, result: object, created = false) {
  if ('error' in result) {
    const code = String(result.error);
    const status = code.endsWith('_not_found') ? 404 : ['site_forbidden', 'trust_restricted'].includes(code) ? 403 : ['invalid_allowlist', 'relay_unavailable'].includes(code) ? 400 : 409;
    return c.json({ error: code, code }, status);
  }
  return c.json(result, created ? 201 : 200);
}

networkIsolationRoutes.post(
  '/:id/network-isolation',
  requireInteractiveSession(),
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', params),
  zValidator('json', startNetworkIsolationSchema),
  async c => {
    const found = await deviceFor(c);
    if ('response' in found) return found.response;
    const { device } = found;
    const auth = c.get('auth') as AuthContext;
    const result = await startNetworkIsolation(auth, device.id, c.req.valid('json'), { requestedByKind: 'user' });
    if (!('error' in result)) writeRouteAudit(c, { orgId: device.orgId, action: 'device.isolation.request', resourceType: 'device', resourceId: device.id, details: { isolationId: 'episode' in result ? result.episode.id : c.req.param('isolationId') } });
    return response(c, result, true);
  },
);

networkIsolationRoutes.post(
  '/:id/network-isolation/:isolationId/release',
  requireInteractiveSession(),
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', params),
  zValidator('json', releaseNetworkIsolationSchema),
  async c => {
    const found = await deviceFor(c);
    if ('response' in found) return found.response;
    const { device } = found;
    const auth = c.get('auth') as AuthContext;
    const result = await releaseNetworkIsolation(auth, device.id, c.req.param('isolationId')!, c.req.valid('json'), { kind: 'console' });
    if (!('error' in result)) writeRouteAudit(c, { orgId: device.orgId, action: 'device.isolation.release', resourceType: 'device', resourceId: device.id, details: { isolationId: 'episode' in result ? result.episode.id : c.req.param('isolationId') } });
    return response(c, result, false);
  },
);

networkIsolationRoutes.post(
  '/:id/network-isolation/:isolationId/extend',
  requireInteractiveSession(),
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', params),
  zValidator('json', extendNetworkIsolationSchema),
  async c => {
    const found = await deviceFor(c);
    if ('response' in found) return found.response;
    const { device } = found;
    const auth = c.get('auth') as AuthContext;
    const result = await extendNetworkIsolation(auth, device.id, c.req.param('isolationId')!, c.req.valid('json').ttlHours);
    if (!('error' in result)) writeRouteAudit(c, { orgId: device.orgId, action: 'device.isolation.extend', resourceType: 'device', resourceId: device.id, details: { isolationId: 'episode' in result ? result.episode.id : c.req.param('isolationId') } });
    return response(c, result, false);
  },
);

networkIsolationRoutes.post(
  '/:id/network-isolation/:isolationId/acknowledge',
  requireInteractiveSession(),
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', params),
  async c => {
    const found = await deviceFor(c);
    if ('response' in found) return found.response;
    const { device } = found;
    const auth = c.get('auth') as AuthContext;
    const result = await acknowledgeNetworkIsolation(auth, device.id, c.req.param('isolationId')!);
    return response(c, result, false);
  },
);

networkIsolationRoutes.get(
  '/:id/network-isolation/:isolationId/break-glass-code',
  requireInteractiveSession(),
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', params),
  async c => {
    const found = await deviceFor(c);
    if ('response' in found) return found.response;
    const { device } = found;
    const auth = c.get('auth') as AuthContext;
    const result = await getBreakGlassCodes(auth, device.id, c.req.param('isolationId')!, c);
    return response(c, result, false);
  },
);

networkIsolationRoutes.get(
  '/:id/network-isolation',
  requireInteractiveSession(),
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', params),
  async c => {
    const found = await deviceFor(c);
    if ('response' in found) return found.response;
    const { device } = found;
    const auth = c.get('auth') as AuthContext;
    const result = await listDeviceIsolations(auth, device.id);
    return response(c, result, false);
  },
);
