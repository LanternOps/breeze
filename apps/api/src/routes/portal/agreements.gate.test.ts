import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// The ASSEMBLED portal router (#9075 W3a): every agreement and signed-agreement
// path carries portal auth (routerAuthGate exempts `portalRoutes` as a whole
// because login lives there, so this file is the gate's proof), and
// accept/decline carry the financial-mutation guard (CSRF for cookie
// sessions; JSON-only bodies).

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REQ = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({ accept: vi.fn(), decline: vi.fn(), load: vi.fn() }));

vi.mock('../../services/agreementRequestAcceptService', () => ({
  acceptAgreementRequest: mocks.accept,
  declineAgreementRequest: mocks.decline,
  markAgreementRequestViewed: vi.fn(),
}));
vi.mock('../../services/agreementCertificate', () => ({
  loadCertifiedAgreementInput: mocks.load,
  renderCertifiedAgreementPdf: vi.fn(),
}));
vi.mock('../../services/portal/timezone', () => ({ resolveOrgTimezone: vi.fn(async () => 'UTC') }));
vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => ({ orgId: '11111111-1111-4111-8111-111111111111', partnerId: 'partner-1' })),
  isUsableOrgStatus: (status: string) => status === 'active' || status === 'trial',
  invalidateAgentTenantCache: vi.fn(async () => undefined),
}));

vi.mock('../../db', () => {
  const portalUser = {
    id: 'pu-1', orgId: '11111111-1111-4111-8111-111111111111', email: 'customer@example.com',
    name: 'Customer', contactId: null, authMethod: 'password', receiveNotifications: true, status: 'active', authEpoch: 1,
  };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'innerJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve([portalUser]).then(resolve);
  return {
    db: chain,
    withDbAccessContext: (_context: unknown, fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  };
});

import { portalRoutes } from './index';
import { portalSessions } from './helpers';

const TOKEN = 'agreements-gate-session';

function assembledApp() {
  const hono = new Hono();
  hono.route('/portal', portalRoutes);
  return hono;
}

beforeEach(() => {
  vi.clearAllMocks();
  portalSessions.clear();
});

const PATHS: Array<[string, string]> = [
  ['GET', '/portal/agreements'],
  ['GET', `/portal/agreements/${REQ}`],
  ['GET', `/portal/agreements/${REQ}/file`],
  ['POST', `/portal/agreements/${REQ}/accept`],
  ['POST', `/portal/agreements/${REQ}/decline`],
  ['GET', '/portal/signed-agreements'],
  ['GET', `/portal/signed-agreements/${DOC}/file`],
  ['GET', `/portal/signed-agreements/${DOC}/file?copy=original`],
];

describe('assembled portal router: agreement gates', () => {
  it.each(PATHS)('%s %s without a portal session is 401 and touches nothing', async (method, path) => {
    const res = await assembledApp().request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ signerName: 'A' }) : undefined,
    });
    expect(res.status).toBe(401);
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.decline).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it.each([
    `/portal/agreements/${REQ}/accept`,
    `/portal/agreements/${REQ}/decline`,
  ])('POST %s refuses a non-JSON body (form submissions never reach the writer)', async (path) => {
    portalSessions.set(TOKEN, {
      token: TOKEN, portalUserId: 'pu-1', orgId: ORG_ID, authEpoch: 1,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await assembledApp().request(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'signerName=A',
    });
    expect(res.status).toBe(415);
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.decline).not.toHaveBeenCalled();
  });
});
