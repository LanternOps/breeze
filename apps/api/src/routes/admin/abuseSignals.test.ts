import { describe, it, expect, vi, beforeEach } from 'vitest';

// Route tests for the abuse-signal acknowledgement surface in abuse.ts:
//   GET  /admin/signals
//   POST /admin/signals/:id/acknowledge
//   POST /admin/signals/acknowledge-bulk
//
// Mirrors abuse.test.ts: real platformAdminMiddleware + real adminRoutes
// mounting, mocked db module, schema table replaced with opaque string
// tokens so captured Drizzle conditions can be asserted by inspection.
// All fixtures are synthetic.

const dbState = vi.hoisted(() => ({
  // FIFO queues consumed by the db mock — seed per test.
  selectQueue: [] as unknown[][],
  updateQueue: [] as unknown[][],
  // Captured call shapes.
  wheres: [] as unknown[],
  updateWheres: [] as unknown[],
  setValues: [] as Array<Record<string, unknown>>,
  limits: [] as number[],
  offsets: [] as number[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const rows = dbState.selectQueue.shift() ?? [];
      const chain: any = {
        from: () => chain,
        where: (cond: unknown) => {
          dbState.wheres.push(cond);
          const thenable: any = Promise.resolve(rows);
          thenable.limit = () => Promise.resolve(rows);
          thenable.orderBy = () => ({
            limit: (n: number) => {
              dbState.limits.push(n);
              return {
                offset: (o: number) => {
                  dbState.offsets.push(o);
                  return Promise.resolve(rows);
                },
              };
            },
          });
          return thenable;
        },
      };
      return chain;
    }),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        dbState.setValues.push(values);
        return {
          where: (cond: unknown) => {
            dbState.updateWheres.push(cond);
            return {
              returning: () => Promise.resolve(dbState.updateQueue.shift() ?? []),
            };
          },
        };
      },
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/schema')>()),
  partnerAbuseSignals: {
    id: 'pas.id',
    partnerId: 'pas.partnerId',
    signalKey: 'pas.signalKey',
    severity: 'pas.severity',
    score: 'pas.score',
    evidence: 'pas.evidence',
    firstFiredAt: 'pas.firstFiredAt',
    computedAt: 'pas.computedAt',
    resolvedAt: 'pas.resolvedAt',
    acknowledgedAt: 'pas.acknowledgedAt',
    acknowledgedBy: 'pas.acknowledgedBy',
    deliveredAt: 'pas.deliveredAt',
  },
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: vi.fn(),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

// Transitive imports of abuse.ts that would otherwise pull heavy service
// graphs into this suite — same stubs as abuse.test.ts.
vi.mock('../../oauth/grantRevocation', () => ({
  revokeAllPartnerOauthArtifacts: vi.fn(async () => ({
    grantsRevoked: 0,
    refreshTokensRevoked: 0,
    jtisRevoked: 0,
  })),
}));
vi.mock('../../services/tenantLifecycle', () => ({
  restorePartnerTenantAccess: vi.fn(async () => ({ agentTokensRestored: 0 })),
}));
vi.mock('../../services/remoteSessionTeardown', () => ({
  terminateUserRemoteSessions: vi.fn(async () => 0),
  TEARDOWN_FAILED: -1,
}));

// Stub authMiddleware to short-circuit (the test injects its own auth
// context); mirror the REAL requireMfa() behavior so the step-up gate is
// exercised deterministically — see abuse.test.ts for the rationale.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
  requireMfa: vi.fn(() => async (c: any, next: () => Promise<void>) => {
    const auth = c.get('auth');
    if (!auth) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    if (auth.token?.mfa === false) {
      return c.json({ error: 'MFA required' }, 403);
    }
    await next();
  }),
  hasSatisfiedMfa: vi.fn(() => true),
  requirePermission: vi.fn(() => async (_c: any, next: () => Promise<void>) => next()),
}));

import { Hono } from 'hono';
import { adminRoutes } from './index';
import { createAuditLog } from '../../services/auditService';

type FakeAuth = {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  token: { mfa: boolean };
};

function buildApp(authToInject: FakeAuth | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (authToInject) {
      c.set('auth', authToInject as never);
    }
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const platformAdminAuth: FakeAuth = {
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: true },
};

