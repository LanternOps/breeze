import { Hono } from 'hono';
import type { PortalHourBlockResponse } from '@breeze/shared';
import { portalHourBlockForOrg } from '../../services/portal/hourBlock';
import { applyPortalCacheHeaders, buildWeakEtag, isEtagFresh } from './helpers';

export const portalHourBlockRoutes = new Hono();

/**
 * Customer-safe block-hours balance (block hours W04).
 *
 * Auth and both gates (enableSupportUsage, then enableHourBlock) are applied
 * at the hub (routes/portal/index.ts) on `/support-usage/*`. The org is the
 * SESSION's, and only the session's: nothing in the query, headers or body
 * can name another one.
 */
portalHourBlockRoutes.get('/support-usage/hour-block', async (c) => {
  const auth = c.get('portalAuth');
  const payload: PortalHourBlockResponse = await portalHourBlockForOrg({ orgId: auth.user.orgId });

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
