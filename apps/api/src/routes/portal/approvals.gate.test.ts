import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// The assembled portal router: /approvals must carry portal auth AND the
// ticketing gate (portal_branding.enable_tickets, fail-open on a missing row).

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REQ = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  find: vi.fn(),
  brandingRows: [] as Array<{ enableTickets: boolean }>,
}));

vi.mock('../../services/ticketApproval/portal', () => ({
  listPortalApprovals: mocks.list,
  findPortalApproval: mocks.find,
}));

vi.mock('../../services/portal/timezone', () => ({ resolveOrgTimezone: vi.fn(async () => 'UTC') }));

vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => ({ orgId: '11111111-1111-4111-8111-111111111111', partnerId: 'partner-1' })),
  isUsableOrgStatus: (status: string) => status === 'active' || status === 'trial',
  invalidateAgentTenantCache: vi.fn(async () => undefined),
}));

vi.mock('../../db', () => ({
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(
            Object.hasOwn(columns, 'enableTickets')
              ? mocks.brandingRows
              : [{
                  id: 'pu-1', orgId: '11111111-1111-4111-8111-111111111111', email: 'customer@example.com',
                  name: 'Customer', contactId: null, authMethod: 'password', receiveNotifications: true,
                  status: 'active', authEpoch: 1,
                }],
          ),
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

const TOKEN = 'approvals-gate-session';

function assembledApp() {
  const hono = new Hono();
  hono.route('/portal', portalRoutes);
  return hono;
}

function seedSession() {
  portalSessions.set(TOKEN, {
    token: TOKEN, portalUserId: 'pu-1', orgId: ORG_ID, authEpoch: 1,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };

beforeEach(() => {
  vi.clearAllMocks();
  portalSessions.clear();
  mocks.brandingRows = [];
  mocks.list.mockResolvedValue([]);
});

describe('assembled portal router: /approvals gates', () => {
  it.each([
    ['GET', '/portal/approvals'],
    ['GET', '/portal/approvals?status=pending'],
    ['POST', `/portal/approvals/${REQ}/approve`],
    ['POST', `/portal/approvals/${REQ}/deny`],
  ])('%s %s without a portal session is 401', async (method, path) => {
    const res = await assembledApp().request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    expect(res.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/portal/approvals'],
    ['POST', `/portal/approvals/${REQ}/approve`],
  ])('%s %s is 403 PORTAL_TICKETS_DISABLED when the org switched ticketing off', async (method, path) => {
    seedSession();
    mocks.brandingRows = [{ enableTickets: false }];
    const res = await assembledApp().request(path, {
      method, headers: { ...auth, 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ revision: 1, signerName: 'A' }) : undefined,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PORTAL_TICKETS_DISABLED');
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it('fails OPEN on a missing branding row, like the tickets gate (#2345)', async () => {
    seedSession();
    const res = await assembledApp().request('/portal/approvals', { headers: auth });
    expect(res.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), { orgId: ORG_ID, email: 'customer@example.com', pendingOnly: false });
  });
});
