import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  hardwareHealthDeviceDetail,
  hardwareHealthDevicesPage,
  hardwareHealthOverview,
} from '../../services/portal/hardwareHealthReadModel';
import { respondWithPortalPrivateCache } from './helpers';

// Route hub for the customer-portal hardware health surface (Portal Advanced
// Visibility W01, #7731), gated by the `enableHardwareHealth` strict flag.
// Mounted at root in routes/portal/index.ts under
// createPortalFeatureGateStrict('enableHardwareHealth'). Read-only: the
// organization always comes from the portal session, never from the request.
export const portalHardwareHealthRoutes = new Hono();

const deviceListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const deviceParam = z.object({
  deviceId: z.string().uuid(),
});

portalHardwareHealthRoutes.get('/hardware-health/overview', async (c) => {
  const auth = c.get('portalAuth');
  return respondWithPortalPrivateCache(c, await hardwareHealthOverview(auth.user.orgId, new Date()));
});

portalHardwareHealthRoutes.get(
  '/hardware-health/devices',
  zValidator('query', deviceListQuery),
  async (c) => {
    const auth = c.get('portalAuth');
    return respondWithPortalPrivateCache(
      c,
      await hardwareHealthDevicesPage(auth.user.orgId, {
        ...c.req.valid('query'),
        now: new Date(),
      }),
    );
  },
);

portalHardwareHealthRoutes.get(
  '/hardware-health/devices/:deviceId',
  zValidator('param', deviceParam),
  async (c) => {
    const auth = c.get('portalAuth');
    const { deviceId } = c.req.valid('param');
    const detail = await hardwareHealthDeviceDetail(auth.user.orgId, deviceId, new Date());
    // A device from another organization is indistinguishable from a missing one.
    if (!detail) return c.json({ error: 'Device not found' }, 404);
    return respondWithPortalPrivateCache(c, detail);
  },
);
