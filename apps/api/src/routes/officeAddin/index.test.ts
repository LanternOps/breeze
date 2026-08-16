import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * Route-composition contract for the /office-addin mount (review finding 3).
 *
 * Hono flattens mounted sub-routers, so when every sub-router was mounted at
 * '/', each protected router's `use('*', officeAddinTechAuthMiddleware)`
 * stacked onto EVERY request — a /time/* call ran the (Redis + DB) auth
 * middleware three times, and /auth/* stayed pre-auth only by registration
 * order. This suite instruments the middleware and pins the contract:
 * exactly ONCE for a protected tech-token route, ZERO times for the pre-auth
 * exchange route and the web-session bindings admin surface.
 */

const { techAuthMiddlewareMock } = vi.hoisted(() => ({
  techAuthMiddlewareMock: vi.fn(),
}));

vi.mock('../../middleware/officeAddinTechAuth', () => ({
  officeAddinTechAuthMiddleware: techAuthMiddlewareMock,
  requireAddinCapability: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

// The bindings admin router runs the ordinary web-session chain; a bare 401
// stand-in keeps this composition test independent of real JWT plumbing.
// Partial mock: other modules in the import graph use the rest of the module.
vi.mock('../../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/auth')>()),
  authMiddleware: vi.fn(async (c: { json: (b: unknown, s: number) => Response }) =>
    c.json({ error: 'unauthorized' }, 401)
  ),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../services/timeEntryService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/timeEntryService')>()),
  getRunningTimer: vi.fn(async () => null),
  // '/time/stop' accepts an empty body, so it reaches the service — stub it.
  stopTimer: vi.fn(async () => ({ id: 'entry-1' })),
}));

// Force the exchange/bind not_enabled short-circuit regardless of local env,
// so the pre-auth routes answer deterministically without Redis/Entra work.
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  CLIENT_AI_ENTRA_CLIENT_ID: undefined,
}));

import { officeAddinRoutes } from './index';

function makeApp() {
  const app = new Hono();
  app.route('/office-addin', officeAddinRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  techAuthMiddlewareMock.mockImplementation(async (c: any, next: () => Promise<void>) => {
    c.set('officeAddinAuth', {
      userId: 'user-1',
      partnerId: 'partner-1',
      bindingId: 'binding-1',
      token: 'tok',
      user: { email: 'tech@partner.example', name: 'Tech Person' },
      accessibleOrgIds: null,
      partnerOrgAccess: 'all',
      permissions: {},
      canAccessOrg: () => true,
      canAccessSite: () => true,
    });
    return next();
  });
});

describe('officeAddinRoutes composition', () => {
  it('runs the tech-auth middleware exactly once for a /time/* request', async () => {
    const res = await makeApp().request('/office-addin/time/running');
    expect(res.status).toBe(200);
    expect(techAuthMiddlewareMock).toHaveBeenCalledTimes(1);
  });

  it('runs the tech-auth middleware exactly once for /tickets/* and /email-context requests', async () => {
    // 400 (schema) is fine — what matters is the middleware count per request.
    await makeApp().request('/office-addin/tickets/draft', { method: 'POST' });
    expect(techAuthMiddlewareMock).toHaveBeenCalledTimes(1);

    techAuthMiddlewareMock.mockClear();
    await makeApp().request('/office-addin/email-context', { method: 'POST' });
    expect(techAuthMiddlewareMock).toHaveBeenCalledTimes(1);
  });

  it('never runs the tech-auth middleware for the pre-auth exchange route', async () => {
    // CLIENT_AI_ENTRA_CLIENT_ID is mocked away -> the route answers 404
    // not_enabled; the point here is zero tech-middleware runs.
    const res = await makeApp().request('/office-addin/auth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: 'entra-token' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_enabled' });
    expect(techAuthMiddlewareMock).not.toHaveBeenCalled();
  });

  it('never runs the tech-auth middleware for the web-session bindings admin surface', async () => {
    const res = await makeApp().request('/office-addin/bindings');
    expect(res.status).toBe(401); // stubbed web authMiddleware
    expect(techAuthMiddlewareMock).not.toHaveBeenCalled();
  });

  it('keeps every external path shape unchanged after the prefix remount', async () => {
    const app = makeApp();
    // Each of these must MATCH a handler (i.e. not 404): protected routes
    // reach their zod validator (400 without a body) or handler (200).
    expect((await app.request('/office-addin/time/running')).status).toBe(200);
    expect((await app.request('/office-addin/time/start', { method: 'POST' })).status).toBe(400);
    expect((await app.request('/office-addin/time/stop', { method: 'POST' })).status).toBe(200); // empty body is schema-legal; service stubbed
    expect((await app.request('/office-addin/time/log', { method: 'POST' })).status).toBe(400);
    expect((await app.request('/office-addin/tickets/draft', { method: 'POST' })).status).toBe(400);
    expect((await app.request('/office-addin/tickets/from-email', { method: 'POST' })).status).toBe(400);
    expect(
      (await app.request('/office-addin/tickets/00000000-0000-4000-8000-000000000001/link-email', { method: 'POST' })).status
    ).toBe(400);
    expect((await app.request('/office-addin/email-context', { method: 'POST' })).status).toBe(400);
    expect((await app.request('/office-addin/orgs/search', { method: 'POST' })).status).toBe(400);
    expect((await app.request('/office-addin/auth/exchange', { method: 'POST' })).status).toBe(400); // zValidator, so the route matched
    expect((await app.request('/office-addin/auth/bind', { method: 'POST' })).status).toBe(400); // zValidator, so the route matched
    expect((await app.request('/office-addin/bindings')).status).toBe(401);
    expect(
      (await app.request('/office-addin/bindings/00000000-0000-4000-8000-000000000001', { method: 'DELETE' })).status
    ).toBe(401);
  });
});
