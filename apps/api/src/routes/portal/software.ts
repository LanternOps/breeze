import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { softwareInventoryDevicePage, softwareInventorySummary } from '../../services/portal/softwareInventoryReadModel';
import { respondWithPortalPrivateCache } from './helpers';

export const portalSoftwareRoutes = new Hono();
const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const deviceParam = z.object({ deviceId: z.string().uuid() });

portalSoftwareRoutes.get('/software/summary', zValidator('query', paginationQuery), async (c) => {
  const auth = c.get('portalAuth');
  return respondWithPortalPrivateCache(c, await softwareInventorySummary(auth.user.orgId, {
    ...c.req.valid('query'), now: new Date(),
  }));
});
portalSoftwareRoutes.get('/software/devices/:deviceId',
  zValidator('param', deviceParam), zValidator('query', paginationQuery), async (c) => {
    const auth = c.get('portalAuth');
    const result = await softwareInventoryDevicePage(auth.user.orgId, c.req.valid('param').deviceId, {
      ...c.req.valid('query'), now: new Date(),
    });
    if (!result) return c.json({ error: 'Device not found' }, 404);
    return respondWithPortalPrivateCache(c, result);
  });
