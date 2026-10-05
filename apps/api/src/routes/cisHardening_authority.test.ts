import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Route-level authority for the CIS write/remediate/approve routes.
 *
 * `requirePermission` / `requireMfa` are replaced with gates that consult a
 * per-test grant set, so each test observes exactly which permission and MFA
 * requirement a route declares — not just that some middleware ran.
 */
const { gate } = vi.hoisted(() => ({
  gate: { granted: new Set<string>(), mfa: true },
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  cisBaselines: {
    id: 'cisBaselines.id',
    orgId: 'cisBaselines.orgId',
    partnerId: 'cisBaselines.partnerId',
    osType: 'cisBaselines.osType',
    isActive: 'cisBaselines.isActive',
    updatedAt: 'cisBaselines.updatedAt',
  },
  cisBaselineResults: {},
  cisRemediationActions: {
    id: 'cisRemediationActions.id',
    orgId: 'cisRemediationActions.orgId',
  },
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (!gate.granted.has(`${resource}:${action}`)) {
      return c.json({ error: 'Permission denied', required: `${resource}:${action}` }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!gate.mfa) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    return next();
  }),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/cisHardening', () => ({
  extractFailedCheckIds: vi.fn(),
  normalizeCisSchedule: vi.fn((s: any) => ({
    enabled: s?.enabled !== false,
    intervalHours: s?.intervalHours ?? 24,
    nextScanAt: null,
  })),
}));
vi.mock('../jobs/cisJobs', () => ({
  scheduleCisScan: vi.fn(),
  scheduleCisRemediation: vi.fn(),
  scheduleCisRemediationWithResult: vi.fn(),
}));
vi.mock('./networkShared', () => ({
  resolveOrgId: vi.fn((auth: any) => ({ orgId: auth.orgId })),
}));

import { cisHardeningRoutes } from './cisHardening';
import { db } from '../db';

const BASELINE_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const ACTION_ID = '44444444-4444-4444-4444-444444444444';

function makeBaseline(overrides: Record<string, unknown> = {}) {
  return {
    id: BASELINE_ID,
    orgId: 'org-111',
    partnerId: null,
    name: 'Windows L1',
    osType: 'windows',
    benchmarkVersion: '3.0.0',
    level: 'l1',
    customExclusions: [],
    scanSchedule: { enabled: true, intervalHours: 24, nextScanAt: null },
    isActive: true,
    createdBy: 'user-1',
    executionAuthorityVersion: null,
    executionAuthorityKind: null,
    executionAuthoritySiteIds: null,
    executionAuthorityUserId: null,
    executionAuthorityPrincipalKind: null,
    executionAuthorityFingerprint: null,
    executionAuthorityCapturedAt: null,
    executionAuthorityGeneration: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const WRITE_ROUTES: Array<{ path: string; body: Record<string, unknown> }> = [
  {
    path: '/cis/baselines',
    body: { name: 'Windows L1', osType: 'windows', benchmarkVersion: '3.0.0', level: 'l1' },
  },
  {
    path: '/cis/remediate',
    body: { deviceId: DEVICE_ID, checkIds: ['1.1.1'] },
  },
  {
    path: '/cis/remediate/approve',
    body: { actionIds: [ACTION_ID], approved: true },
  },
];

function post(app: Hono, path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify(body),
  });
}

describe('CIS write routes require devices:execute and MFA', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    gate.granted = new Set();
    gate.mfa = true;
    app = new Hono();
    app.route('/cis', cisHardeningRoutes);
  });

  for (const route of WRITE_ROUTES) {
    it(`${route.path}: 403 for a caller holding only the legacy write grants`, async () => {
      gate.granted = new Set(['orgs:write', 'organizations:write', 'devices:write', 'devices:read']);
      const res = await post(app, route.path, route.body);
      expect(res.status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it(`${route.path}: 403 MFA_REQUIRED for devices:execute without MFA`, async () => {
      gate.granted = new Set(['devices:execute']);
      gate.mfa = false;
      const res = await post(app, route.path, route.body);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('MFA_REQUIRED');
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });
  }

  it('creating a scheduled baseline with devices:execute + MFA stamps a creator-bound authority', async () => {
    gate.granted = new Set(['devices:execute']);
    const valuesMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([makeBaseline()]),
    });
    vi.mocked(db.insert).mockReturnValueOnce({ values: valuesMock } as any);

    const res = await post(app, '/cis/baselines', WRITE_ROUTES[0]!.body);

    expect(res.status).toBe(201);
    const inserted = valuesMock.mock.calls[0]![0];
    expect(inserted.executionAuthorityUserId).toBe('user-1');
    expect(inserted.executionAuthorityPrincipalKind).toBe('user');
    expect(inserted.executionAuthorityKind).toBe('organization_unrestricted');
    expect(inserted.executionAuthorityGeneration).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted.executionAuthorityFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a baseline with its schedule turned off carries no authority stamp', async () => {
    gate.granted = new Set(['devices:execute']);
    const valuesMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([makeBaseline({ scanSchedule: { enabled: false } })]),
    });
    vi.mocked(db.insert).mockReturnValueOnce({ values: valuesMock } as any);

    const res = await post(app, '/cis/baselines', {
      ...WRITE_ROUTES[0]!.body,
      scanSchedule: { enabled: false },
    });

    expect(res.status).toBe(201);
    const inserted = valuesMock.mock.calls[0]![0];
    expect(inserted.executionAuthorityGeneration).toBeNull();
    expect(inserted.executionAuthorityUserId).toBeNull();
  });
});

describe('GET /cis/baselines surfaces schedules that need re-approval', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    gate.granted = new Set(['devices:read']);
    gate.mfa = true;
    app = new Hono();
    app.route('/cis', cisHardeningRoutes);
  });

  function mockList(rows: unknown[]) {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: rows.length }]) }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue(rows) }),
            }),
          }),
        }),
      } as any);
  }

  it('flags an enabled legacy schedule without a stamp and hides the raw authority columns', async () => {
    mockList([
      makeBaseline(),
      makeBaseline({ id: '55555555-5555-5555-5555-555555555555', scanSchedule: { enabled: false } }),
    ]);

    const res = await app.request('/cis/baselines', { headers: { Authorization: 'Bearer token' } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].scheduleApproval).toEqual(
      expect.objectContaining({ status: 'reapproval_required' }),
    );
    expect(body.data[1].scheduleApproval).toEqual(
      expect.objectContaining({ status: 'not_scheduled' }),
    );
    expect(body.data[0]).not.toHaveProperty('executionAuthorityFingerprint');
    expect(body.data[0]).not.toHaveProperty('executionAuthorityGeneration');
  });
});
