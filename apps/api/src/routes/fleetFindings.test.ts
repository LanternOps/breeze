import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Hoisted db mock: a queue-based `db.select`/`db.update` double. Each
// `db.select(...)` call consumes the next entry in `selectQueue` regardless
// of which chain methods (`from`/`innerJoin`/`leftJoin`/`orderBy`/`limit`/
// `offset`) get called after it — query.ts's exact call sequence per code
// path is deterministic (no conditional branching based on returned data,
// only on `auth.allowedSiteIds`, which each test controls), so a
// call-order queue is simpler and less brittle here than table-identity
// dispatch. `.where(...)` calls are additionally captured so scoping tests
// can assert the actual condition tree built from `auth`.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const updateQueue: unknown[][] = [];
  const capturedWheres: unknown[] = [];
  const capturedUpdates: Record<string, unknown>[] = [];
  // One entry per `db.select(...)` call, in call order — lets a test inspect
  // whether THAT SPECIFIC call chained `.limit(n)` (e.g. the resolved-history
  // fetch cap), without disturbing `capturedWheres`'s existing flat ordering.
  // Each entry is a mutable ref (`{ value }`) so it keeps reporting the
  // captured value even though `.limit()` is called after the entry is
  // pushed.
  const selectCallLimits: Array<{ value: unknown }> = [];

  function makeSelectChain(rows: unknown[], limitRef: { value: unknown }) {
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    chain.from = pass;
    chain.innerJoin = pass;
    chain.leftJoin = pass;
    chain.where = (cond: unknown) => {
      capturedWheres.push(cond);
      return chain;
    };
    chain.orderBy = pass;
    chain.limit = (n: unknown) => {
      limitRef.value = n;
      return chain;
    };
    chain.offset = pass;
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  }

  const mockSelect = vi.fn(() => {
    const limitRef: { value: unknown } = { value: undefined };
    selectCallLimits.push(limitRef);
    return makeSelectChain(selectQueue.shift() ?? [], limitRef);
  });
  const mockUpdate = vi.fn(() => ({
    set: (values: Record<string, unknown>) => {
      capturedUpdates.push(values);
      return {
        where: () => ({
          returning: () => Promise.resolve(updateQueue.shift() ?? []),
        }),
      };
    },
  }));

  return { selectQueue, updateQueue, capturedWheres, capturedUpdates, selectCallLimits, mockSelect, mockUpdate };
});

vi.mock('../db', () => ({ db: { select: h.mockSelect, update: h.mockUpdate } }));

vi.mock('../db/schema', () => ({
  devices: { id: 'd.id', siteId: 'd.siteId', hostname: 'd.hostname', displayName: 'd.displayName', osType: 'd.osType' },
  organizations: { id: 'o.id', name: 'o.name' },
}));

