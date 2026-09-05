import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Phase 2 wave P2-1 (alert verdicts), Task 14 — `GET /alerts` (list) and
 * `GET /alerts/:id` (detail) each attach `aiVerdict`.
 *
 * `../../services/aiAgents/alertVerdicts` is mocked directly rather than
 * modelling `ai_alert_verdicts` rows in the fake db below: `latestVerdictsForAlerts`
 * already has its own dedicated, fully-covered unit suite
 * (`services/aiAgents/alertVerdicts.test.ts`) — this file only needs to prove
 * the ROUTE calls it with the right arguments and places the result under
 * `aiVerdict`, not re-prove its own internal query correctness.
 *
 * `hideAiNoise`'s WHERE-clause CORRECTNESS (the actual NOT EXISTS/superseded_by/
 * classification-list SQL, requirement A.2) is proven separately, via compiled
 * SQL against the REAL drizzle-orm + schema, in `alerts.hideAiNoise.sql.test.ts`
 * — that needs `notExists(...)` to build a genuine `SQLWrapper`, which the
 * hand-rolled predicate mock in THIS file (below) cannot produce.
 *
 * What THIS file proves about `hideAiNoise` is narrower but load-bearing on
 * its own: that the ROUTE actually calls `hideAiNoiseCondition()` and folds
 * it into the WHERE clause when the param is `true`, and does NOT when it
 * is absent — i.e. the wiring, not the SQL shape. `notExists` is mocked
 * (below) as `(subq) => ({ op: 'notExists', subq })`, and every `.where(...)`
 * call on the fake db is captured into `dbState.whereCalls`, so a test can
 * assert an `op: 'notExists'` node is (or is not) present in the captured
 * predicate tree without needing the real SQL compiler.
 */

const { authRef, dbState, latestVerdictsForAlertsMock, projectAlertAiVerdictSummaryMock, getAlertWithOrgCheckMock } = vi.hoisted(() => {
  const dbState = {
    selectQueue: [] as unknown[][],
    // Every predicate passed to `.where(...)` on the fake db, in call
    // order — MINOR 2 (fix round 1): lets a test assert an `op: 'notExists'`
    // node is (or is not) present, proving the ROUTE actually wires
    // `hideAiNoiseCondition()` into the query rather than just accepting
    // the query param and doing nothing with it.
    whereCalls: [] as unknown[],
  };
  return {
    authRef: {
      current: {
        scope: 'organization' as string,
        user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
        partnerId: null as string | null,
        orgId: 'org-1' as string | null,
        accessibleOrgIds: null as string[] | null,
        allowedSiteIds: undefined as string[] | undefined,
        canAccessOrg: (_id: string) => true as boolean,
      },
    },
    dbState,
    latestVerdictsForAlertsMock: vi.fn(),
    projectAlertAiVerdictSummaryMock: vi.fn(),
    getAlertWithOrgCheckMock: vi.fn(),
  };
});

function selectBuilder() {
  const builder: Record<string, unknown> = {
    from: vi.fn(() => builder),
    leftJoin: vi.fn(() => builder),
    innerJoin: vi.fn(() => builder),
    where: vi.fn((predicate: unknown) => {
      dbState.whereCalls.push(predicate);
      return builder;
    }),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    offset: vi.fn(() => builder),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(dbState.selectQueue.shift() ?? []).then(resolve, reject),
  };
  return builder;
}

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  ne: (col: unknown, val: unknown) => ({ op: 'ne', col, val }),
  gte: (col: unknown, val: unknown) => ({ op: 'gte', col, val }),
  lte: (col: unknown, val: unknown) => ({ op: 'lte', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  notExists: (subq: unknown) => ({ op: 'notExists', subq }),
  sql: Object.assign(() => ({ op: 'sql' }), { raw: () => ({ op: 'sql' }) }),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
  requireScope: () => async (c: { set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => Response }, next: () => Promise<void>) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
  siteAccessCheck: (allowedSiteIds?: string[]) => (siteId: string | null | undefined) => {
    if (!allowedSiteIds) return true;
    if (!siteId) return false;
    return allowedSiteIds.includes(siteId);
  },
}));

