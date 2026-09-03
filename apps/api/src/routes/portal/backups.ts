import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  backupDevicesPage,
  backupOverview,
} from '../../services/portal/backupReadModel';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  isEtagFresh,
} from './helpers';

// Route hub for the customer-portal backups surface, gated by the
// `enableBackups` strict flag (Task 3.3). Mounted at root in
// routes/portal/index.ts under createPortalFeatureGateStrict('enableBackups')
// so a later wave can add absolute `/backups/...` handlers here without a
// second mount.
export const portalBackupRoutes = new Hono();

const pageQuery = z.object({
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
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);
  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }
  return c.json(payload);
}

portalBackupRoutes.get('/backups/overview', async (c) => {
  const auth = c.get('portalAuth');
  return cached(c, await backupOverview(auth.user.orgId, {
    timezone: auth.timezone,
    now: new Date(),
  }));
});

portalBackupRoutes.get(
  '/backups/devices',
  zValidator('query', pageQuery),
  async (c) =>
    cached(
      c,
      await backupDevicesPage(c.get('portalAuth').user.orgId, {
        ...c.req.valid('query'),
        timezone: c.get('portalAuth').timezone,
        now: new Date(),
      }),
    ),
);
