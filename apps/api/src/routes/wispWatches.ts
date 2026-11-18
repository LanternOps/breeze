/**
 * Wisp W05a — watch routes (Wisp design §7.2; w00 "Routes (final names)",
 * A1). Mounted by W02's hub as `wispRoutes.route('/watches', …)`, i.e.
 * /api/v1/wisp/watches.
 *
 *   GET    /?grantId                                         → { watches: Watch[] }
 *   POST   /  { grantId, orgId, kind, params, cadenceMinutes } → 201 { watch }
 *   DELETE /:id?grantId                                      → 204
 *
 * GATES are inherited from the hub's `use('*')` chain (see wispConcerns.ts);
 * this router must only ever be mounted under `wispRoutes`.
 *
 * A watch is "a standing check a user asked for": create and delete require
 * the caller to OWN the grant; the list also admits a partner-wide admin
 * (w00 A1). Grant access, ceiling resolution and the grant error shapes are
 * shared with the concern routes (`grantCeilingFor`). `createWatch` checks the
 * org against the ceiling before writing; an org outside it is a
 * non-enumerating 404. `deleteWatch` is keyed on the grant, so another grant's
 * watch reads as absent.
 */
import { Hono } from 'hono';
import { concernGrantQuerySchema, createWatchBodySchema } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { writeRouteAudit } from '../services/auditEvents';
import { createWatch, deleteWatch, listWatches, WatchLimitReachedError, type Watch } from '../services/wisp/watches';
import { grantCeilingFor, grantErrorResponse, pathId, wispFail, WISP_NOT_FOUND } from './wispConcerns';

export const wispWatchesRoutes = new Hono();

wispWatchesRoutes.get('/', zValidator('query', concernGrantQuerySchema), async (c) => {
  const access = await grantCeilingFor(c, c.req.valid('query').grantId, 'reader');
  if (!access.ok) return access.response;
  return c.json({ watches: await listWatches(access.ceiling) });
});

wispWatchesRoutes.post('/', zValidator('json', createWatchBodySchema), async (c) => {
  const { grantId, orgId, kind, params, cadenceMinutes } = c.req.valid('json');
  const access = await grantCeilingFor(c, grantId, 'owner');
  if (!access.ok) return access.response;

  let watch: Watch;
  try {
    watch = await createWatch(access.ceiling, { orgId, kind, params, cadenceMinutes });
  } catch (err) {
    if (err instanceof WatchLimitReachedError) {
      return wispFail(c, 409, 'watch_limit_reached', 'This Wisp delegation already holds the maximum number of active watches');
    }
    return grantErrorResponse(c, err);
  }

  writeRouteAudit(c, {
    orgId: watch.orgId,
    partnerId: watch.partnerId,
    action: 'wisp.watch.created',
    resourceType: 'wisp_watch',
    resourceId: watch.id,
    // No params: they are user text and may carry customer detail.
    details: { grantId: watch.grantId, kind: watch.kind, cadenceMinutes: watch.cadenceMinutes },
  });
  return c.json({ watch }, 201);
});

wispWatchesRoutes.delete('/:id', zValidator('query', concernGrantQuerySchema), async (c) => {
  const id = pathId(c);
  if (!id) return c.json(WISP_NOT_FOUND, 404);
  const access = await grantCeilingFor(c, c.req.valid('query').grantId, 'owner');
  if (!access.ok) return access.response;
  if (!(await deleteWatch(access.ceiling, id))) return c.json(WISP_NOT_FOUND, 404);

  writeRouteAudit(c, {
    orgId: null,
    partnerId: access.grant.partnerId,
    action: 'wisp.watch.deleted',
    resourceType: 'wisp_watch',
    resourceId: id,
    details: { grantId: access.grant.id },
  });
  return c.body(null, 204);
});