vi.mock('../../db', () => ({
  db: { select: vi.fn(() => selectBuilder()) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../db/schema', () => ({
  aiAlertVerdicts: {}, alertCorrelationGroups: {}, alertCorrelationMembers: {},
  alertRules: {}, alertTemplates: {}, alerts: {}, notificationChannels: {},
  alertNotifications: {}, devices: {}, organizations: {}, tickets: {}, ticketAlertLinks: {},
  // #4445 — actorNames.ts (real implementation, not mocked here) selects
  // `users.id`/`users.name`; without this the feedbackByName lookup throws
  // on an undefined `users` and silently degrades via withAlertActorNames'
  // own catch, masking every feedbackByName test behind a false null.
  users: { id: 'id', name: 'name' },
}));
vi.mock('../../services/alertCooldown', () => ({
  setCooldown: vi.fn(), markConfigPolicyRuleCooldown: vi.fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: vi.fn(), emitCorrelationFeedback: vi.fn(),
}));
vi.mock('../../services/ticketService', () => ({
  createTicketFromAlert: vi.fn(),
  TicketServiceError: class TicketServiceError extends Error { status = 400; },
}));
vi.mock('../../services/aiAgents/alertVerdicts', () => ({
  latestVerdictsForAlerts: latestVerdictsForAlertsMock,
  projectAlertAiVerdictSummary: projectAlertAiVerdictSummaryMock,
}));
vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getAlertWithOrgCheck: getAlertWithOrgCheckMock,
}));

import { alertsRoutes } from './alerts';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', alertsRoutes);
  return app;
}

/**
 * Walks the mocked drizzle-orm predicate tree (`{op:'and'|'or', args:[...]}`
 * nodes wrapping leaf nodes like `{op:'notExists', subq}`) looking for a
 * `notExists` node. MINOR 2 (fix round 1) — the whole point of this helper
 * is to make "was hideAiNoiseCondition() actually wired into the WHERE
 * clause" a real, checkable question in this file's tests, instead of just
 * asserting the request didn't 400.
 */
function containsNotExists(predicate: unknown): boolean {
  if (!predicate || typeof predicate !== 'object') return false;
  const node = predicate as { op?: string; args?: unknown[] };
  if (node.op === 'notExists') return true;
  if ((node.op === 'and' || node.op === 'or') && Array.isArray(node.args)) {
    return node.args.some(containsNotExists);
  }
  return false;
}

/**
 * #4446 — the correlation-metadata read's WHERE is the ONLY `and(...)` in this
 * handler whose every arg is an `inArray` leaf (the list-query `whereCondition`
 * always carries an `ne`/`eq` alongside), so this identifies it without relying
 * on `whereCalls` ordering. Returns each such node's `vals` arrays in arg order.
 *
 * The mocked `../../db/schema` stubs tables as bare `{}`, so `col` is
 * `undefined` here and this file cannot say WHICH column each leaf pins — that
 * is what `alerts.hideAiNoise.sql.test.ts` compiles real SQL to prove. What
 * this file uniquely proves is the ROUTE wiring: that
 * `correlationMetadataCondition(orgIdsForPage, alertIds)` is the predicate that
 * actually reaches `.where()`, org array and all, rather than the unpinned
 * `inArray(alertCorrelationMembers.alertId, alertIds)` it replaced.
 */
function inArrayOnlyAndNodes(): unknown[][] {
  return dbState.whereCalls
    .filter((predicate): predicate is { op: 'and'; args: { op: string; vals: unknown[] }[] } => {
      if (!predicate || typeof predicate !== 'object') return false;
      const node = predicate as { op?: string; args?: unknown[] };
      if (node.op !== 'and' || !Array.isArray(node.args) || node.args.length === 0) return false;
      return node.args.every((arg) => (arg as { op?: string } | null)?.op === 'inArray');
    })
    .map((node) => node.args.map((arg) => arg.vals));
}

const ALERT_1 = '11111111-1111-4111-8111-111111111111';
const ALERT_2 = '22222222-2222-4222-8222-222222222222';
const ORG_1 = 'org-1';
const VERDICT_DTO = {
  id: 'verdict-1',
  classification: 'actionable',
  confidence: 0.87,
  rationale: 'Disk usage climbing steadily with no recovery.',
  patternKind: null,
  feedback: null,
  feedbackBy: null,
  suggestedIntentId: null,
  createdAt: '2026-09-22T10:00:00.000Z',
};
// #4445 — the route resolves feedbackByName separately from
// projectAlertAiVerdictSummary (which VERDICT_DTO mocks wholesale) and
// spreads it onto the projected DTO, so the expected shape carries it too.
const VERDICT_DTO_WITH_NAME = { ...VERDICT_DTO, feedbackByName: null };

function baseAlertRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ruleId: null,
    deviceId: null,
    orgId: ORG_1,
    status: 'active',
    severity: 'high',
    title: 'Disk almost full',
    message: 'msg',
    context: null,
    triggeredAt: new Date('2026-09-22T09:00:00.000Z'),
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    suppressedUntil: null,
    createdAt: new Date('2026-09-22T09:00:00.000Z'),
    deviceHostname: null,
    ruleName: null,
    orgName: 'Acme',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectQueue = [];
  dbState.whereCalls = [];
  authRef.current = {
    scope: 'organization',
    user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
    partnerId: null, orgId: ORG_1, accessibleOrgIds: null, allowedSiteIds: undefined,
    canAccessOrg: () => true,
  };
  latestVerdictsForAlertsMock.mockResolvedValue(new Map());
  projectAlertAiVerdictSummaryMock.mockReturnValue(VERDICT_DTO);
});

describe('GET /alerts — aiVerdict (Task 14)', () => {
  it('attaches aiVerdict: null for every alert when no live verdicts exist', async () => {
    dbState.selectQueue.push([{ count: 1 }]); // count
    dbState.selectQueue.push([baseAlertRow(ALERT_1)]); // alertsList
    dbState.selectQueue.push([]); // correlationRows

    const res = await makeApp().request('/alerts');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string; aiVerdict: unknown }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.aiVerdict).toBeNull();
    expect(latestVerdictsForAlertsMock).toHaveBeenCalledWith([ORG_1], [ALERT_1]);
  });

  it('attaches the projected aiVerdict when latestVerdictsForAlerts returns one for the alert', async () => {
    dbState.selectQueue.push([{ count: 1 }]);
    dbState.selectQueue.push([baseAlertRow(ALERT_1)]);
    dbState.selectQueue.push([]);
    const verdictRow = { id: 'verdict-1', alertId: ALERT_1 };
    latestVerdictsForAlertsMock.mockResolvedValue(new Map([[ALERT_1, verdictRow]]));

    const res = await makeApp().request('/alerts');
    const body = await res.json() as { data: Array<{ id: string; aiVerdict: unknown }> };

    expect(body.data[0]!.aiVerdict).toEqual(VERDICT_DTO_WITH_NAME);
    expect(projectAlertAiVerdictSummaryMock).toHaveBeenCalledWith(verdictRow);
  });

  // #4445 review follow-up (pr-test-analyzer) — every prior test here only
  // ever has a SINGLE verdict with an unresolvable (undefined) feedbackBy,
  // so the batched name lookup short-circuits before it ever reaches the
  // fake `users` select, and the per-verdict `Map` merge in the route never
  // actually runs against more than one entry. These two tests exercise the
  // real merge: two different alerts, two different verdicts, two different
  // voters — proving `feedbackByNameByVerdictId.get(verdict.id)` keys off
  // the VERDICT, not alert position/array order.
  it('resolves feedbackByName independently per alert when two alerts carry different verdicts voted by different users', async () => {
    dbState.selectQueue.push([{ count: 2 }]); // count
    dbState.selectQueue.push([baseAlertRow(ALERT_1), baseAlertRow(ALERT_2)]); // alertsList
    dbState.selectQueue.push([]); // correlationRows
    dbState.selectQueue.push([
      { id: 'user-a', name: 'Alice' },
      { id: 'user-b', name: 'Bob' },
    ]); // feedbackBy -> feedbackByName batched lookup

    const verdictA = { id: 'verdict-a', alertId: ALERT_1, feedbackBy: 'user-a' };
    const verdictB = { id: 'verdict-b', alertId: ALERT_2, feedbackBy: 'user-b' };
    latestVerdictsForAlertsMock.mockResolvedValue(
      new Map([[ALERT_1, verdictA], [ALERT_2, verdictB]])
    );
    projectAlertAiVerdictSummaryMock.mockImplementation(
      (verdict: { id: string }) => ({ ...VERDICT_DTO, id: verdict.id })
    );

    const res = await makeApp().request('/alerts');
    const body = await res.json() as {
      data: Array<{ id: string; aiVerdict: { feedbackByName: string | null } }>;
    };

    const byAlertId = Object.fromEntries(body.data.map((a) => [a.id, a.aiVerdict.feedbackByName]));
    expect(byAlertId[ALERT_1]).toBe('Alice');
    expect(byAlertId[ALERT_2]).toBe('Bob');
  });

  it('applies the SAME group verdict feedbackByName to every member alert that shares it', async () => {
    dbState.selectQueue.push([{ count: 2 }]);
    dbState.selectQueue.push([baseAlertRow(ALERT_1), baseAlertRow(ALERT_2)]);
    dbState.selectQueue.push([]); // correlationRows
    // Only ONE distinct user id despite two alerts sharing the verdict —
    // resolveUserDisplayNames dedups via a Set before querying.
    dbState.selectQueue.push([{ id: 'user-a', name: 'Alice' }]);

    const sharedVerdict = { id: 'verdict-shared', feedbackBy: 'user-a' };
    latestVerdictsForAlertsMock.mockResolvedValue(
      new Map([[ALERT_1, sharedVerdict], [ALERT_2, sharedVerdict]])
    );
    projectAlertAiVerdictSummaryMock.mockImplementation(
      (verdict: { id: string }) => ({ ...VERDICT_DTO, id: verdict.id })
    );

    const res = await makeApp().request('/alerts');
    const body = await res.json() as {
      data: Array<{ id: string; aiVerdict: { feedbackByName: string | null } }>;
    };

    expect(body.data.find((a) => a.id === ALERT_1)!.aiVerdict.feedbackByName).toBe('Alice');
    expect(body.data.find((a) => a.id === ALERT_2)!.aiVerdict.feedbackByName).toBe('Alice');
  });

  it('derives orgId(s) for latestVerdictsForAlerts from the loaded rows, not auth alone — a partner-scoped multi-org page widens to an array', async () => {
    const ORG_2 = 'org-2';
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Partner Tech', email: 'tech@partner.example' },
      partnerId: 'partner-1', orgId: null, accessibleOrgIds: [ORG_1, ORG_2], allowedSiteIds: undefined,
      canAccessOrg: () => true,
    };
    dbState.selectQueue.push([{ count: 2 }]);
    dbState.selectQueue.push([
      baseAlertRow(ALERT_1, { orgId: ORG_1 }),
      baseAlertRow(ALERT_2, { orgId: ORG_2 }),
    ]);
    dbState.selectQueue.push([]);

    await makeApp().request('/alerts');

    expect(latestVerdictsForAlertsMock).toHaveBeenCalledWith(
      expect.arrayContaining([ORG_1, ORG_2]),
      expect.arrayContaining([ALERT_1, ALERT_2]),
    );
  });

  // MINOR 2 (fix round 1) — the previous version of this test only
  // asserted `status === 200`, which stays green even if
  // `conditions.push(hideAiNoiseCondition())` were deleted entirely. This
  // asserts the WIRING itself: an `op: 'notExists'` node is present in the
  // captured WHERE predicate tree when (and only when) `hideAiNoise=true`.
  // SQL-shape correctness of that node is proven separately in
  // `alerts.hideAiNoise.sql.test.ts`.
  it('wires hideAiNoiseCondition() into the WHERE clause when hideAiNoise=true', async () => {
    dbState.selectQueue.push([{ count: 0 }]);
    dbState.selectQueue.push([]);

    const res = await makeApp().request('/alerts?hideAiNoise=true');
    expect(res.status).toBe(200);
    expect(dbState.whereCalls.some(containsNotExists)).toBe(true);
  });

  // #4446 — the sibling of the hideAiNoise wiring test above, for the OTHER
  // correlation read on this page. Before the fix this query's WHERE was a bare
  // `inArray(alertCorrelationMembers.alertId, alertIds)` with no org pin at
  // all; a `status === 200` assertion stays green through that revert, and so
  // would a compiled-SQL test of `correlationMetadataCondition` in isolation.
  // Only capturing the ROUTE's actual `.where()` argument catches it.
  it('wires correlationMetadataCondition(orgIdsForPage, alertIds) into the correlation-metadata read', async () => {
    const ORG_2 = 'org-2';
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Partner Tech', email: 'tech@partner.example' },
      partnerId: 'partner-1', orgId: null, accessibleOrgIds: [ORG_1, ORG_2], allowedSiteIds: undefined,
      canAccessOrg: () => true,
    };
    dbState.selectQueue.push([{ count: 2 }]);
    dbState.selectQueue.push([
      baseAlertRow(ALERT_1, { orgId: ORG_1 }),
      baseAlertRow(ALERT_2, { orgId: ORG_2 }),
    ]);
    dbState.selectQueue.push([]); // correlationRows

    await makeApp().request('/alerts');

    // Three `inArray` leaves in `correlationMetadataCondition`'s own order:
    // member org, member alert, group org. The page's org set appearing TWICE
    // is the load-bearing part — that is the pin the pre-#4446 code lacked on
    // BOTH joined rows.
    expect(inArrayOnlyAndNodes()).toContainEqual([
      [ORG_1, ORG_2],
      [ALERT_1, ALERT_2],
      [ORG_1, ORG_2],
    ]);
  });

  it('does NOT add a notExists condition when hideAiNoise is absent', async () => {
    dbState.selectQueue.push([{ count: 1 }]);
    dbState.selectQueue.push([baseAlertRow(ALERT_1)]);
    dbState.selectQueue.push([]);

    const res = await makeApp().request('/alerts');
    expect(res.status).toBe(200);
    expect(dbState.whereCalls.length).toBeGreaterThan(0);
    expect(dbState.whereCalls.some(containsNotExists)).toBe(false);
  });

  it('rejects an invalid hideAiNoise value (zod schema)', async () => {
    const res = await makeApp().request('/alerts?hideAiNoise=yes');
    expect(res.status).toBe(400);
  });
});

