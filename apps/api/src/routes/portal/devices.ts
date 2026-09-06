import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { organizations } from '../../db/schema';
import {
  devicesCsvForOrg,
  enrichedDevicesForOrg
} from '../../services/portal/deviceReadModel';
import { safeContentDispositionFilename } from '../../utils/httpHeaders';
import { listSchema } from './schemas';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  getPagination,
  isEtagFresh
} from './helpers';

export const deviceRoutes = new Hono();

deviceRoutes.get('/devices/export.csv', async (c) => {
  const auth = c.get('portalAuth');
  const orgId = auth.user.orgId;
  const [org] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: auth.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  const filename = safeContentDispositionFilename(
    `${org?.slug ?? 'organization'}-devices-${date}.csv`
  );

  const chunks: string[] = [];
  try {
    for await (const chunk of devicesCsvForOrg(orgId, {
      timezone: auth.timezone
    })) {
      chunks.push(chunk);
    }
  } catch (error) {
    console.error('[portal] device CSV export failed', { orgId, error });
    throw error;
  }
  const body = chunks.join('');

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, max-age=30'
    }
  });
});

deviceRoutes.get(
  '/devices',
  zValidator('query', listSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const { page, limit } = getPagination(c.req.valid('query'));
    const payload = await enrichedDevicesForOrg(auth.user.orgId, {
      page,
      limit,
      timezone: auth.timezone
    });

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
  }
);
