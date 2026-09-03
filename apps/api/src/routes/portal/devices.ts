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

  const iterator = devicesCsvForOrg(orgId, {
    timezone: auth.timezone,
    now: new Date()
  })[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await iterator.return?.();
    }
  });

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
      timezone: auth.timezone,
      now: new Date()
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