describe('GET /alerts/:id — aiVerdict (Task 14)', () => {
  it('returns aiVerdict: null when no live verdict exists for the alert', async () => {
    getAlertWithOrgCheckMock.mockResolvedValue(baseAlertRow(ALERT_1));
    dbState.selectQueue.push([]); // device
    dbState.selectQueue.push([]); // notifications

    const res = await makeApp().request(`/alerts/${ALERT_1}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { aiVerdict: unknown };
    expect(body.aiVerdict).toBeNull();
    expect(latestVerdictsForAlertsMock).toHaveBeenCalledWith(ORG_1, [ALERT_1]);
  });

  it('returns the projected aiVerdict when one exists for the alert', async () => {
    getAlertWithOrgCheckMock.mockResolvedValue(baseAlertRow(ALERT_1));
    dbState.selectQueue.push([]); // device
    dbState.selectQueue.push([]); // notifications
    const verdictRow = { id: 'verdict-1', alertId: ALERT_1 };
    latestVerdictsForAlertsMock.mockResolvedValue(new Map([[ALERT_1, verdictRow]]));

    const res = await makeApp().request(`/alerts/${ALERT_1}`);
    const body = await res.json() as { aiVerdict: unknown };

    expect(body.aiVerdict).toEqual(VERDICT_DTO_WITH_NAME);
    expect(projectAlertAiVerdictSummaryMock).toHaveBeenCalledWith(verdictRow);
  });

  // #4445 review follow-up (pr-test-analyzer) — the test above never gives
  // the verdict a real `feedbackBy`, so it never proves the detail route's
  // name lookup actually resolves a name (only that it no-ops). This drives
  // a non-null feedbackBy through the real `withAlertActorNames` call.
  it('resolves feedbackByName for the single verdict on the detail route', async () => {
    getAlertWithOrgCheckMock.mockResolvedValue(baseAlertRow(ALERT_1));
    dbState.selectQueue.push([]); // device
    dbState.selectQueue.push([]); // notifications
    dbState.selectQueue.push([{ id: 'user-a', name: 'Alice' }]); // feedbackBy -> feedbackByName lookup
    const verdictRow = { id: 'verdict-1', alertId: ALERT_1, feedbackBy: 'user-a' };
    latestVerdictsForAlertsMock.mockResolvedValue(new Map([[ALERT_1, verdictRow]]));

    const res = await makeApp().request(`/alerts/${ALERT_1}`);
    const body = await res.json() as { aiVerdict: { feedbackByName: string | null } };

    expect(body.aiVerdict.feedbackByName).toBe('Alice');
  });
});
