/**
 * Physical placement of a managed device (room / rack / rack unit / height U).
 * Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md §8.1
 *
 * GET    /devices/:id/placement
 * PUT    /devices/:id/placement   (an all-NULL body removes the row)
 * DELETE /devices/:id/placement
 *
 * The site is the device's live site and is returned, never stored.
 */

import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  deletePlacement,
  placementBodySchema,
  readPlacement,
  savePlacement,
  type PlacementSubject,
} from '../../services/assetPlacement';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const placementRoutes = new Hono();

placementRoutes.use('*', authMiddleware);

const requireDevicesRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireDevicesWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

function subjectOf(device: { id: string; orgId: string; siteId: string }): PlacementSubject {
  return { kind: 'device', id: device.id, orgId: device.orgId, siteId: device.siteId };
}

placementRoutes.get(
  '/:id/placement',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  async (c) => {
    const auth = c.get('auth');
    const device = await getDeviceWithOrgAndSiteCheck(c, c.req.param('id')!, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);

    const subject = subjectOf(device);
    return c.json({
      subject: { kind: subject.kind, id: subject.id, orgId: subject.orgId, siteId: subject.siteId },
      authority: { kind: 'device', id: device.id, linked: false },
      placement: await readPlacement('device', device.id),
    });
  },
);

placementRoutes.put(
  '/:id/placement',
  requireScope('organization', 'partner', 'system'),
  requireDevicesWrite,
  requireMfa(),
  zValidator('json', placementBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const device = await getDeviceWithOrgAndSiteCheck(c, c.req.param('id')!, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);

    const subject = subjectOf(device);
    const before = await readPlacement('device', device.id);
    const placement = await savePlacement(subject, c.req.valid('json'));

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: placement ? 'asset.placement.update' : 'asset.placement.delete',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: { before, after: placement },
    });

    return c.json({
      subject: { kind: subject.kind, id: subject.id, orgId: subject.orgId, siteId: subject.siteId },
      authority: { kind: 'device', id: device.id, linked: false },
      placement,
    });
  },
);

placementRoutes.delete(
  '/:id/placement',
  requireScope('organization', 'partner', 'system'),
  requireDevicesWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const device = await getDeviceWithOrgAndSiteCheck(c, c.req.param('id')!, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);

    const before = await readPlacement('device', device.id);
    await deletePlacement({ kind: 'device', id: device.id });

    if (before) {
      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'asset.placement.delete',
        resourceType: 'device',
        resourceId: device.id,
        resourceName: device.hostname,
        details: { before, after: null },
      });
    }

    return c.json({ success: true });
  },
);
