import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { startNetworkIsolationSchema, releaseNetworkIsolationSchema, extendNetworkIsolationSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireInteractiveSession, requireScope, requirePermission, requireMfa, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { getDeviceWithOrgCheck, canAccessDeviceSite } from './helpers';
import { startNetworkIsolation, releaseNetworkIsolation, extendNetworkIsolation, acknowledgeNetworkIsolation, getBreakGlassCodes, listDeviceIsolations, type IsolationRefusalCode } from '../../services/networkIsolation/service';

export const networkIsolationRoutes = new Hono();
networkIsolationRoutes.use('*', authMiddleware);
const params = z.object({ id: z.uuid(), isolationId: z.uuid().optional() });
async function deviceFor(c: Context) {
  const device = await getDeviceWithOrgCheck(c.req.param('id')!, c.get('auth') as AuthContext);
  if (!device) { noteRefusal(c, 'device_not_found'); return { response: c.json({ error: 'Device not found' }, 404) }; }
  if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) { noteRefusal(c, 'site_forbidden', device.orgId); return { response: c.json({ error: 'Access to this site denied' }, 403) }; }
  return { device };
}
const REFUSAL_STATUS: Record<IsolationRefusalCode, 400 | 403 | 404 | 409 | 503> = {
  feature_disabled: 409, partner_not_enabled: 409, agent_below_gate: 409, agent_not_ready: 409,
  device_lifecycle: 409, unsupported_platform: 409, trust_restricted: 403,
  isolation_already_active: 409, isolation_unacknowledged: 409, incident_mismatch: 409,
  site_forbidden: 403, device_not_found: 404, isolation_not_found: 404, relay_unavailable: 400,
  invalid_allowlist: 400, isolation_conflict: 409, isolation_secret_unavailable: 503, approval_mismatch: 409,
  device_offline: 409, device_decommissioned: 409, device_pending_assignment: 409, backup_helper_update_required: 409,
};
function noteRefusal(c: Context, code: IsolationRefusalCode, orgId?: string) {
  const deviceId = c.req.param('id');
  console.info('[isolation] route refused', { deviceId, code });
  writeRouteAudit(c, { orgId, action: 'device.isolation.refused', resourceType: 'device', resourceId: deviceId, details: { code } });
}
function response(c: Context, result: object, created = false) {
  if ('error' in result) {
    const code = result.error as IsolationRefusalCode;
    return c.json({ error: code, code, ...('networkIsolationUnsupportedReason' in result ? { networkIsolationUnsupportedReason: result.networkIsolationUnsupportedReason } : {}) }, REFUSAL_STATUS[code]);
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
