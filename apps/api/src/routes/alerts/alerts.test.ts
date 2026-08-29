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
 * `hideAiNoise`'s WHERE-clause correctness (the actual point of requirement
 * A.2) is proven separately, via compiled SQL against the REAL drizzle-orm +
 * schema, in `alerts.hideAiNoise.sql.test.ts` — that needs `notExists(...)`
 * to build a genuine `SQLWrapper`, which the hand-rolled predicate mock in
 * THIS file (below) cannot produce. Tests here therefore never pass
 * `hideAiNoise=true`; they only assert the query-schema field parses.
 */

const { authRef, dbState, latestVerdictsForAlertsMock, projectAlertAiVerdictSummaryMock, getAlertWithOrgCheckMock } = vi.hoisted(() => {
  const dbState = {
    selectQueue: [] as unknown[][],
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
    where: vi.fn(() => builder),
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
  suggestedIntentId: null,
  createdAt: '2026-09-22T10:00:00.000Z',
};

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

    expect(body.data[0]!.aiVerdict).toEqual(VERDICT_DTO);
    expect(projectAlertAiVerdictSummaryMock).toHaveBeenCalledWith(verdictRow);
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

  it('accepts the hideAiNoise query param without rejecting the request (WHERE-clause correctness is proven in alerts.hideAiNoise.sql.test.ts)', async () => {
    dbState.selectQueue.push([{ count: 0 }]);
    dbState.selectQueue.push([]);

    const res = await makeApp().request('/alerts?hideAiNoise=true');
    expect(res.status).toBe(200);
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

    expect(body.aiVerdict).toEqual(VERDICT_DTO);
    expect(projectAlertAiVerdictSummaryMock).toHaveBeenCalledWith(verdictRow);
  });
});
