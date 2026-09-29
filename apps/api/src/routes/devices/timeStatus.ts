import { Hono } from 'hono';
import {
  authMiddleware,
  requireScope,
  requirePermission,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { getDeviceTimeStatusView } from '../../services/timeSync/view';
export const timeStatusRoutes = new Hono();
timeStatusRoutes.use('*', authMiddleware);
timeStatusRoutes.get(
  '/:id/time-status',
  requireScope('organization', 'partner', 'system'),
  requirePermission(
    PERMISSIONS.DEVICES_READ.resource,
    PERMISSIONS.DEVICES_READ.action,
  ),
  async (c) => {
    const id = c.req.param('id')!;
    const device = await getDeviceWithOrgAndSiteCheck(c, id, c.get('auth'));
    if (device === SITE_ACCESS_DENIED)
      return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    const view = await getDeviceTimeStatusView(id);
    return view ? c.json(view) : c.json({ error: 'Device not found' }, 404);
  },
);
