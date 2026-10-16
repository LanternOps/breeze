import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  hardwareInventoryDeviceDetail,
  hardwareInventoryDevicesPage,
} from '../../services/portal/hardwareInventoryReadModel';
import { respondWithPortalPrivateCache } from './helpers';

// Route hub for the customer-portal hardware inventory surface (Portal
// Advanced Visibility W02, #7732), gated by the `enableHardwareInventory`
// strict flag. Mounted at root in routes/portal/index.ts under
// createPortalFeatureGateStrict('enableHardwareInventory'). Read-only: the
// organization always comes from the portal session, never from the request.
export const portalHardwareInventoryRoutes = new Hono();

const deviceListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const deviceParam = z.object({
  deviceId: z.string().uuid(),
});

portalHardwareInventoryRoutes.get(
  '/hardware-inventory/devices',
  zValidator('query', deviceListQuery),
  async (c) => {
    const auth = c.get('portalAuth');
    return respondWithPortalPrivateCache(
      c,
      await hardwareInventoryDevicesPage(auth.user.orgId, {
        ...c.req.valid('query'),
        now: new Date(),
      }),
    );
  },
);

portalHardwareInventoryRoutes.get(
  '/hardware-inventory/devices/:deviceId',
  zValidator('param', deviceParam),
  async (c) => {
    const auth = c.get('portalAuth');
    const { deviceId } = c.req.valid('param');
    const detail = await hardwareInventoryDeviceDetail(auth.user.orgId, deviceId, new Date());
    // A device from another organization is indistinguishable from a missing one.
    if (!detail) return c.json({ error: 'Device not found' }, 404);
    return respondWithPortalPrivateCache(c, detail);
  },
);