const platformAdminAuthNoMfa: FakeAuth = {
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: false },
};

const partnerAdminAuth: FakeAuth = {
  user: { id: 'pa-1', email: 'partner@synthetic.test', name: 'PartnerAdmin', isPlatformAdmin: false },
  token: { mfa: true },
};

// Synthetic fixture ids (valid UUIDs — the routes validate the format).
const SIG_A = '11111111-1111-4111-8111-111111111111';
const SIG_B = '22222222-2222-4222-8222-222222222222';
const SIG_MISSING = '99999999-9999-4999-8999-999999999999';
const PARTNER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeSignalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SIG_A,
    partnerId: PARTNER_1,
    signalKey: 'heuristic.device_churn',
    severity: 'alert',
    score: 42.5,
    evidence: { deviceCount: 7 },
    firstFiredAt: new Date('2026-07-20T00:00:00Z'),
    computedAt: new Date('2026-07-24T00:00:00Z'),
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    deliveredAt: null,
    ...overrides,
  };
}

function resetState() {
  dbState.selectQueue = [];
  dbState.updateQueue = [];
  dbState.wheres = [];
  dbState.updateWheres = [];
  dbState.setValues = [];
  dbState.limits = [];
  dbState.offsets = [];
}

// The schema mock replaces columns with string tokens, so Drizzle condition
// trees serialize to inspectable JSON containing those tokens plus the SQL
// operator chunks ('is null' / 'is not null').
const asStr = (cond: unknown) => JSON.stringify(cond) ?? 'undefined';

describe('admin/signals — auth gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it('rejects non-platform-admin callers on list (403)', async () => {
    const app = buildApp(partnerAdminAuth);
    const res = await app.request('/admin/signals');
    expect(res.status).toBe(403);
    expect(dbState.wheres).toHaveLength(0);
  });

  it('rejects unauthenticated callers on list (403)', async () => {
    const app = buildApp(null);
    const res = await app.request('/admin/signals');
    expect(res.status).toBe(403);
  });

  it('rejects non-platform-admin callers on acknowledge (403)', async () => {
    const app = buildApp(partnerAdminAuth);
    const res = await app.request(`/admin/signals/${SIG_A}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(dbState.setValues).toHaveLength(0);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('rejects non-platform-admin callers on acknowledge-bulk (403)', async () => {
    const app = buildApp(partnerAdminAuth);
    const res = await app.request('/admin/signals/acknowledge-bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [SIG_A] }),
    });
    expect(res.status).toBe(403);
    expect(dbState.setValues).toHaveLength(0);
  });

  it('rejects acknowledge when MFA is not satisfied (403)', async () => {
    const app = buildApp(platformAdminAuthNoMfa);
    const res = await app.request(`/admin/signals/${SIG_A}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('MFA required');
    expect(dbState.setValues).toHaveLength(0);
  });
});

