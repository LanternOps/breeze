import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '../lib/validation';
import {
  authMiddleware,
  requirePermission,
  requireScope,
} from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import {
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withDbAccessContext,
} from '../db';
import {
  fleetScope,
  fleetTimeFiltersSchema,
  listFleetTimeStatus,
  FleetTimeForbidden,
} from '../services/timeSync/fleet';
import {
  exportCurrentTimeCsv,
  exportHistoryTimeCsv,
  historyTimeQuerySchema,
} from '../services/timeSync/exports';
import { captureException } from '../services/sentry';
export const timeStatusRoutes = new Hono();
timeStatusRoutes.use(
  '*',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(
    PERMISSIONS.DEVICES_READ.resource,
    PERMISSIONS.DEVICES_READ.action,
  ),
);
timeStatusRoutes.onError((error, c) => {
  if (error instanceof FleetTimeForbidden)
    return c.json({ error: error.message }, 403);
  // Everything else (HTTPException from auth/scope/permission middleware, DB
  // failures, RLS denials, CONNECT_TIMEOUT) goes to the global app.onError: it
  // maps HTTPException and is the only handler that diagnoses a pool timeout
  // and reports to Sentry.
  throw error;
});
/**
 * Streams a CSV export. The header and the first data page are read before the
 * response is committed, inside the request's own DB context, so a failure at
 * the start (bad range re-parse, RLS denial, DB outage) is a real 500 through
 * onError instead of a 200 followed by a reset. Later pages run after the
 * request transaction has ended, each in a fresh context carrying the caller's
 * access; a failure there can no longer change the status, so it errors the
 * stream (the client must not keep a truncated evidence file as complete) and
 * is logged and reported here, because nothing downstream does either.
 */
async function csvResponse(
  c: Context,
  iterator: AsyncGenerator<string>,
  filename: string,
): Promise<Response> {
  const context = getCurrentDbAccessContext();
  if (!context)
    throw new Error('Time export requires a database access context');
  const primed: string[] = [];
  let exhausted = false;
  try {
    while (!exhausted && primed.length < 2) {
      const next = await iterator.next();
      if (next.done) exhausted = true;
      else primed.push(next.value);
    }
  } catch (error) {
    await iterator.return(undefined);
    throw error;
  }
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buffered = primed.shift();
      if (buffered !== undefined) {
        controller.enqueue(encoder.encode(buffered));
        return;
      }
      if (exhausted) {
        controller.close();
        return;
      }
      try {
        const next = await runOutsideDbContext(() =>
          withDbAccessContext(context, () => iterator.next()),
        );
        if (cancelled) return;
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        if (!cancelled) {
          console.error('[time-status] CSV export failed mid-stream', {
            filename,
            error,
          });
          captureException(error, c);
          controller.error(error);
        }
        await iterator.return(undefined);
      }
    },
    async cancel() {
      cancelled = true;
      await iterator.return(undefined);
    },
  });
  return c.newResponse(body, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
}
timeStatusRoutes.get(
  '/',
  zValidator('query', fleetTimeFiltersSchema),
  async (c) =>
    c.json(await listFleetTimeStatus(c.req.valid('query'), c.get('auth'))),
);
timeStatusRoutes.get(
  '/export',
  zValidator('query', fleetTimeFiltersSchema),
  async (c) => {
    const q = c.req.valid('query'),
      auth = c.get('auth');
    fleetScope(q, auth);
    return csvResponse(c, exportCurrentTimeCsv(q, auth), 'time-status.csv');
  },
);
timeStatusRoutes.get(
  '/history/export',
  zValidator('query', historyTimeQuerySchema),
  async (c) => {
    const { from, to, ...filters } = c.req.valid('query'),
      auth = c.get('auth');
    fleetScope(filters, auth);
    return csvResponse(
      c,
      exportHistoryTimeCsv(filters, { from, to }, auth),
      'time-status-history.csv',
    );
  },
);
