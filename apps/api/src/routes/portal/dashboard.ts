import { Hono } from 'hono';
import { dashboardForOrg } from '../../services/portal/dashboard';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  isEtagFresh,
} from './helpers';

// Route hub for the customer-portal dashboard surface, gated by the
// `enableDashboard` strict flag (Task 3.3). Mounted at root in
// routes/portal/index.ts under createPortalFeatureGateStrict('enableDashboard')
// so a later wave can add absolute `/dashboard/...` handlers here without a
// second mount.
export const portalDashboardRoutes = new Hono();

portalDashboardRoutes.get('/dashboard', async (c) => {
  const auth = c.get('portalAuth');
  const payload = await dashboardForOrg(auth.user.orgId, {
    timezone: auth.timezone,
    now: new Date(),
  });

  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 0,
    vary: ['Authorization', 'Cookie'],
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);

  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }

  return c.json(payload);
});
