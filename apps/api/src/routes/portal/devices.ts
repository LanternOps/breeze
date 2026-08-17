import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { listSchema } from './schemas';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  getPagination,
  isEtagFresh
} from './helpers';

export const deviceRoutes = new Hono();

deviceRoutes.get('/devices', zValidator('query', listSchema), async (c) => {
  const auth = c.get('portalAuth');
  const query = c.req.valid('query');
  const { page, limit, offset } = getPagination(query);

  // Belt-and-braces: a portal user's org is never the hidden 'quick_support'
  // org, but this is the most customer-facing surface in the product — never
  // show an ephemeral support device here.
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(devices)
    .where(and(eq(devices.orgId, auth.user.orgId), eq(devices.isEphemeral, false)));
  const count = countResult[0]?.count ?? 0;

  const data = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      osVersion: devices.osVersion,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .where(and(eq(devices.orgId, auth.user.orgId), eq(devices.isEphemeral, false)))
    .orderBy(desc(devices.lastSeenAt), desc(devices.id))
    .limit(limit)
    .offset(offset);

  const payload = {
    data,
    pagination: { page, limit, total: Number(count ?? 0) }
  };

  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 15,
    staleWhileRevalidateSeconds: 90,
    vary: ['Authorization', 'Cookie']
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);

  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }

  return c.json(payload);
});