describe('admin/signals — GET list filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it('defaults to open signals (resolved_at IS NULL AND acknowledged_at IS NULL)', async () => {
    dbState.selectQueue.push([makeSignalRow()]);
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { signals: Array<Record<string, unknown>>; limit: number; offset: number };
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]).toMatchObject({
      id: SIG_A,
      partnerId: PARTNER_1,
      signalKey: 'heuristic.device_churn',
      severity: 'alert',
      score: 42.5,
      evidence: { deviceCount: 7 },
      resolvedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      deliveredAt: null,
    });
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(dbState.limits).toEqual([50]);
    expect(dbState.offsets).toEqual([0]);

    const where = asStr(dbState.wheres[0]);
    expect(where).toContain('pas.resolvedAt');
    expect(where).toContain('pas.acknowledgedAt');
    expect(where).toContain('is null');
    expect(where).not.toContain('is not null');
  });

  it('status=acknowledged filters to acknowledged_at IS NOT NULL (still unresolved)', async () => {
    dbState.selectQueue.push([]);
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals?status=acknowledged');
    expect(res.status).toBe(200);

    const where = asStr(dbState.wheres[0]);
    expect(where).toContain('pas.resolvedAt');
    expect(where).toContain('pas.acknowledgedAt');
    expect(where).toContain('is not null');
  });

  it('status=resolved filters on resolved_at IS NOT NULL only', async () => {
    dbState.selectQueue.push([]);
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals?status=resolved');
    expect(res.status).toBe(200);

    const where = asStr(dbState.wheres[0]);
    expect(where).toContain('pas.resolvedAt');
    expect(where).toContain('is not null');
    expect(where).not.toContain('pas.acknowledgedAt');
  });

  it('status=all with no other filters applies no where clause', async () => {
    dbState.selectQueue.push([]);
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals?status=all');
    expect(res.status).toBe(200);
    expect(dbState.wheres).toEqual([undefined]);
  });

  it('applies partnerId and signalKey prefix filters (LIKE wildcards escaped)', async () => {
    dbState.selectQueue.push([]);
    const app = buildApp(platformAdminAuth);
    const res = await app.request(
      `/admin/signals?partnerId=${PARTNER_1}&signalKey=invariant.100%25_churn`,
    );
    expect(res.status).toBe(200);

    const where = asStr(dbState.wheres[0]);
    expect(where).toContain('pas.partnerId');
    expect(where).toContain(PARTNER_1);
    // '100%_churn' prefix → wildcards escaped, trailing % appended for prefix match.
    expect(where).toContain('invariant.100\\\\%\\\\_churn%');
  });

  it('respects limit/offset and caps limit at 200 (400 beyond)', async () => {
    dbState.selectQueue.push([]);
    const app = buildApp(platformAdminAuth);
    const ok = await app.request('/admin/signals?limit=200&offset=25');
    expect(ok.status).toBe(200);
    expect(dbState.limits).toEqual([200]);
    expect(dbState.offsets).toEqual([25]);

    const tooBig = await app.request('/admin/signals?limit=201');
    expect(tooBig.status).toBe(400);
  });

  it('400s on an invalid status value', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals?status=bogus');
    expect(res.status).toBe(400);
  });
});

