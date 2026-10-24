/**
 * #9641 behavioural: GET /security/recommendations with the REAL helpers.
 * Status is per org (org A completing must not close the recommendation for
 * org B in the all-organizations view) and a completion reopens when the
 * problem is observed again afterwards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { auditRows, insertedValues } = vi.hoisted(() => ({
  auditRows: { current: [] as unknown[] },
  insertedValues: { current: undefined as unknown },
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        insertedValues.current = v;
        return Promise.resolve();
      },
    })),
    select: vi.fn(() => ({
      from: () => ({
        // getRecommendationStatusMap: from().where().orderBy()
        where: () => ({ orderBy: () => Promise.resolve(auditRows.current) }),
        // listThreatRows: from().innerJoin().where().orderBy()
        innerJoin: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
      }),
    })),
  },
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../services/commandQueue', () => ({ CommandTypes: {}, queueCommand: vi.fn() }));
vi.mock('../../services/securityPosture', () => ({ listLatestSecurityPosture: vi.fn() }));
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
    requirePermission: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  };
});
vi.mock('./readAuthorization', () => ({
  requireSecurityReadAccess: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { db } from '../../db';
import { listLatestSecurityPosture } from '../../services/securityPosture';
import { recommendationsRoutes } from './recommendations';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const REC = 'rec-enable-firewall';
const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-02T00:00:00.000Z';
const T2 = '2026-10-03T00:00:00.000Z';

function app(): Hono {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'partner',
      orgId: null,
      partnerId: 'p1',
      accessibleOrgIds: [ORG_A, ORG_B],
      orgCondition: () => undefined,
      canAccessOrg: () => true,
      user: { id: 'u1', email: 'u@example.com', name: 'U' },
    } as never);
    await next();
  });
  a.route('/security', recommendationsRoutes);
  return a;
}

const failingFirewall = {
  av_health: { score: 100 }, firewall: { score: 10 }, encryption: { score: 100 },
  password_policy: { score: 100 }, admin_exposure: { score: 100 }, patch_compliance: { score: 100 },
  open_ports: { score: 100 }, os_currency: { score: 100 },
};
const device = (orgId: string, deviceId: string, capturedAt: string) => ({ orgId, deviceId, capturedAt, factors: failingFirewall });
const audit = (action: string, orgId: string, timestamp: string) => ({
  action, orgId, resourceName: REC, details: null, timestamp: new Date(timestamp),
});

async function firewallStatus(): Promise<string | undefined> {
  const res = await app().request('/security/recommendations');
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.find((r: { id: string }) => r.id === REC)?.status;
}

describe('GET /security/recommendations status (#9641)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditRows.current = [];
  });

  it("org A completing does not close the recommendation for org B", async () => {
    vi.mocked(listLatestSecurityPosture).mockResolvedValue([
      device(ORG_A, 'd1', T0), device(ORG_B, 'd2', T0),
    ] as never);
    auditRows.current = [audit('security.recommendation.complete', ORG_A, T1)];
    expect(await firewallStatus()).toBe('open');
  });

  it('is completed once every affected org has closed it', async () => {
    vi.mocked(listLatestSecurityPosture).mockResolvedValue([
      device(ORG_A, 'd1', T0), device(ORG_B, 'd2', T0),
    ] as never);
    auditRows.current = [
      audit('security.recommendation.complete', ORG_A, T1),
      audit('security.recommendation.dismiss', ORG_B, T1),
    ];
    expect(await firewallStatus()).toBe('completed');
  });

  it('a completion holds while the problem has not been re-observed', async () => {
    vi.mocked(listLatestSecurityPosture).mockResolvedValue([device(ORG_A, 'd1', T0)] as never);
    auditRows.current = [audit('security.recommendation.complete', ORG_A, T1)];
    expect(await firewallStatus()).toBe('completed');
  });

  it('a completion reopens when the problem is observed after it', async () => {
    vi.mocked(listLatestSecurityPosture).mockResolvedValue([device(ORG_A, 'd1', T2)] as never);
    auditRows.current = [audit('security.recommendation.complete', ORG_A, T1)];
    expect(await firewallStatus()).toBe('open');
  });
});

describe('per-org breakdown + action orgId requirement (#9714)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditRows.current = [];
  });

  it('lists each affected org with its own status and device count', async () => {
    vi.mocked(listLatestSecurityPosture).mockResolvedValue([
      device(ORG_A, 'd1', T0), device(ORG_A, 'd3', T0), device(ORG_B, 'd2', T0),
    ] as never);
    auditRows.current = [audit('security.recommendation.complete', ORG_A, T1)];
    const res = await app().request('/security/recommendations');
    const body = await res.json();
    const rec = body.data.find((r: { id: string }) => r.id === REC);
    const byOrg = Object.fromEntries(rec.orgs.map((o: { orgId: string }) => [o.orgId, o]));
    expect(rec.orgs).toHaveLength(2);
    expect(byOrg[ORG_A]).toMatchObject({ status: 'completed', affectedDevices: 2 });
    expect(byOrg[ORG_B]).toMatchObject({ status: 'open', affectedDevices: 1 });
  });

  it('breakdown: dismissed stays dismissed; a completion voided by a later observation is open', async () => {
    vi.mocked(listLatestSecurityPosture).mockResolvedValue([
      device(ORG_A, 'd1', T0), device(ORG_B, 'd2', T2),
    ] as never);
    auditRows.current = [
      audit('security.recommendation.dismiss', ORG_A, T1),
      audit('security.recommendation.complete', ORG_B, T1),
    ];
    const body = await (await app().request('/security/recommendations')).json();
    const rec = body.data.find((r: { id: string }) => r.id === REC);
    const byOrg = Object.fromEntries(rec.orgs.map((o: { orgId: string; status: string }) => [o.orgId, o.status]));
    expect(byOrg).toEqual({ [ORG_A]: 'dismissed', [ORG_B]: 'open' });
  });

  it('POST complete with ?orgId records the audit row against that org', async () => {
    vi.mocked(listLatestSecurityPosture).mockResolvedValue([
      device(ORG_A, 'd1', T0), device(ORG_B, 'd2', T0),
    ] as never);
    const res = await app().request(`/security/recommendations/${REC}/complete?orgId=${ORG_B}`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(vi.mocked(db.insert).mock.results.length).toBeGreaterThan(0);
    expect(insertedValues.current).toMatchObject({ orgId: ORG_B, action: 'security.recommendation.complete' });
  });

  it.each(['complete', 'dismiss', 'reopen'])(
    'POST %s without orgId for a multi-org partner is a clear 400',
    async (action) => {
      vi.mocked(listLatestSecurityPosture).mockResolvedValue([device(ORG_A, 'd1', T0)] as never);
      const res = await app().request(`/security/recommendations/${REC}/${action}`, { method: 'POST' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/orgId is required/i);
    },
  );
});
