import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Deterministic auth gate: 401 unless an Authorization header is present.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) {
      return c.json({ error: 'Missing or invalid authorization header' }, 401);
    }
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
}));

// The invoice route handlers are never reached in these tests (auth blocks them),
// but the modules import these — stub them so importing the routers is side-effect free.
vi.mock('../../services/invoiceService', () => ({
  assembleDraftFromOrg: vi.fn(),
  assembleDraftFromTicket: vi.fn(),
  updatePartnerBillingSettings: vi.fn(),
  updateOrgBillingSettings: vi.fn(),
}));
vi.mock('./invoices', () => ({
  invoiceActorFrom: vi.fn(),
  handleServiceError: vi.fn(),
}));

import { invoiceAssemblyRoutes } from './assembly';
import { invoiceSettingsRoutes } from './settings';

// Regression for the #1383 main-smoke break: the invoice assembly/settings routers
// are mounted at the api root via `api.route('/', ...)`. They must NOT install a
// `use('*', authMiddleware)`, because a wildcard middleware on a router mounted at
// '/' leaks onto every sibling route registered afterwards — including public ones
// like the agent-binary download endpoint, which then returns 401.
function buildApp() {
  const app = new Hono();
  app.route('/', invoiceAssemblyRoutes);
  app.route('/', invoiceSettingsRoutes);
  // A public route registered AFTER the invoice routers, mimicking how the real
  // agent-versions download route mounts later in index.ts.
  app.get('/agent-versions/:version/download', (c) => c.text('public-ok'));
  return app;
}

describe('invoice routers do not leak auth onto sibling routes (#1383)', () => {
  it('does not auth-gate a public route registered after the invoice routers', async () => {
    const app = buildApp();
    const res = await app.request('/agent-versions/0.65.9/download');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('public-ok');
  });

  it('still requires auth on the invoice assembly routes', async () => {
    const app = buildApp();
    const res = await app.request('/tickets/11111111-1111-4111-8111-111111111111/invoice', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('still requires auth on the billing-settings routes', async () => {
    const app = buildApp();
    const partner = await app.request('/partner/billing-settings', { method: 'PATCH' });
    expect(partner.status).toBe(401);
    const org = await app.request('/orgs/22222222-2222-4222-8222-222222222222/billing-settings', {
      method: 'PATCH',
    });
    expect(org.status).toBe(401);
  });
});
