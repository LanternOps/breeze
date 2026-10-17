import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { patchDetailDevicePage, patchDetailSummary } from '../../services/portal/patchDetailReadModel';
import { respondWithPortalPrivateCache } from './helpers';

export const portalPatchRoutes = new Hono();
const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const deviceParam = z.object({ deviceId: z.string().uuid() });

portalPatchRoutes.get('/patches/summary', zValidator('query', paginationQuery), async (c) => {
  const auth = c.get('portalAuth');
  return respondWithPortalPrivateCache(c, await patchDetailSummary(auth.user.orgId, {
    ...c.req.valid('query'), now: new Date(),
  }));
});
portalPatchRoutes.get('/patches/devices/:deviceId',
  zValidator('param', deviceParam), zValidator('query', paginationQuery), async (c) => {
    const auth = c.get('portalAuth');
    const result = await patchDetailDevicePage(auth.user.orgId, c.req.valid('param').deviceId, {
      ...c.req.valid('query'), now: new Date(),
    });
    if (!result) return c.json({ error: 'Device not found' }, 404);
    return respondWithPortalPrivateCache(c, result);
  });
