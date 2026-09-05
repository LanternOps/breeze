import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  securityDevicesPage,
  securityOverview,
} from '../../services/portal/securityReadModel';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  isEtagFresh,
} from './helpers';

// Route hub for the customer-portal security surface, gated by the
// `enableSecurity` strict flag (Task 3.3). Mounted at root in
// routes/portal/index.ts under createPortalFeatureGateStrict('enableSecurity')
// so a later wave can add absolute `/security/...` handlers here without a
// second mount.
export const portalSecurityRoutes = new Hono();

const overviewQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

const deviceQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function cached(c: Parameters<typeof applyPortalCacheHeaders>[0], payload: unknown) {
  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 0,
    vary: ['Authorization', 'Cookie'],
  });
  const etagPayload = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), asOf: undefined }
    : payload;
  const etag = buildWeakEtag(etagPayload);
  c.header('ETag', etag);
  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }
  return c.json(payload);
}

portalSecurityRoutes.get(
  '/security/overview',
  zValidator('query', overviewQuery),
  async (c) => {
    const auth = c.get('portalAuth');
    return cached(
      c,
      await securityOverview(auth.user.orgId, {
        ...c.req.valid('query'),
        timezone: auth.timezone,
        now: new Date(),
      }),
    );
  },
);

portalSecurityRoutes.get(
  '/security/devices',
  zValidator('query', deviceQuery),
  async (c) => {
    const auth = c.get('portalAuth');
    return cached(
      c,
      await securityDevicesPage(auth.user.orgId, {
        ...c.req.valid('query'),
        timezone: auth.timezone,
        now: new Date(),
      }),
    );
  },
);
