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

function withoutCollectionTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutCollectionTimestamps);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'asOf')
        .map(([key, nested]) => [key, withoutCollectionTimestamps(nested)]),
    );
  }
  return value;
}

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
  // Collection timestamps are refreshed on every request even when the
  // underlying values are unchanged. Excluding every `asOf` field keeps the
  // validator useful while data timestamps such as capturedAt/completedAt
  // still invalidate it when the source data changes.
  const etag = buildWeakEtag(withoutCollectionTimestamps(payload));
  c.header('ETag', etag);

  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }

  return c.json(payload);
});