vi.mock('../db/schema/fleetFindings', () => ({
  fleetFindings: {
    id: 'ff.id',
    orgId: 'ff.orgId',
    kind: 'ff.kind',
    semanticKey: 'ff.semanticKey',
    algorithmVersion: 'ff.algorithmVersion',
    status: 'ff.status',
    severity: 'ff.severity',
    title: 'ff.title',
    summary: 'ff.summary',
    evidence: 'ff.evidence',
    deviceCount: 'ff.deviceCount',
    revision: 'ff.revision',
    firstSeenAt: 'ff.firstSeenAt',
    lastSeenAt: 'ff.lastSeenAt',
    lastReconciledAt: 'ff.lastReconciledAt',
    acknowledgedAt: 'ff.acknowledgedAt',
    acknowledgedBy: 'ff.acknowledgedBy',
    dismissedAt: 'ff.dismissedAt',
    dismissedBy: 'ff.dismissedBy',
    dismissNotes: 'ff.dismissNotes',
    resolvedAt: 'ff.resolvedAt',
    resolutionReason: 'ff.resolutionReason',
    createdAt: 'ff.createdAt',
    updatedAt: 'ff.updatedAt',
  },
  fleetFindingDevices: {
    findingId: 'ffd.findingId',
    deviceId: 'ffd.deviceId',
    orgId: 'ffd.orgId',
    sourceKind: 'ffd.sourceKind',
    sourceRowId: 'ffd.sourceRowId',
    memberEvidence: 'ffd.memberEvidence',
    firstSeenAt: 'ffd.firstSeenAt',
    lastSeenAt: 'ffd.lastSeenAt',
  },
  fleetRemediationRuns: {
    id: 'frr.id',
    orgId: 'frr.orgId',
    findingId: 'frr.findingId',
    findingRevision: 'frr.findingRevision',
    actionKind: 'frr.actionKind',
    scriptId: 'frr.scriptId',
    commandType: 'frr.commandType',
    status: 'frr.status',
    targetCount: 'frr.targetCount',
    succeededCount: 'frr.succeededCount',
    failedCount: 'frr.failedCount',
    skippedCount: 'frr.skippedCount',
    createdBy: 'frr.createdBy',
    createdAt: 'frr.createdAt',
    startedAt: 'frr.startedAt',
    completedAt: 'frr.completedAt',
  },
  fleetRemediationRunTargets: {
    runId: 'frt.runId',
    orgId: 'frt.orgId',
    targetDeviceUuid: 'frt.targetDeviceUuid',
    hostnameSnapshot: 'frt.hostnameSnapshot',
    siteIdSnapshot: 'frt.siteIdSnapshot',
    status: 'frt.status',
    deviceCommandId: 'frt.deviceCommandId',
    resultSummary: 'frt.resultSummary',
    skipReason: 'frt.skipReason',
    queuedAt: 'frt.queuedAt',
    completedAt: 'frt.completedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  desc: (column: unknown) => ({ op: 'desc', column }),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

const { createRemediationRunMock, markRunDispatchFailedMock, RemediationRequestErrorMock } = vi.hoisted(() => {
  class RemediationRequestErrorMock extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  }
  return { createRemediationRunMock: vi.fn(), markRunDispatchFailedMock: vi.fn(), RemediationRequestErrorMock };
});

vi.mock('../services/fleetFindings/dispatch', () => ({
  createRemediationRun: createRemediationRunMock,
  markRunDispatchFailed: markRunDispatchFailedMock,
  RemediationRequestError: RemediationRequestErrorMock,
  REMEDIATION_COMMAND_TYPE_ALLOWLIST: ['restart_service', 'reboot'],
}));

const { enqueueRemediationDispatchMock } = vi.hoisted(() => ({ enqueueRemediationDispatchMock: vi.fn() }));
vi.mock('../jobs/fleetRemediationDispatch', () => ({
  enqueueRemediationDispatch: enqueueRemediationDispatchMock,
}));

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

import { fleetFindingsRoutes } from './fleetFindings';
import { writeRouteAudit } from '../services/auditEvents';
import { fleetFindings, fleetRemediationRuns } from '../db/schema/fleetFindings';

const ORG_1 = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '22222222-2222-4222-8222-222222222222';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FINDING_1 = 'f1111111-1111-4111-8111-111111111111';
const DEVICE_1 = 'd1111111-1111-4111-8111-111111111111';
const DEVICE_2 = 'd2222222-2222-4222-8222-222222222222';
const SITE_1 = 's1111111-1111-4111-8111-111111111111';
const SITE_2 = 's2222222-2222-4222-8222-222222222222';
const SCRIPT_1 = 'c1111111-1111-4111-8111-111111111111';

interface AuthOverrides {
  scope?: 'organization' | 'partner' | 'system';
  orgId?: string | null;
  partnerId?: string | null;
  accessibleOrgIds?: string[] | null;
  allowedSiteIds?: string[];
}

function makeAuth(overrides: AuthOverrides = {}) {
  const scope = overrides.scope ?? 'organization';
  const orgId = overrides.orgId !== undefined ? overrides.orgId : scope === 'system' ? null : ORG_1;
  const accessibleOrgIds =
    overrides.accessibleOrgIds !== undefined ? overrides.accessibleOrgIds : scope === 'system' ? null : orgId ? [orgId] : [];
  const allowedSiteIds = overrides.allowedSiteIds;

  return {
    principal: { kind: 'user_session' as const },
    user: { id: USER_ID, email: 'tech@example.test', name: 'Tech', isPlatformAdmin: false },
    token: {} as unknown,
    partnerId: overrides.partnerId ?? null,
    orgId,
    scope,
    accessibleOrgIds,
    orgCondition: (col: unknown) => {
      if (accessibleOrgIds === null) return undefined;
      if (accessibleOrgIds.length === 1) return { op: 'eq', column: col, value: accessibleOrgIds[0] };
      return { op: 'inArray', column: col, values: accessibleOrgIds };
    },
    canAccessOrg: (id: string) => accessibleOrgIds === null || accessibleOrgIds.includes(id),
    allowedSiteIds,
    canAccessSite: (siteId: string | null | undefined) => {
      if (!allowedSiteIds) return true;
      if (!siteId) return false;
      return allowedSiteIds.includes(siteId);
    },
  } as any;
}

function appWithAuth(auth: ReturnType<typeof makeAuth>) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.route('/fleet/findings', fleetFindingsRoutes);
  return a;
}

// Hono sub-routers 404 on a trailing slash, so a bare root request must hit
// `/fleet/findings` (no trailing `/`) — `path` is `/` or `/?query` for the
// list endpoint and `/<id>` for detail/patch.
function urlFor(path: string): string {
  if (path === '/') return '/fleet/findings';
  if (path.startsWith('/?')) return `/fleet/findings${path.slice(1)}`;
  return `/fleet/findings${path}`;
}

function get(auth: ReturnType<typeof makeAuth>, path: string) {
  return appWithAuth(auth).request(urlFor(path));
}

function patch(auth: ReturnType<typeof makeAuth>, path: string, body: unknown) {
  return appWithAuth(auth).request(urlFor(path), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function post(auth: ReturnType<typeof makeAuth>, path: string, body: unknown) {
  return appWithAuth(auth).request(urlFor(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function findingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FINDING_1,
    orgId: ORG_1,
    orgName: 'Acme',
    kind: 'metric_anomaly_pattern',
    semanticKey: 'cpu-high',
    algorithmVersion: 1,
    status: 'open',
    severity: 'warning',
    title: 'High CPU across fleet',
    summary: 'CPU sustained above threshold on multiple devices',
    evidence: {},
    deviceCount: 2,
    revision: 1,
    firstSeenAt: new Date('2026-07-01T00:00:00.000Z'),
    lastSeenAt: new Date('2026-07-02T00:00:00.000Z'),
    lastReconciledAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    dismissedAt: null,
    dismissedBy: null,
    dismissNotes: null,
    resolvedAt: null,
    resolutionReason: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  h.selectQueue.length = 0;
  h.updateQueue.length = 0;
  h.capturedWheres.length = 0;
  h.capturedUpdates.length = 0;
  h.selectCallLimits.length = 0;
  h.mockSelect.mockClear();
  h.mockUpdate.mockClear();
  vi.mocked(writeRouteAudit).mockClear();
  createRemediationRunMock.mockReset();
  markRunDispatchFailedMock.mockReset().mockResolvedValue(undefined);
  enqueueRemediationDispatchMock.mockReset().mockResolvedValue(undefined);
  captureExceptionMock.mockReset();
});

describe('GET /fleet/findings — org scoping', () => {
  it('org-scope token with no ?orgId scopes to its own org via auth.orgCondition', async () => {
    h.selectQueue.push([findingRow()]);

    const res = await get(makeAuth({ scope: 'organization', orgId: ORG_1 }), '/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.findings[0]).toMatchObject({ id: FINDING_1, orgId: ORG_1, orgName: 'Acme' });
    expect(body.findings[0].lastSeenAt).toBe('2026-07-02T00:00:00.000Z');

    const where = h.capturedWheres[0] as { args: unknown[] };
    expect(where.args).toContainEqual({ op: 'eq', column: fleetFindings.orgId, value: ORG_1 });
  });

  it('org-scope token requesting a foreign org via ?orgId is denied without querying', async () => {
    const res = await get(makeAuth({ scope: 'organization', orgId: ORG_1 }), `/?orgId=${ORG_2}`);
    expect(res.status).toBe(403);
    expect(h.mockSelect).not.toHaveBeenCalled();
  });

  it('partner token with no ?orgId sees all accessibleOrgIds', async () => {
    h.selectQueue.push([findingRow({ orgId: ORG_1 }), findingRow({ id: 'f2', orgId: ORG_2 })]);

    const res = await get(makeAuth({ scope: 'partner', orgId: null, accessibleOrgIds: [ORG_1, ORG_2] }), '/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);

    const where = h.capturedWheres[0] as { args: unknown[] };
    expect(where.args).toContainEqual({ op: 'inArray', column: fleetFindings.orgId, values: [ORG_1, ORG_2] });
  });

  it('partner token requesting an org outside accessibleOrgIds is denied', async () => {
    const res = await get(
      makeAuth({ scope: 'partner', orgId: null, accessibleOrgIds: [ORG_1] }),
      `/?orgId=${ORG_2}`
    );
    expect(res.status).toBe(403);
    expect(h.mockSelect).not.toHaveBeenCalled();
  });

  it('partner token requesting an org inside accessibleOrgIds narrows to exactly that org', async () => {
    h.selectQueue.push([findingRow({ orgId: ORG_2 })]);

    const res = await get(
      makeAuth({ scope: 'partner', orgId: null, accessibleOrgIds: [ORG_1, ORG_2] }),
      `/?orgId=${ORG_2}`
    );
    expect(res.status).toBe(200);

    const where = h.capturedWheres[0] as { args: unknown[] };
    expect(where.args).toContainEqual({ op: 'eq', column: fleetFindings.orgId, value: ORG_2 });
  });
});

describe('GET /fleet/findings — status filter', () => {
  it('defaults to open,acknowledged when status is omitted', async () => {
    h.selectQueue.push([findingRow()]);
    await get(makeAuth(), '/');

    const where = h.capturedWheres[0] as { args: unknown[] };
    expect(where.args).toContainEqual({ op: 'inArray', column: fleetFindings.status, values: ['open', 'acknowledged'] });
  });

  it('honors an explicit CSV status filter', async () => {
    h.selectQueue.push([findingRow({ status: 'dismissed' })]);
    await get(makeAuth(), '/?status=dismissed,resolved');

    const where = h.capturedWheres[0] as { args: unknown[] };
    expect(where.args).toContainEqual({ op: 'inArray', column: fleetFindings.status, values: ['dismissed', 'resolved'] });
  });

  it('rejects an unknown status value with 400', async () => {
    const res = await get(makeAuth(), '/?status=bogus');
    expect(res.status).toBe(400);
    expect(h.mockSelect).not.toHaveBeenCalled();
  });
});

describe('GET /fleet/findings — site-restricted callers', () => {
  it('recomputes deviceCount from in-site membership and omits zero-member findings', async () => {
    h.selectQueue.push([
      findingRow({ id: FINDING_1, deviceCount: 2 }),
      findingRow({ id: 'finding-2', deviceCount: 1 }),
    ]);
    // Only FINDING_1 has an in-site member (DEVICE_1); finding-2 has none.
    h.selectQueue.push([{ findingId: FINDING_1, deviceId: DEVICE_1 }]);

    const res = await get(makeAuth({ allowedSiteIds: [SITE_1] }), '/');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total).toBe(1);
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].id).toBe(FINDING_1);
    expect(body.findings[0].deviceCount).toBe(1);
  });

  it('fails closed with an empty allowedSiteIds array (no membership query issued)', async () => {
    h.selectQueue.push([findingRow()]);

    const res = await get(makeAuth({ allowedSiteIds: [] }), '/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ findings: [], total: 0 });
    expect(h.mockSelect).toHaveBeenCalledTimes(1);
  });
});

describe('GET /fleet/findings — pagination', () => {
  function manyRows(count: number) {
    return Array.from({ length: count }, (_, i) => findingRow({ id: `finding-${i}` }));
  }

  it('rejects a limit above 100', async () => {
    const res = await get(makeAuth(), '/?limit=101');
    expect(res.status).toBe(400);
    expect(h.mockSelect).not.toHaveBeenCalled();
  });

  it('defaults to a page size of 50', async () => {
    h.selectQueue.push(manyRows(60));
    const res = await get(makeAuth(), '/');
    const body = await res.json();
    expect(body.total).toBe(60);
    expect(body.findings).toHaveLength(50);
  });

  it('honors an explicit limit', async () => {
    h.selectQueue.push(manyRows(60));
    const res = await get(makeAuth(), '/?limit=10');
    const body = await res.json();
    expect(body.total).toBe(60);
    expect(body.findings).toHaveLength(10);
  });

  it('honors offset', async () => {
    h.selectQueue.push(manyRows(60));
    const res = await get(makeAuth(), '/?limit=10&offset=55');
    const body = await res.json();
    expect(body.findings).toHaveLength(5);
  });
});

describe('GET /fleet/findings — resolved-history fetch is bounded', () => {
  function manyRows(count: number) {
    return Array.from({ length: count }, (_, i) => findingRow({ id: `finding-${i}`, status: 'resolved' }));
  }

  it('does NOT apply a SQL limit when the status filter excludes resolved (live path unchanged)', async () => {
    h.selectQueue.push([findingRow({ status: 'open' })]);
    await get(makeAuth(), '/?status=open');

    expect(h.selectCallLimits[0]!.value).toBeUndefined();
  });

  it('fetches the whole window, not just the requested page, when status includes resolved', async () => {
    h.selectQueue.push(manyRows(30));
    const res = await get(makeAuth(), '/?status=resolved&limit=10&offset=5');
    expect(res.status).toBe(200);

    // Deliberately NOT offset(5) + limit(10) = 15. `total` is derived from this
    // result set, so bounding the fetch at the page boundary would report
    // `total === limit` on every page and strand the pager on page 1.
    expect(h.selectCallLimits[0]!.value).toBe(500);
  });

  it('reports a total spanning the whole window, not the page size', async () => {
    h.selectQueue.push(manyRows(30));
    const res = await get(makeAuth(), '/?status=resolved&limit=10&offset=0');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.findings).toHaveLength(10);
    // The regression this guards: `total` used to equal the page size, so a
    // pager computing ceil(total/limit) saw exactly one page and the remaining
    // 20 resolved findings were unreachable.
    expect(body.total).toBe(30);
  });

  it('never asks the DB for more than the hard cap, even with a huge offset', async () => {
    h.selectQueue.push(manyRows(30));
    const res = await get(makeAuth(), '/?status=resolved&limit=50&offset=1000000');
    expect(res.status).toBe(200);

    expect(h.selectCallLimits[0]!.value).toBe(500);
    const body = await res.json();
    // The requested page is entirely beyond the fetched (windowed) rows —
    // fails closed to an empty page rather than crashing or leaking rows.
    expect(body.findings).toEqual([]);
  });

  it('applies the window cap when resolved is combined with other statuses', async () => {
    h.selectQueue.push(manyRows(5));
    await get(makeAuth(), '/?status=open,resolved&limit=50&offset=0');

    expect(h.selectCallLimits[0]!.value).toBe(500);
  });
});

describe('GET /fleet/findings/:id', () => {
  it('returns 404 for an unknown id', async () => {
    h.selectQueue.push([]);
    const res = await get(makeAuth(), `/${FINDING_1}`);
    expect(res.status).toBe(404);
  });

  it('org token cannot see a finding belonging to a foreign org (404, org-condition applied)', async () => {
    // The real WHERE (org-scoped by RLS/eq) would return nothing for a
    // finding in another org — simulated here by an empty result set.
    h.selectQueue.push([]);
    const res = await get(makeAuth({ scope: 'organization', orgId: ORG_1 }), `/${FINDING_1}`);
    expect(res.status).toBe(404);

    const where = h.capturedWheres[0] as { args: unknown[] };
    expect(where.args).toContainEqual({ op: 'eq', column: fleetFindings.orgId, value: ORG_1 });
  });

  it('partner token cannot see a finding outside its accessibleOrgIds (404, inArray condition applied)', async () => {
    h.selectQueue.push([]);
    const res = await get(
      makeAuth({ scope: 'partner', orgId: null, accessibleOrgIds: [ORG_1, ORG_2] }),
      `/${FINDING_1}`
    );
    expect(res.status).toBe(404);

    const where = h.capturedWheres[0] as { args: unknown[] };
    expect(where.args).toContainEqual({ op: 'inArray', column: fleetFindings.orgId, values: [ORG_1, ORG_2] });
  });

  it('assembles finding + members + runs for an unrestricted caller', async () => {
    h.selectQueue.push([findingRow()]);
    h.selectQueue.push([
      {
        deviceId: DEVICE_1,
        sourceKind: 'metric_anomaly',
        sourceRowId: 'anomaly-1',
        memberEvidence: { p95: 92 },
        firstSeenAt: new Date('2026-07-01T00:00:00.000Z'),
        lastSeenAt: new Date('2026-07-02T00:00:00.000Z'),
        hostname: 'WS-01',
        displayName: null,
        siteId: SITE_1,
        osType: 'windows',
      },
    ]);
    h.selectQueue.push([
      {
        id: 'run-1',
        actionKind: 'script',
        scriptId: 'script-1',
        commandType: null,
        status: 'succeeded',
        targetCount: 1,
        succeededCount: 1,
        failedCount: 0,
        skippedCount: 0,
        createdBy: USER_ID,
        createdAt: new Date('2026-07-03T00:00:00.000Z'),
        startedAt: new Date('2026-07-03T00:01:00.000Z'),
        completedAt: new Date('2026-07-03T00:02:00.000Z'),
      },
    ]);

    const res = await get(makeAuth(), `/${FINDING_1}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(FINDING_1);
    expect(body.deviceCount).toBe(1);
    expect(body.members).toEqual([
      expect.objectContaining({ deviceId: DEVICE_1, hostname: 'WS-01', siteId: SITE_1, osType: 'windows' }),
    ]);
    expect(body.runs).toEqual([expect.objectContaining({ id: 'run-1', status: 'succeeded' })]);
  });

  it('site-restricted caller sees only in-site members with a recomputed deviceCount', async () => {
    h.selectQueue.push([findingRow({ deviceCount: 2 })]);
    h.selectQueue.push([
      {
        deviceId: DEVICE_1,
        sourceKind: 'metric_anomaly',
        sourceRowId: null,
        memberEvidence: {},
        firstSeenAt: new Date('2026-07-01T00:00:00.000Z'),
        lastSeenAt: new Date('2026-07-02T00:00:00.000Z'),
        hostname: 'WS-01',
        displayName: null,
        siteId: SITE_1,
        osType: 'windows',
      },
      {
        deviceId: DEVICE_2,
        sourceKind: 'metric_anomaly',
        sourceRowId: null,
        memberEvidence: {},
        firstSeenAt: new Date('2026-07-01T00:00:00.000Z'),
        lastSeenAt: new Date('2026-07-02T00:00:00.000Z'),
        hostname: 'WS-02',
        displayName: null,
        siteId: SITE_2,
        osType: 'macos',
      },
    ]);
    h.selectQueue.push([]);

    const res = await get(makeAuth({ allowedSiteIds: [SITE_1] }), `/${FINDING_1}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deviceCount).toBe(1);
    expect(body.members).toHaveLength(1);
    expect(body.members[0].deviceId).toBe(DEVICE_1);
  });

  it('hides a finding entirely when the site-restricted caller has zero in-site members (fail closed)', async () => {
    h.selectQueue.push([findingRow()]);
    h.selectQueue.push([
      {
        deviceId: DEVICE_2,
        sourceKind: 'metric_anomaly',
        sourceRowId: null,
        memberEvidence: {},
        firstSeenAt: new Date('2026-07-01T00:00:00.000Z'),
        lastSeenAt: new Date('2026-07-02T00:00:00.000Z'),
        hostname: 'WS-02',
        displayName: null,
        siteId: SITE_2,
        osType: 'windows',
      },
    ]);

    const res = await get(makeAuth({ allowedSiteIds: [SITE_1] }), `/${FINDING_1}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /fleet/findings/:id — lifecycle transitions', () => {
  it('returns 404 for an unknown id', async () => {
    h.selectQueue.push([]);
    const res = await patch(makeAuth(), `/${FINDING_1}`, { action: 'acknowledge' });
    expect(res.status).toBe(404);
  });

  it('org token cannot act on a finding belonging to a foreign org (404, org-condition applied, no update issued)', async () => {
    h.selectQueue.push([]);
    const res = await patch(makeAuth({ scope: 'organization', orgId: ORG_1 }), `/${FINDING_1}`, {
      action: 'acknowledge',
    });
    expect(res.status).toBe(404);
    expect(h.mockUpdate).not.toHaveBeenCalled();

    const where = h.capturedWheres[0] as { args: unknown[] };
    expect(where.args).toContainEqual({ op: 'eq', column: fleetFindings.orgId, value: ORG_1 });
  });

  it('partner token cannot act on a finding outside its accessibleOrgIds (404, inArray condition applied, no update issued)', async () => {
    h.selectQueue.push([]);
    const res = await patch(
      makeAuth({ scope: 'partner', orgId: null, accessibleOrgIds: [ORG_1, ORG_2] }),
      `/${FINDING_1}`,
      { action: 'acknowledge' }
    );
    expect(res.status).toBe(404);
    expect(h.mockUpdate).not.toHaveBeenCalled();

    const where = h.capturedWheres[0] as { args: unknown[] };
    expect(where.args).toContainEqual({ op: 'inArray', column: fleetFindings.orgId, values: [ORG_1, ORG_2] });
  });

  // Site-axis parity with the read paths. The org condition alone is not
  // enough: a site-restricted tech shares an org with findings whose members
  // all sit in sites they cannot see. GET omits those, so PATCH must 404 on
  // them too — otherwise a finding that is invisible on read is still
  // acknowledgeable, and the 200 body hands back its evidence.
  it('site-restricted caller gets 404 when no member device is in an allowed site (no update issued)', async () => {
    h.selectQueue.push([findingRow({ status: 'open' })]);
    h.selectQueue.push([]); // membership probe finds nothing in scope

    const res = await patch(makeAuth({ allowedSiteIds: [SITE_1] }), `/${FINDING_1}`, {
      action: 'acknowledge',
    });

    expect(res.status).toBe(404);
    expect(h.mockUpdate).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('site-restricted caller with an in-scope member device may act', async () => {
    h.selectQueue.push([findingRow({ status: 'open' })]);
    h.selectQueue.push([{ deviceId: 'device-in-scope' }]);
    h.updateQueue.push([findingRow({ status: 'acknowledged', acknowledgedAt: new Date(), acknowledgedBy: USER_ID })]);

    const res = await patch(makeAuth({ allowedSiteIds: [SITE_1] }), `/${FINDING_1}`, {
      action: 'acknowledge',
    });

    expect(res.status).toBe(200);
    expect(h.capturedUpdates[0]!.status).toBe('acknowledged');
  });

  it('fails closed for an empty allowedSiteIds array without issuing a membership probe', async () => {
    h.selectQueue.push([findingRow({ status: 'open' })]);

    const res = await patch(makeAuth({ allowedSiteIds: [] }), `/${FINDING_1}`, {
      action: 'acknowledge',
    });

    expect(res.status).toBe(404);
    expect(h.mockUpdate).not.toHaveBeenCalled();
    // Only the finding lookup ran — an empty allowlist can never match.
    expect(h.mockSelect).toHaveBeenCalledTimes(1);
  });

  it('acknowledge: open -> acknowledged stamps the actor and timestamp', async () => {
    h.selectQueue.push([findingRow({ status: 'open' })]);
    h.updateQueue.push([findingRow({ status: 'acknowledged', acknowledgedAt: new Date(), acknowledgedBy: USER_ID })]);

    const res = await patch(makeAuth(), `/${FINDING_1}`, { action: 'acknowledge' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('acknowledged');

    const update = h.capturedUpdates[0]!;
    expect(update.status).toBe('acknowledged');
    expect(update.acknowledgedBy).toBe(USER_ID);
    expect(update.acknowledgedAt).toBeInstanceOf(Date);
    expect(update.updatedAt).toBeInstanceOf(Date);

    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'fleet_finding.acknowledge', resourceId: FINDING_1, orgId: ORG_1 })
    );
  });

  it.each([['acknowledged'], ['dismissed'], ['resolved']])('acknowledge from %s is rejected with 400', async (status) => {
    h.selectQueue.push([findingRow({ status })]);
    const res = await patch(makeAuth(), `/${FINDING_1}`, { action: 'acknowledge' });
    expect(res.status).toBe(400);
    expect(h.mockUpdate).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it.each([['open'], ['acknowledged']])('dismiss: %s -> dismissed stores notes', async (status) => {
    h.selectQueue.push([findingRow({ status })]);
    h.updateQueue.push([findingRow({ status: 'dismissed', dismissedBy: USER_ID, dismissNotes: 'known false positive' })]);

    const res = await patch(makeAuth(), `/${FINDING_1}`, { action: 'dismiss', notes: 'known false positive' });
    expect(res.status).toBe(200);

    const update = h.capturedUpdates[0]!;
    expect(update.status).toBe('dismissed');
    expect(update.dismissedBy).toBe(USER_ID);
    expect(update.dismissNotes).toBe('known false positive');
  });

  it.each([['dismissed'], ['resolved']])('dismiss from %s is rejected with 400', async (status) => {
    h.selectQueue.push([findingRow({ status })]);
    const res = await patch(makeAuth(), `/${FINDING_1}`, { action: 'dismiss' });
    expect(res.status).toBe(400);
    expect(h.mockUpdate).not.toHaveBeenCalled();
  });

  it.each([['acknowledged'], ['dismissed']])('reopen: %s -> open clears prior lifecycle stamps', async (status) => {
    h.selectQueue.push([findingRow({ status, acknowledgedBy: USER_ID, dismissedBy: USER_ID })]);
    h.updateQueue.push([findingRow({ status: 'open' })]);

    const res = await patch(makeAuth(), `/${FINDING_1}`, { action: 'reopen' });
    expect(res.status).toBe(200);

    const update = h.capturedUpdates[0]!;
    expect(update.status).toBe('open');
    expect(update.acknowledgedAt).toBeNull();
    expect(update.acknowledgedBy).toBeNull();
    expect(update.dismissedAt).toBeNull();
    expect(update.dismissedBy).toBeNull();
    expect(update.dismissNotes).toBeNull();
  });

  it.each([['open'], ['resolved']])('reopen from %s is rejected with 400', async (status) => {
    h.selectQueue.push([findingRow({ status })]);
    const res = await patch(makeAuth(), `/${FINDING_1}`, { action: 'reopen' });
    expect(res.status).toBe(400);
    expect(h.mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects an unknown action at the validation layer', async () => {
    const res = await patch(makeAuth(), `/${FINDING_1}`, { action: 'delete' });
    expect(res.status).toBe(400);
    expect(h.mockSelect).not.toHaveBeenCalled();
  });
});

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    orgId: ORG_1,
    findingId: FINDING_1,
    findingRevision: 1,
    actionKind: 'command',
    scriptId: null,
    commandType: 'reboot',
    parameterSnapshot: {},
    status: 'running',
    targetCount: 2,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    createdBy: USER_ID,
    createdAt: new Date('2026-07-03T00:00:00.000Z'),
    startedAt: new Date('2026-07-03T00:01:00.000Z'),
    completedAt: null,
    ...overrides,
  };
}

describe('GET /fleet/findings/runs/:runId', () => {
  it('returns 404 for an unknown run id', async () => {
    h.selectQueue.push([]);
    const res = await get(makeAuth(), '/runs/run-1');
    expect(res.status).toBe(404);
  });

  it('org token cannot see a run belonging to a foreign org (404, org-condition applied)', async () => {
    h.selectQueue.push([]);
    const res = await get(makeAuth({ scope: 'organization', orgId: ORG_1 }), '/runs/run-1');
    expect(res.status).toBe(404);

    const where = h.capturedWheres[0] as { args: unknown[] };
    expect(where.args).toContainEqual({ op: 'eq', column: fleetRemediationRuns.orgId, value: ORG_1 });
  });

  it('assembles the run + its targets for an unrestricted caller', async () => {
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([
      {
        runId: 'run-1',
        orgId: ORG_1,
        targetDeviceUuid: DEVICE_1,
        hostnameSnapshot: 'WS-01',
        siteIdSnapshot: SITE_1,
        status: 'queued',
        deviceCommandId: 'cmd-1',
        resultSummary: null,
        skipReason: null,
        queuedAt: new Date('2026-07-03T00:02:00.000Z'),
        completedAt: null,
      },
    ]);

    const res = await get(makeAuth(), '/runs/run-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('run-1');
    expect(body.targets).toEqual([
      expect.objectContaining({ deviceId: DEVICE_1, hostname: 'WS-01', status: 'queued' }),
    ]);
  });

  it('site-restricted caller sees only in-site targets', async () => {
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([
      {
        runId: 'run-1',
        orgId: ORG_1,
        targetDeviceUuid: DEVICE_1,
        hostnameSnapshot: 'WS-01',
        siteIdSnapshot: SITE_1,
        status: 'queued',
        deviceCommandId: 'cmd-1',
        resultSummary: null,
        skipReason: null,
        queuedAt: null,
        completedAt: null,
      },
      {
        runId: 'run-1',
        orgId: ORG_1,
        targetDeviceUuid: DEVICE_2,
        hostnameSnapshot: 'WS-02',
        siteIdSnapshot: SITE_2,
        status: 'queued',
        deviceCommandId: 'cmd-2',
        resultSummary: null,
        skipReason: null,
        queuedAt: null,
        completedAt: null,
      },
    ]);

    const res = await get(makeAuth({ allowedSiteIds: [SITE_1] }), '/runs/run-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0].deviceId).toBe(DEVICE_1);
  });
});

describe('GET /fleet/findings/:id/runs', () => {
  it('returns 404 for an unknown finding id', async () => {
    h.selectQueue.push([]);
    const res = await get(makeAuth(), `/${FINDING_1}/runs`);
    expect(res.status).toBe(404);
  });

  it("returns the finding's runs (delegates to getFleetFinding)", async () => {
    h.selectQueue.push([findingRow()]);
    h.selectQueue.push([]); // members
    h.selectQueue.push([runRow({ id: 'run-9' })]); // runs

    const res = await get(makeAuth(), `/${FINDING_1}/runs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toEqual([expect.objectContaining({ id: 'run-9' })]);
  });
});

describe('POST /fleet/findings/:id/remediate', () => {
  it('rejects a non-allowlisted commandType at the zod validation layer (400)', async () => {
    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'command',
      commandType: 'clear_temp_files',
      parameters: {},
    });
    expect(res.status).toBe(400);
    expect(createRemediationRunMock).not.toHaveBeenCalled();
  });

  it('rejects a body carrying BOTH scriptId and commandType (400, not a silent strip)', async () => {
    // Under the old both-optional object this validated, `commandType` was
    // stripped, and the caller was never told which of the two things they
    // asked for actually ran. The discriminated union's `.strict()` branches
    // make it a 400.
    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'script',
      scriptId: SCRIPT_1,
      commandType: 'reboot',
      parameters: {},
    });
    expect(res.status).toBe(400);
    expect(createRemediationRunMock).not.toHaveBeenCalled();
  });

  it('rejects actionKind "script" with no scriptId (400)', async () => {
    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'script',
      parameters: {},
    });
    expect(res.status).toBe(400);
    expect(createRemediationRunMock).not.toHaveBeenCalled();
  });

  it('rejects actionKind "command" with no commandType (400)', async () => {
    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'command',
      parameters: {},
    });
    expect(res.status).toBe(400);
    expect(createRemediationRunMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown actionKind (400)', async () => {
    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'bogus',
      parameters: {},
    });
    expect(res.status).toBe(400);
    expect(createRemediationRunMock).not.toHaveBeenCalled();
  });

  it('rejects a command body carrying a scriptId (400)', async () => {
    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'command',
      commandType: 'reboot',
      scriptId: SCRIPT_1,
      parameters: {},
    });
    expect(res.status).toBe(400);
    expect(createRemediationRunMock).not.toHaveBeenCalled();
  });

  it('rejects a deviceIds array above the 5000-entry bound at the zod validation layer (400)', async () => {
    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: Array.from({ length: 5001 }, () => DEVICE_1),
    });
    expect(res.status).toBe(400);
    expect(createRemediationRunMock).not.toHaveBeenCalled();
  });

  it('rejects an empty deviceIds array at the zod validation layer (400) instead of falling back to "all members"', async () => {
    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [],
    });
    expect(res.status).toBe(400);
    expect(createRemediationRunMock).not.toHaveBeenCalled();
  });

  it('maps a RemediationRequestError to its status (403 when the finding is inaccessible)', async () => {
    createRemediationRunMock.mockRejectedValue(new RemediationRequestErrorMock('Finding not found or access denied', 403));

    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Finding not found or access denied');
    expect(enqueueRemediationDispatchMock).not.toHaveBeenCalled();
  });

  it('creates a run, enqueues dispatch, audits, and returns the skipped list', async () => {
    createRemediationRunMock.mockResolvedValue({
      runId: 'run-1',
      targetCount: 2,
      skipped: [{ deviceId: DEVICE_2, reason: 'decommissioned' }],
      orgId: ORG_1,
    });

    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1, DEVICE_2],
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({
      runId: 'run-1',
      targetCount: 2,
      skipped: [{ deviceId: DEVICE_2, reason: 'decommissioned' }],
    });

    expect(enqueueRemediationDispatchMock).toHaveBeenCalledWith('run-1', 2);
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'fleet_finding.remediate',
        orgId: ORG_1,
        resourceId: FINDING_1,
        details: expect.objectContaining({ runId: 'run-1', targetCount: 2, skippedCount: 1 }),
      })
    );
  });

  it('marks the run dispatch-failed, audits a failure, and returns 502 when enqueueRemediationDispatch throws', async () => {
    createRemediationRunMock.mockResolvedValue({
      runId: 'run-1',
      targetCount: 2,
      skipped: [],
      orgId: ORG_1,
    });
    enqueueRemediationDispatchMock.mockRejectedValue(new Error('Redis unreachable'));

    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
    });

    // The run was already committed by createRemediationRun — surface the
    // failure with its runId so the caller can see/investigate the stranded
    // run, rather than a bare 500 with no way to find it.
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.runId).toBe('run-1');

    expect(markRunDispatchFailedMock).toHaveBeenCalledWith('run-1');
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'fleet_finding.remediate',
        result: 'failure',
        details: expect.objectContaining({ runId: 'run-1', dispatchEnqueueFailed: true }),
      })
    );
  });

  it('still returns the 502 when markRunDispatchFailed itself throws (stranded run stays visible)', async () => {
    // The recovery write can fail for the same reason the enqueue did. If it
    // escapes, the caller gets an opaque 500 that hides the original enqueue
    // failure AND the run stays `queued` with pending targets forever.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createRemediationRunMock.mockResolvedValue({ runId: 'run-1', targetCount: 2, skipped: [], orgId: ORG_1 });
    enqueueRemediationDispatchMock.mockRejectedValue(new Error('Redis unreachable'));
    markRunDispatchFailedMock.mockRejectedValue(new Error('db gone too'));

    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
    });

    expect(res.status).toBe(502);
    expect((await res.json()).runId).toBe('run-1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stranded'), expect.anything());
    errorSpy.mockRestore();
  });

  it('passes the validated body through to createRemediationRun', async () => {
    createRemediationRunMock.mockResolvedValue({ runId: 'run-1', targetCount: 1, skipped: [], orgId: ORG_1 });

    const auth = makeAuth();
    const scriptId = SCRIPT_1;
    const res = await post(auth, `/${FINDING_1}/remediate`, {
      actionKind: 'script',
      scriptId,
      parameters: { foo: 'bar' },
    });

    expect(res.status).toBe(202);
    expect(createRemediationRunMock).toHaveBeenCalledWith(
      expect.anything(),
      FINDING_1,
      expect.objectContaining({ actionKind: 'script', scriptId, parameters: { foo: 'bar' } })
    );
  });

  // #4888 — run context for a fleet-wide remediation run. Script branch only:
  // a `command` run has no script row whose default there would be anything
  // to override.
  it('accepts runAs: "user" on the script branch and forwards it to createRemediationRun', async () => {
    createRemediationRunMock.mockResolvedValue({ runId: 'run-1', targetCount: 1, skipped: [], orgId: ORG_1 });

    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'script',
      scriptId: SCRIPT_1,
      runAs: 'user',
      parameters: {},
    });

    expect(res.status).toBe(202);
    expect(createRemediationRunMock).toHaveBeenCalledWith(
      expect.anything(),
      FINDING_1,
      expect.objectContaining({ actionKind: 'script', scriptId: SCRIPT_1, runAs: 'user' })
    );
  });

  it('rejects runAs: "elevated" on the script branch (400) — elevation is not a launch-time choice', async () => {
    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'script',
      scriptId: SCRIPT_1,
      runAs: 'elevated',
      parameters: {},
    });

    expect(res.status).toBe(400);
    expect(createRemediationRunMock).not.toHaveBeenCalled();
  });

  it('rejects runAs on the command branch (400) — the branch is .strict() with no such field', async () => {
    const res = await post(makeAuth(), `/${FINDING_1}/remediate`, {
      actionKind: 'command',
      commandType: 'reboot',
      runAs: 'user',
      parameters: {},
    });

    expect(res.status).toBe(400);
    expect(createRemediationRunMock).not.toHaveBeenCalled();
  });
});
