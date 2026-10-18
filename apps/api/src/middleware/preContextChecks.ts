import type { Context, MiddlewareHandler } from 'hono';

/**
 * Pre-context checks (#8334 / #1105).
 *
 * `authMiddleware` opens the request's `withDbAccessContext` transaction and
 * runs EVERY downstream handler inside it. A per-user Redis rate limiter that
 * is registered as ordinary route middleware therefore executes with a pooled
 * Postgres connection held idle-in-transaction for the whole Redis round-trip.
 * `runOutsideDbContext` cannot fix that (it hides the ambient store but does
 * not release the transaction), so the check has to run BEFORE the context
 * opens.
 *
 * A middleware built with `preContextCheck(check)` is tagged with its `check`.
 * `authMiddleware` calls `runPreContextChecks(c)` after it has authenticated
 * the request and before it opens the DB context; it scans the handlers Hono
 * matched for this request (`c.req.matchedRoutes`), runs each tagged check
 * once, and short-circuits with the check's Response if one denies. When the
 * middleware itself later executes it sees the check already ran and just
 * continues. If no context-opening middleware ran the check (a route not
 * behind authMiddleware, a self-managed-context route, a unit test) the
 * middleware runs it inline, so the check can never be skipped.
 *
 * Ordering note: the check now runs before later route middleware
 * (requirePermission, validators). A request those reject still counts against
 * the limiter's budget.
 */
const PRE_CONTEXT_CHECK = Symbol.for('breeze.preContextCheck');
const DONE_KEY = '__preContextChecksDone';

/** Return a Response to deny the request, or null to let it proceed. */
export type PreContextCheck = (c: Context) => Promise<Response | null>;

type Tagged = MiddlewareHandler & { [PRE_CONTEXT_CHECK]?: PreContextCheck };

async function runOnce(c: Context, handler: unknown, check: PreContextCheck): Promise<Response | null> {
  const done = ((c as unknown as { get: (k: string) => unknown }).get(DONE_KEY) as Set<unknown> | undefined) ?? new Set<unknown>();
  if (done.has(handler)) return null;
  done.add(handler);
  (c as unknown as { set: (k: string, v: unknown) => void }).set(DONE_KEY, done);
  return check(c);
}

export function preContextCheck(check: PreContextCheck): MiddlewareHandler {
  const mw: Tagged = async (c, next) => {
    const denied = await runOnce(c, mw, check);
    if (denied) return denied;
    await next();
  };
  mw[PRE_CONTEXT_CHECK] = check;
  return mw;
}

/** Called by the context-opening middleware, before it takes a connection. */
export async function runPreContextChecks(c: Context): Promise<Response | null> {
  const routes = c.req.matchedRoutes ?? [];
  for (const route of routes) {
    const handler = route.handler as Tagged;
    const check = handler[PRE_CONTEXT_CHECK];
    if (!check) continue;
    const denied = await runOnce(c, handler, check);
    if (denied) return denied;
  }
  return null;
}
