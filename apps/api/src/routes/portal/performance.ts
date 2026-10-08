import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  PORTAL_PERFORMANCE_RANGES,
  performanceDeviceSeries,
  performanceOverview,
} from '../../services/portal/performanceReadModel';
import { respondWithPortalPrivateCache } from './helpers';

export const portalPerformanceRoutes = new Hono();

const rangeQuery = z.object({
  range: z.enum(PORTAL_PERFORMANCE_RANGES).default('24h'),
});

const deviceParam = z.object({
  deviceId: z.string().uuid(),
});

portalPerformanceRoutes.get(
  '/performance/overview',
  zValidator('query', rangeQuery),
  async (c) => {
    const auth = c.get('portalAuth');
    const { range } = c.req.valid('query');
    return respondWithPortalPrivateCache(c, await performanceOverview(auth.user.orgId, range, new Date()));
  },
);

portalPerformanceRoutes.get(
  '/performance/devices/:deviceId',
  zValidator('param', deviceParam),
  zValidator('query', rangeQuery),
  async (c) => {
    const auth = c.get('portalAuth');
    const { deviceId } = c.req.valid('param');
    const { range } = c.req.valid('query');
    const result = await performanceDeviceSeries(auth.user.orgId, deviceId, range, new Date());
    if (!result) return c.json({ error: 'Device not found' }, 404);
    return respondWithPortalPrivateCache(c, result);
  },
);
