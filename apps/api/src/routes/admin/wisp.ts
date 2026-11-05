import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { wispEnabled } from '../../config/env';
import { buildWispOverview, listGrantsForPartner } from '../../services/wisp/adminOverview';

/**
 * Wisp W07 Task 9 (#10141): the platform-admin Wisp overview behind
 * /admin/wisp (web WispAdminPage.tsx).
 *
 * Platform-admin only (adminRoutes mounts platformAdminMiddleware on '*').
 * Read-only and cross-tenant by design — counts and grant metadata, never
 * ceilings, transcripts or concern evidence — so no MFA, and every read runs
 * in a fresh system context exactly like routes/admin/aiToolUsage.ts.
 *
 * Dark while !wispEnabled(), read per request. The 404 body is
 * `{ error: 'wisp_disabled' }` so the page can tell "flag off" apart from a
 * missing route or any other 404 (#10141 rendered a route 404 as "not enabled").
 */
export const wispAdminRoutes = new Hono();

wispAdminRoutes.use('*', async (c, next) => {
  if (!wispEnabled()) return c.json({ error: 'wisp_disabled' }, 404);
  await next();
});

wispAdminRoutes.get('/overview', async (c) => {
  const partners = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => buildWispOverview(), 'wispAdminOverview'));
  return c.json({ partners });
});

wispAdminRoutes.get(
  '/grants',
  zValidator('query', z.object({ partnerId: z.string().uuid() })),
  async (c) => {
    const { partnerId } = c.req.valid('query');
    const grants = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => listGrantsForPartner(partnerId), 'wispAdminGrants'));
    return c.json({ grants });
  },
);
