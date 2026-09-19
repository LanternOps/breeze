import { Hono, type Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { deliverableOccurrences, serviceOverview } from '../../services/portal/serviceReadModel';
import { applyPortalCacheHeaders, buildWeakEtag, isEtagFresh } from './helpers';
import { portalDeliverableParamSchema, portalOccurrenceListSchema } from './schemas';

// Route hub for the customer-portal Service scorecard, gated by the
// `enableService` strict flag. Mounted at root in routes/portal/index.ts under
// createPortalFeatureGateStrict('enableService'); handlers own the absolute path.
//
// Spec D10: nothing here returns a ticket. The read model is the only place
// the publication rules live — these handlers add caching and nothing else.
export const portalServiceRoutes = new Hono();

function sendCached(c: Context, payload: unknown) {
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

portalServiceRoutes.get('/service', async (c) => {
  const auth = c.get('portalAuth');
  const payload = await serviceOverview(auth.user.orgId, {
    timezone: auth.timezone,
    now: new Date(),
  });
  return sendCached(c, payload);
});

portalServiceRoutes.get(
  '/service/:deliverableId/occurrences',
  zValidator('param', portalDeliverableParamSchema),
  zValidator('query', portalOccurrenceListSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const payload = await deliverableOccurrences(
      auth.user.orgId,
      c.req.valid('param').deliverableId,
      { timezone: auth.timezone, now: new Date(), limit: c.req.valid('query').limit },
    );
    // Bare 404, never 403: a deliverable of another org and a deliverable that
    // does not exist must be indistinguishable (spec §12).
    if (!payload) return c.json({ error: 'Not found' }, 404);
    return sendCached(c, payload);
  },
);
