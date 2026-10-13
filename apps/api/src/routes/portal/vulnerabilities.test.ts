import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  findings: vi.fn(),
  brandingRows: [] as Array<{ enableVulnerabilityDetail: boolean | null }>,
}));

vi.mock('../../services/portal/vulnerabilityDetailReadModel', () => ({
  vulnerabilityDetailSummary: mocks.summary,
  vulnerabilityDetailFindings: mocks.findings,
}));

vi.mock('../../services/portal/timezone', () => ({
  resolveOrgTimezone: vi.fn(async () => 'America/Denver'),
}));

vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => ({
    orgId: '11111111-1111-4111-8111-111111111111',
    partnerId: 'partner-1',
  })),
  isUsableOrgStatus: (status: string) => status === 'active' || status === 'trial',
  invalidateAgentTenantCache: vi.fn(async () => undefined),
}));

vi.mock('../../db', () => ({
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(
            Object.hasOwn(columns, 'enableVulnerabilityDetail')
              ? mocks.brandingRows
              : [{
                  id: 'pu-1',
                  orgId: '11111111-1111-4111-8111-111111111111',
                  email: 'customer@example.com',
                  name: 'Customer',
                  contactId: null,
                  authMethod: 'password',
                  receiveNotifications: true,
                  status: 'active',
                  authEpoch: 1,
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

import { portalVulnerabilityRoutes } from './vulnerabilities';
import { portalRoutes } from './index';
import { portalSessions } from './helpers';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_DEVICE = '99999999-9999-4999-8999-999999999999';
const TOKEN = 'vulnerabilities-route-session';
const DEFAULTS = { page: 1, limit: 50, status: 'open', now: expect.any(Date) };

function isolatedApp() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: 'pu-1',
        orgId: ORG_ID,
        email: 'customer@example.com',
        name: 'Customer',
        contactId: null,
        receiveNotifications: true,
        status: 'active',
      },
      token: 'token',
      authMethod: 'bearer',
      timezone: 'America/Denver',
    });
    await next();
  });
  hono.route('/', portalVulnerabilityRoutes);
  return hono;
}

function assembledApp() {
  const hono = new Hono();
  hono.route('/portal', portalRoutes);
  return hono;
}

function seedSession() {
  portalSessions.set(TOKEN, {
    token: TOKEN,
    portalUserId: 'pu-1',
    orgId: ORG_ID,
    authEpoch: 1,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
}

const LIST = {
  asOf: '2026-10-06T12:00:00.000Z',
  dataStatus: 'ok',
  data: [],
  pagination: { page: 1, limit: 50, total: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  portalSessions.clear();
  mocks.brandingRows = [];
});

describe('vulnerability detail handlers', () => {
  it('paginates the summary with the session org and sets cache headers', async () => {
    mocks.summary.mockResolvedValue(LIST);
    const response = await isolatedApp().request('/vulnerabilities/summary?page=2&limit=25');
    expect(response.status).toBe(200);
    expect(mocks.summary).toHaveBeenCalledWith(ORG_ID, { ...DEFAULTS, page: 2, limit: 25 });
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('etag')).toMatch(/^W\//);
  });

  it('defaults findings to the open status and passes an explicit status filter through', async () => {
    mocks.findings.mockResolvedValue(LIST);
    await isolatedApp().request('/vulnerabilities/findings');
    expect(mocks.findings).toHaveBeenLastCalledWith(ORG_ID, { ...DEFAULTS, deviceId: undefined });
    await isolatedApp().request('/vulnerabilities/findings?status=accepted');
    expect(mocks.findings).toHaveBeenLastCalledWith(ORG_ID, { ...DEFAULTS, status: 'accepted', deviceId: undefined });
  });

  it('validates page, limit, status and deviceId', async () => {
    expect((await isolatedApp().request('/vulnerabilities/summary?limit=101')).status).toBe(400);
    expect((await isolatedApp().request('/vulnerabilities/summary?page=0')).status).toBe(400);
    expect((await isolatedApp().request('/vulnerabilities/findings?status=all')).status).toBe(400);
    expect((await isolatedApp().request('/vulnerabilities/findings?status=bogus')).status).toBe(400);
    expect((await isolatedApp().request('/vulnerabilities/findings?deviceId=not-a-uuid')).status).toBe(400);
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.findings).not.toHaveBeenCalled();
  });

  it('revalidates unchanged data when only asOf changes', async () => {
    mocks.findings
      .mockResolvedValueOnce(LIST)
      .mockResolvedValueOnce({ ...LIST, asOf: '2026-10-06T12:00:01.000Z' });
    const first = await isolatedApp().request('/vulnerabilities/findings');
    const second = await isolatedApp().request('/vulnerabilities/findings', {
      headers: { 'If-None-Match': first.headers.get('etag')! },
    });
    expect(second.status).toBe(304);
  });

  it('returns 404 when the device filter is not in the session org (forged id)', async () => {
    mocks.findings.mockResolvedValue(null);
    const response = await isolatedApp().request(
      `/vulnerabilities/findings?deviceId=${OTHER_ORG_DEVICE}&orgId=other-org`,
    );
    expect(response.status).toBe(404);
    // The org always comes from the session, never from the request.
    expect(mocks.findings).toHaveBeenCalledWith(ORG_ID, { ...DEFAULTS, deviceId: OTHER_ORG_DEVICE });
  });
});

describe('assembled portal router vulnerability detail gate', () => {
  it('returns 401 without a portal session', async () => {
    const response = await assembledApp().request('/portal/vulnerabilities/summary');
    expect(response.status).toBe(401);
    expect(mocks.summary).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing settings row', [] as Array<{ enableVulnerabilityDetail: boolean | null }>],
    ['false', [{ enableVulnerabilityDetail: false }]],
    ['null', [{ enableVulnerabilityDetail: null }]],
  ])('returns 403 with the family code for %s', async (_label, rows) => {
    seedSession();
    mocks.brandingRows = rows;
    for (const path of ['/portal/vulnerabilities/summary', '/portal/vulnerabilities/findings']) {
      const response = await assembledApp().request(path, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Vulnerability detail is not enabled for this portal',
        code: 'PORTAL_VULNERABILITY_DETAIL_DISABLED',
      });
    }
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.findings).not.toHaveBeenCalled();
  });

  it('returns 200 when enableVulnerabilityDetail is true', async () => {
    seedSession();
    mocks.brandingRows = [{ enableVulnerabilityDetail: true }];
    mocks.summary.mockResolvedValue(LIST);
    mocks.findings.mockResolvedValue(LIST);
    for (const path of ['/portal/vulnerabilities/summary', '/portal/vulnerabilities/findings']) {
      const response = await assembledApp().request(path, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('private');
    }
    expect(mocks.summary).toHaveBeenCalledWith(ORG_ID, DEFAULTS);
  });
});
