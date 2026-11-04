/**
 * WAN circuits and interfaces of a managed device (read only).
 * Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md §8, §9.1
 *
 * GET /devices/:id/circuits
 */

import { Hono } from 'hono';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { respondAssetCircuits } from '../assetCircuitsResponse';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const deviceCircuitsRoutes = new Hono();

deviceCircuitsRoutes.use('*', authMiddleware);

const requireDevicesRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

deviceCircuitsRoutes.get(
  '/:id/circuits',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  async (c) => {
    const auth = c.get('auth');
    const device = await getDeviceWithOrgAndSiteCheck(c, c.req.param('id')!, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    return respondAssetCircuits(c, { kind: 'device', id: device.id, orgId: device.orgId, siteId: device.siteId });
  },
);
