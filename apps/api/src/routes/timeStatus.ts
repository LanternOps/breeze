import { Hono, type Context } from 'hono';
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
  console.error('[time-status] request failed', error);
  return c.json({ error: 'Failed to read time synchronization data' }, 500);
});
function csvResponse(
  c: Context,
  iterator: AsyncGenerator<string>,
  filename: string,
): Response {
  const context = getCurrentDbAccessContext();
  if (!context)
    throw new Error('Time export requires a database access context');
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
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
        if (!cancelled) controller.error(error);
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
  (c) => {
    const q = c.req.valid('query'),
      auth = c.get('auth');
    fleetScope(q, auth);
    return csvResponse(c, exportCurrentTimeCsv(q, auth), 'time-status.csv');
  },
);
timeStatusRoutes.get(
  '/history/export',
  zValidator('query', historyTimeQuerySchema),
  (c) => {
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