describe('admin/signals — POST :id/acknowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it('acknowledges an open signal: writes acknowledged_at + acknowledged_by, audits', async () => {
    const ackedRow = makeSignalRow({
      acknowledgedAt: new Date('2026-07-24T12:00:00Z'),
      acknowledgedBy: 'admin@breeze.test',
    });
    dbState.updateQueue.push([ackedRow]);

    const app = buildApp(platformAdminAuth);
    const res = await app.request(`/admin/signals/${SIG_A}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { signal: Record<string, unknown>; alreadyAcknowledged: boolean };
    expect(body.alreadyAcknowledged).toBe(false);
    expect(body.signal.acknowledgedBy).toBe('admin@breeze.test');
    expect(body.signal.acknowledgedAt).toBeTruthy();

    // Both columns written from the auth context, guarded on unacked rows only.
    expect(dbState.setValues).toHaveLength(1);
    expect(dbState.setValues[0]!.acknowledgedAt).toBeInstanceOf(Date);
    expect(dbState.setValues[0]!.acknowledgedBy).toBe('admin@breeze.test');
    const updateWhere = asStr(dbState.updateWheres[0]);
    expect(updateWhere).toContain('pas.id');
    expect(updateWhere).toContain('pas.acknowledgedAt');
    expect(updateWhere).toContain('is null');

    expect(createAuditLog).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(createAuditLog).mock.calls[0]![0]!;
    expect(auditCall.action).toBe('abuse_signal.acknowledged');
    expect(auditCall.resourceId).toBe(SIG_A);
    expect(auditCall.result).toBe('success');
    expect(auditCall.details).toMatchObject({
      partnerId: PARTNER_1,
      signalKey: 'heuristic.device_churn',
    });
  });

  it('re-acknowledging is an idempotent no-op success returning current state', async () => {
    const originalAck = new Date('2026-07-21T00:00:00Z');
    dbState.updateQueue.push([]); // guarded UPDATE matches nothing
    dbState.selectQueue.push([
      makeSignalRow({ acknowledgedAt: originalAck, acknowledgedBy: 'first-responder@breeze.test' }),
    ]);

    const app = buildApp(platformAdminAuth);
    const res = await app.request(`/admin/signals/${SIG_A}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { signal: Record<string, unknown>; alreadyAcknowledged: boolean };
    expect(body.alreadyAcknowledged).toBe(true);
    // Current state preserved — the original acknowledger is NOT overwritten.
    expect(body.signal.acknowledgedBy).toBe('first-responder@breeze.test');
    expect(body.signal.acknowledgedAt).toBe(originalAck.toISOString());
    // No-op path writes no audit row.
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('404s for an unknown signal id', async () => {
    dbState.updateQueue.push([]);
    dbState.selectQueue.push([]);

    const app = buildApp(platformAdminAuth);
    const res = await app.request(`/admin/signals/${SIG_MISSING}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('signal not found');
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('400s on a non-UUID id without touching the database', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals/not-a-uuid/acknowledge', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(dbState.setValues).toHaveLength(0);
    expect(dbState.wheres).toHaveLength(0);
  });
});

describe('admin/signals — POST acknowledge-bulk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it('handles mixed known/already-acked/unknown ids with per-id results', async () => {
    // SIG_A is open → acknowledged by the guarded UPDATE.
    dbState.updateQueue.push([{ id: SIG_A }]);
    // Of the remainder, SIG_B exists (already acked), SIG_MISSING does not.
    dbState.selectQueue.push([{ id: SIG_B }]);

    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals/acknowledge-bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [SIG_A, SIG_B, SIG_MISSING] }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      results: Array<{ id: string; status: string }>;
      acknowledgedCount: number;
    };
    expect(body.acknowledgedCount).toBe(1);
    expect(body.results).toEqual([
      { id: SIG_A, status: 'acknowledged' },
      { id: SIG_B, status: 'already_acknowledged' },
      { id: SIG_MISSING, status: 'not_found' },
    ]);

    // Single guarded UPDATE carrying both columns.
    expect(dbState.setValues).toHaveLength(1);
    expect(dbState.setValues[0]!.acknowledgedAt).toBeInstanceOf(Date);
    expect(dbState.setValues[0]!.acknowledgedBy).toBe('admin@breeze.test');
    const updateWhere = asStr(dbState.updateWheres[0]);
    expect(updateWhere).toContain('pas.acknowledgedAt');
    expect(updateWhere).toContain('is null');

    expect(createAuditLog).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(createAuditLog).mock.calls[0]![0]!;
    expect(auditCall.action).toBe('abuse_signal.bulk_acknowledged');
    expect(auditCall.details).toMatchObject({
      requestedCount: 3,
      acknowledgedCount: 1,
      acknowledgedIds: [SIG_A],
    });
  });

  it('is a no-op success (no audit) when every id was already acknowledged', async () => {
    dbState.updateQueue.push([]);
    dbState.selectQueue.push([{ id: SIG_A }, { id: SIG_B }]);

    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals/acknowledge-bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [SIG_A, SIG_B] }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { results: Array<{ status: string }>; acknowledgedCount: number };
    expect(body.acknowledgedCount).toBe(0);
    expect(body.results.every((r) => r.status === 'already_acknowledged')).toBe(true);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('deduplicates repeated ids in the request body', async () => {
    dbState.updateQueue.push([{ id: SIG_A }]);
    // No remaining ids → no follow-up select needed.

    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals/acknowledge-bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [SIG_A, SIG_A, SIG_A] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ id: string; status: string }> };
    expect(body.results).toEqual([{ id: SIG_A, status: 'acknowledged' }]);
    // The dedup means no leftover ids, so no existence-check select fired.
    expect(dbState.wheres).toHaveLength(0);
  });

  it('400s on an empty ids array', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals/acknowledge-bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    expect(res.status).toBe(400);
    expect(dbState.setValues).toHaveLength(0);
  });

  it('400s when more than 100 ids are supplied', async () => {
    const ids = Array.from({ length: 101 }, (_, i) =>
      `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
    );
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals/acknowledge-bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    expect(res.status).toBe(400);
    expect(dbState.setValues).toHaveLength(0);
  });

  it('400s on non-UUID ids', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/signals/acknowledge-bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['nope'] }),
    });
    expect(res.status).toBe(400);
    expect(dbState.setValues).toHaveLength(0);
  });
});
