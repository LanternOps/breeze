import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { authBrowserTransitions } from '../../db/schema/authBrowserTransitions';
import { resolveAuthBinding } from '../../services/authBrowserTransition';
import { requestAuthBinding } from './binding';
import {
  authTransitionTestBarrierStatus,
  authTransitionTestControlAuthorized,
  releaseAuthTransitionTestBarrier,
  waitForAuthTransitionTestBarrier,
} from './authTransitionTestBarrier';

export const AUTH_TRANSITION_TEST_SECRET_HEADER = 'x-breeze-auth-transition-test-secret';
export const AUTH_TRANSITION_TEST_BARRIER_HEADER = 'x-breeze-auth-transition-test-barrier';

function requestSecret(c: Context): string | undefined {
  return c.req.header(AUTH_TRANSITION_TEST_SECRET_HEADER);
}

export async function waitForAuthTransitionFinalizationTestBarrier(c: Context): Promise<void> {
  await waitForAuthTransitionTestBarrier(
    c.req.header(AUTH_TRANSITION_TEST_BARRIER_HEADER),
    requestSecret(c),
  );
}

export const authTransitionTestControlRoutes = new Hono();

authTransitionTestControlRoutes.get('/__test/auth-transition/barriers/:barrierId', (c) => {
  const status = authTransitionTestBarrierStatus(c.req.param('barrierId'), requestSecret(c));
  return status ? c.json({ status }) : c.notFound();
});

authTransitionTestControlRoutes.post('/__test/auth-transition/barriers/:barrierId/release', (c) => {
  return releaseAuthTransitionTestBarrier(c.req.param('barrierId'), requestSecret(c))
    ? c.body(null, 204)
    : c.notFound();
});

authTransitionTestControlRoutes.get('/__test/auth-transition/binding', async (c) => {
  if (!authTransitionTestControlAuthorized(requestSecret(c))) return c.notFound();
  const resolved = resolveAuthBinding(requestAuthBinding(c));
  const rows = await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(() =>
      dbModule.db
        .select({
          id: authBrowserTransitions.id,
          generation: authBrowserTransitions.generation,
          state: authBrowserTransitions.state,
        })
        .from(authBrowserTransitions)
        .where(eq(authBrowserTransitions.bindingDigest, resolved.bindingDigest))
        .limit(1),
    ),
  );
  const row = rows[0];
  return row ? c.json(row) : c.notFound();
});
