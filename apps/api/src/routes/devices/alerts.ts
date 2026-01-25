import { Hono } from 'hono';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';

export const alertsRoutes = new Hono();

alertsRoutes.use('*', authMiddleware);

// GET /devices/:id/alerts - Get device alerts
alertsRoutes.get(
  '/:id/alerts',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const { status = 'active' } = c.req.query();

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // TODO: Query alerts table when implemented
    return c.json({ data: [] });
  }
);
