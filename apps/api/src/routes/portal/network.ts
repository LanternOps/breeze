import type { NetworkOverviewDto } from '@breeze/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../../db';
import { portalBranding } from '../../db/schema';
import { networkOverview } from '../../services/portal/networkVisibilityReadModel';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  isEtagFresh,
} from './helpers';

export const portalNetworkRoutes = new Hono();

const NOT_ENABLED: NetworkOverviewDto = {
  dataStatus: 'not_enabled',
  totalAssets: null,
  onlineAssets: null,
  offlineAssets: null,
  snmpDevicesPolling: null,
  monitorsDown: null,
};

function cached(
  c: Parameters<typeof applyPortalCacheHeaders>[0],
  payload: NetworkOverviewDto,
) {
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
}

/**
 * Customer-safe Network Visibility overview (#5861).
 *
 * Authentication is applied at the portal route hub. Availability is checked
 * here rather than through createPortalFeatureGateStrict because the approved
 * DTO contract represents a disabled feature as `dataStatus: 'not_enabled'`.
 *
 * Missing portal_branding and explicit false both fail closed.
 */
portalNetworkRoutes.get('/network/overview', async (c) => {
  const auth = c.get('portalAuth');

  if (!auth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const [settings] = await db
    .select({
      enableNetworkVisibility: portalBranding.enableNetworkVisibility,
    })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, auth.user.orgId))
    .limit(1);

  if (settings?.enableNetworkVisibility !== true) {
    return cached(c, NOT_ENABLED);
  }

  return cached(c, await networkOverview(auth.user.orgId));
});
