import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// The ASSEMBLED portal router: /trust-page must carry portal auth before any
// router-wide middleware the earlier '/' mounts add. invoiceRoutes and
// quoteRoutes register `use('*', portalFinancialMutationGuard)` at '/', which
// reads portalAuth on every POST; with auth applied only inside the trust-page
// router, a POST reached that guard unauthenticated and threw (500). Found by
// the W3d E2E (trust-center-portal-edit.spec.ts).

const ORG_ID = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({ decide: vi.fn() }));

vi.mock('../../services/portal/trustPageEditor', () => ({
  decidePortalTrustPageEditor: mocks.decide,
  isPortalTrustPageEditor: vi.fn(async () => false),
}));
vi.mock('../../services/portal/timezone', () => ({ resolveOrgTimezone: vi.fn(async () => 'UTC') }));
vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => ({ orgId: '11111111-1111-4111-8111-111111111111', partnerId: 'partner-1' })),
  isUsableOrgStatus: (status: string) => status === 'active' || status === 'trial',
  invalidateAgentTenantCache: vi.fn(async () => undefined),
}));
vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: 'pu-1', orgId: '11111111-1111-4111-8111-111111111111', email: 'customer@example.com',
            name: 'Customer', contactId: 'contact-1', authMethod: 'password', receiveNotifications: true,
            status: 'active', authEpoch: 1,
          }]),
        }),
      }),
    }),
  },
  withDbAccessContext: (_context: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
}));

import { portalRoutes } from './index';
import { portalSessions } from './helpers';

const TOKEN = 'trust-page-gate-session';

function assembledApp() {
  const hono = new Hono();
  hono.route('/portal', portalRoutes);
  return hono;
}

beforeEach(() => {
  vi.clearAllMocks();
  portalSessions.clear();
  mocks.decide.mockResolvedValue({ allowed: false, code: 'PORTAL_TRUST_EDITING_DISABLED' });
});

const ROUTES = [
  ['GET', '/portal/trust-page', undefined],
  ['PUT', '/portal/trust-page', { expectedRevision: 0, websiteUrl: null }],
  ['POST', '/portal/trust-page/preview-token', {}],
  ['POST', '/portal/trust-page/unpublish', { confirm: true }],
] as const;

describe('assembled portal router: /trust-page gates', () => {
  it.each(ROUTES)('%s %s without a portal session is 401', async (method, path, body) => {
    const res = await assembledApp().request(path, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    expect(res.status).toBe(401);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s %s with a session reaches the editor gate (403 code), never a 500', async (method, path, body) => {
    portalSessions.set(TOKEN, {
      token: TOKEN, portalUserId: 'pu-1', orgId: ORG_ID, authEpoch: 1,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await assembledApp().request(path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PORTAL_TRUST_EDITING_DISABLED');
    expect(mocks.decide).toHaveBeenCalledWith({ id: 'pu-1', orgId: ORG_ID });
  });
});
