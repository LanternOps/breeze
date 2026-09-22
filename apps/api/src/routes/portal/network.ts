import type { NetworkOverviewDto, NetworkAssetsDto } from '@breeze/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { portalBranding } from '../../db/schema';
import { networkAssets, networkOverview } from '../../services/portal/networkVisibilityReadModel';
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

function portalOrgContext(
  orgId: string,
  currentPartnerId: string | null,
): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

function cached(
  c: Parameters<typeof applyPortalCacheHeaders>[0],
  payload: NetworkOverviewDto | NetworkAssetsDto,
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

  const orgId = auth.user.orgId;
  const partnerId = auth.partnerId;

  // Normal authenticated portal requests reach this route only after
  // portalAuthMiddleware resolves the active organization and its owning
  // partner. Keep a defensive guard for synthetic/legacy contexts.
  if (!partnerId) {
    return c.json({ error: 'Organization is not available' }, 403);
  }

  // This route is self-managed, so portal auth does not hold an outer request
  // transaction. Use one organization-scoped context for the entire DB read.
  // currentPartnerId enables SELECT-only partner-wide network_monitors access;
  // accessiblePartnerIds remains empty, preserving partner-axis write denial.
  return withDbAccessContext(
    portalOrgContext(orgId, partnerId),
    async () => {
      const [settings] = await db
        .select({
          enableNetworkVisibility: portalBranding.enableNetworkVisibility,
        })
        .from(portalBranding)
        .where(eq(portalBranding.orgId, orgId))
        .limit(1);

      if (settings?.enableNetworkVisibility !== true) {
        return cached(c, NOT_ENABLED);
      }

      return cached(c, await networkOverview(orgId));
    },
  );
});

const NOT_ENABLED_ASSETS: NetworkAssetsDto = {
  dataStatus: 'not_enabled',
  data: [],
  pagination: { page: 1, limit: 0, total: 0 },
};

portalNetworkRoutes.get('/network/assets', async (c) => {
  const auth = c.get('portalAuth');

  if (!auth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const orgId = auth.user.orgId;
  const partnerId = auth.partnerId;

  if (!partnerId) {
    return c.json({ error: 'Organization is not available' }, 403);
  }

  const query = c.req.query();
  const status = query.status === 'online' || query.status === 'offline' ? query.status : undefined;

  return withDbAccessContext(
    portalOrgContext(orgId, partnerId),
    async () => {
      const [settings] = await db
        .select({
          enableNetworkVisibility: portalBranding.enableNetworkVisibility,
        })
        .from(portalBranding)
        .where(eq(portalBranding.orgId, orgId))
        .limit(1);

      if (settings?.enableNetworkVisibility !== true) {
        return cached(c, NOT_ENABLED_ASSETS);
      }

      const result = await networkAssets(orgId, {
        siteId: query.siteId,
        assetType: query.assetType,
        status,
        page: query.page ? Number.parseInt(query.page, 10) : undefined,
        limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
      });

      return cached(c, result);
    },
  );
});
