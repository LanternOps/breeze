/**
 * Unit tests for the P2-6 impact DTO assembly service (#4193, Task A7).
 *
 * `../../db` is mocked (only `db.select` is stubbed — this file has no
 * persistence path), but `drizzle-orm`'s own combinators (`and`, `eq`, `gte`,
 * `lte`, `isNull`, `sql`) and the real schema table objects are NOT mocked,
 * so the WHERE-clause objects the service builds are genuine Drizzle SQL
 * nodes. Compiling them with `PgDialect().sqlToQuery()` (rather than
 * asserting on mock-call identity) is what makes the "does every statement
 * carry auth.orgCondition" assertions non-vacuous — a regression that drops
 * or mistargets a predicate changes the compiled text, not just a mock's
 * call shape (memory: vacuous Drizzle where-clause assertions).
 *
 * Every counter fixture below gives each of the ten counters a distinct
 * value on a distinct day, so a wrong-column read (e.g. summing
 * `fixesProposed` into `fixesExecuted`) changes the assembled DTO instead of
 * passing silently the way a uniform fixture would (memory: uniform test
 * fixture hides a branch).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  AI_AGENT_IMPACT_BY_ORG_LIMIT,
  DEFAULT_IMPACT_WEIGHTS,
  estimateSecondsSaved,
  type AiAgentImpactCounterKey,
  type ImpactWeights,
} from '@breeze/shared';
import { buildOrgAccessClosures } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';

const { dbSelectMock } = vi.hoisted(() => ({ dbSelectMock: vi.fn() }));
vi.mock('../../db', () => ({ db: { select: dbSelectMock } }));

const { resolveImpactPartnerIdMock, loadImpactWeightsMock } = vi.hoisted(() => ({
  resolveImpactPartnerIdMock: vi.fn(),
  loadImpactWeightsMock: vi.fn(),
}));
vi.mock('./impactWeights', () => ({
  resolveImpactPartnerId: resolveImpactPartnerIdMock,
  loadImpactWeights: loadImpactWeightsMock,
}));

const { countEligibleGraduationsMock } = vi.hoisted(() => ({ countEligibleGraduationsMock: vi.fn() }));
vi.mock('./graduationService', () => ({ countEligibleGraduations: countEligibleGraduationsMock }));

import { ImpactOrgAccessDeniedError, loadImpactSummary } from './impactQuery';
import { lastCompleteUtcDay, shiftUtcDay } from './impactRollup';
import { aiAgentGraduation } from '../../db/schema/aiAgentGraduation';

const PARTNER_ID = '00000000-0000-4000-8000-0000000000a1';
const ORG_A = '00000000-0000-4000-8000-0000000000b1';
const ORG_B = '00000000-0000-4000-8000-0000000000b2';

const compile = (node: unknown) => new PgDialect().sqlToQuery(node as never);

/** A captured `.where()` (and optionally `.groupBy()`/`.innerJoin()`) argument from one mocked select chain. */
interface Captured {
  where?: unknown;
  groupBy?: unknown[];
  innerJoin?: unknown;
}

/** A thenable Drizzle-shaped chain: `.from().innerJoin?().where().groupBy?().orderBy?()`, resolving to `rows`. */
function makeSelectChain<T>(rows: T[], captured: Captured = {}): PromiseLike<T[]> {
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn((_table: unknown, on: unknown) => {
      captured.innerJoin = on;
      return chain;
    }),
    where: vi.fn((cond: unknown) => {
      captured.where = cond;
      return chain;
    }),
    groupBy: vi.fn((...cols: unknown[]) => {
      captured.groupBy = cols;
      return chain;
    }),
    orderBy: vi.fn(() => chain),
    then: (resolve: (v: T[]) => void) => resolve(rows),
  };
  return chain as unknown as PromiseLike<T[]>;
}

const COUNTER_KEYS: AiAgentImpactCounterKey[] = [
  'alertsJudged',
  'noiseFlagged',
  'suppressionsApplied',
  'ticketsTriaged',
  'draftsSent',
  'fixesProposed',
  'fixesExecuted',
  'fixWatchesHeld',
  'fixWatchesRecurred',
  'narrativesDelivered',
];

/** Every counter a distinct value (base+1 .. base+10), plus llmCents = base+11. Non-uniform by construction. */
function counterFields(base: number): Record<AiAgentImpactCounterKey, number> & { llmCents: number } {
  const out = {} as Record<AiAgentImpactCounterKey, number> & { llmCents: number };
  COUNTER_KEYS.forEach((key, i) => {
    out[key] = base + i + 1;
  });
  out.llmCents = base + 11;
  return out;
}

function seriesRow(day: string, base: number, rebuiltAt: Date | string) {
  return { day, ...counterFields(base), rebuiltAt };
}

function orgRow(orgId: string, orgName: string, base: number) {
  return { orgId, orgName, ...counterFields(base) };
}

function makeAuth(overrides: Partial<AuthContext> & { scope: AuthContext['scope']; accessibleOrgIds: string[] | null }): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER_ID,
    orgId: null,
    ...buildOrgAccessClosures(overrides.accessibleOrgIds),
    ...overrides,
  } as unknown as AuthContext;
}

const orgAuth = () => makeAuth({ scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A] });
const partnerAuth = (orgAccess: 'all' | 'selected' = 'all') =>
  makeAuth({ scope: 'partner', accessibleOrgIds: [ORG_A, ORG_B], partnerOrgAccess: orgAccess });
const systemAuth = () => makeAuth({ scope: 'system', partnerId: null, accessibleOrgIds: null });

/** Queue up a series-then-feedback (org/system scope) mock sequence. */
function stubOrgScopeQueries(seriesRows: unknown[], feedbackRows: unknown[], seriesCaptured: Captured = {}, feedbackCaptured: Captured = {}) {
  dbSelectMock
    .mockImplementationOnce(() => makeSelectChain(seriesRows, seriesCaptured))
    .mockImplementationOnce(() => makeSelectChain(feedbackRows, feedbackCaptured));
}

/** Queue up a series-then-byOrg-then-feedback (partner scope) mock sequence. */
function stubPartnerScopeQueries(
  seriesRows: unknown[],
  byOrgRows: unknown[],
  feedbackRows: unknown[],
  seriesCaptured: Captured = {},
  byOrgCaptured: Captured = {},
  feedbackCaptured: Captured = {}
) {
  dbSelectMock
    .mockImplementationOnce(() => makeSelectChain(seriesRows, seriesCaptured))
    .mockImplementationOnce(() => makeSelectChain(byOrgRows, byOrgCaptured))
    .mockImplementationOnce(() => makeSelectChain(feedbackRows, feedbackCaptured));
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveImpactPartnerIdMock.mockResolvedValue(PARTNER_ID);
  loadImpactWeightsMock.mockResolvedValue({
    partnerId: PARTNER_ID,
    effective: DEFAULT_IMPACT_WEIGHTS,
    overrides: null,
  });
  countEligibleGraduationsMock.mockResolvedValue(0);
});

describe('loadImpactSummary — window, zero-fill, ordering', () => {
  it.each([7, 30, 90] as const)('window=%d: series has exactly `window` zero-filled buckets, oldest first', async (window) => {
    stubOrgScopeQueries([], [{ up: 0, down: 0 }]);

    const result = await loadImpactSummary(orgAuth(), { window });

    expect(result.series).toHaveLength(window);
    const through = lastCompleteUtcDay();
    const expectedFrom = shiftUtcDay(through, -(window - 1));
    expect(result.series[0]!.day).toBe(expectedFrom);
    expect(result.series[result.series.length - 1]!.day).toBe(through);
    expect(result.through).toBe(through);
    // Ascending order, one calendar day apart.
    for (let i = 1; i < result.series.length; i++) {
      expect(result.series[i]!.day).toBe(shiftUtcDay(result.series[i - 1]!.day, 1));
    }
    // Zero-filled: every counter zero, and the estimate is zero too.
    for (const bucket of result.series) {
      for (const key of COUNTER_KEYS) expect(bucket[key]).toBe(0);
      expect(bucket.estSecondsSaved).toBe(0);
    }
  });

  it('schemaVersion stays 1 and promoteEligibleCount carries the graduation count', async () => {
    countEligibleGraduationsMock.mockResolvedValueOnce(4);
    stubOrgScopeQueries([], [{ up: 0, down: 0 }]);

    const result = await loadImpactSummary(orgAuth(), { window: 7 });

    expect(result.schemaVersion).toBe(1);
    expect(result.promoteEligibleCount).toBe(4);
  });

  it('promoteEligibleCount is 0, not null, when no key is eligible', async () => {
    countEligibleGraduationsMock.mockResolvedValueOnce(0);
    stubOrgScopeQueries([], [{ up: 0, down: 0 }]);

    const result = await loadImpactSummary(orgAuth(), { window: 7 });

    expect(result.promoteEligibleCount).toBe(0);
  });

  it('org scope passes the caller orgCondition and the requested orgId through', async () => {
    stubOrgScopeQueries([], [{ up: 0, down: 0 }]);
    const auth = orgAuth();

    await loadImpactSummary(auth, { window: 7, orgId: ORG_A });

    expect(countEligibleGraduationsMock).toHaveBeenCalledTimes(1);
    const [passedCondition, passedOrgId] = countEligibleGraduationsMock.mock.calls[0]!;
    expect(passedOrgId).toBe(ORG_A);
    // The SAME closure the impact aggregates use, proven by compiling what it
    // builds — not by identity, which a wrapper would satisfy vacuously.
    expect(compile(passedCondition(aiAgentGraduation.orgId)).params).toEqual([ORG_A]);
  });

  it('partner scope passes an orgCondition covering exactly the accessible orgs, and no orgId', async () => {
    stubPartnerScopeQueries([], [], [{ up: 0, down: 0 }]);

    await loadImpactSummary(partnerAuth(), { window: 30 });

    const [passedCondition, passedOrgId] = countEligibleGraduationsMock.mock.calls[0]!;
    expect(passedOrgId).toBeUndefined();
    expect(compile(passedCondition(aiAgentGraduation.orgId)).params).toEqual([ORG_A, ORG_B]);
  });
});

describe('loadImpactSummary — totals is a read-time estimate', () => {
  it('totals.estSecondsSaved === estimateSecondsSaved(totals, effective), and changes when the override changes', async () => {
    const through = lastCompleteUtcDay();
    const from = shiftUtcDay(through, -6);
    const rows = [seriesRow(from, 100, '2026-01-01T00:00:00.000Z'), seriesRow(through, 900, '2026-01-05T00:00:00.000Z')];

    // Pass 1: default weights.
    stubOrgScopeQueries(rows, [{ up: 0, down: 0 }]);
    const withDefaults = await loadImpactSummary(orgAuth(), { window: 7 });
    const expectedTotalsDefault = { ...counterFields(100) };
    COUNTER_KEYS.forEach((key) => {
      expectedTotalsDefault[key] = counterFields(100)[key] + counterFields(900)[key];
    });
    expect(withDefaults.totals.estSecondsSaved).toBe(estimateSecondsSaved(expectedTotalsDefault, DEFAULT_IMPACT_WEIGHTS));

    // Pass 2: an override that changes fixExecuted's price — proves the
    // estimate is computed at READ time from `loadImpactWeights`'s return,
    // not a stored/cached number.
    const overriddenWeights: ImpactWeights = { ...DEFAULT_IMPACT_WEIGHTS, fixExecuted: 5000 };
    loadImpactWeightsMock.mockResolvedValueOnce({ partnerId: PARTNER_ID, effective: overriddenWeights, overrides: { fixExecuted: 5000 } });
    stubOrgScopeQueries(rows, [{ up: 0, down: 0 }]);
    const withOverride = await loadImpactSummary(orgAuth(), { window: 7 });

    expect(withOverride.totals.estSecondsSaved).toBe(estimateSecondsSaved(expectedTotalsDefault, overriddenWeights));
    expect(withOverride.totals.estSecondsSaved).not.toBe(withDefaults.totals.estSecondsSaved);
    expect(withOverride.weights.overrides).toEqual({ fixExecuted: 5000 });
  });

  it('sums non-uniform per-day counters correctly into totals (proves no column swap)', async () => {
    const through = lastCompleteUtcDay();
    const from = shiftUtcDay(through, -6);
    const dayA = shiftUtcDay(from, 1);
    const rows = [seriesRow(from, 10, '2026-01-01T00:00:00.000Z'), seriesRow(dayA, 20, '2026-01-02T00:00:00.000Z')];
    stubOrgScopeQueries(rows, [{ up: 0, down: 0 }]);

    const result = await loadImpactSummary(orgAuth(), { window: 7 });

    for (const key of COUNTER_KEYS) {
      expect(result.totals[key]).toBe(counterFields(10)[key] + counterFields(20)[key]);
    }
    expect(result.totals.llmCents).toBe(counterFields(10).llmCents + counterFields(20).llmCents);
  });
});

describe('loadImpactSummary — rebuiltAt', () => {
  it('is the MINIMUM rebuilt_at across buckets, not the maximum', async () => {
    const through = lastCompleteUtcDay();
    const from = shiftUtcDay(through, -6);
    const rows = [
      seriesRow(from, 10, '2026-03-05T12:00:00.000Z'),
      seriesRow(shiftUtcDay(from, 1), 20, '2026-01-01T00:00:00.000Z'), // earliest
      seriesRow(shiftUtcDay(from, 2), 30, '2026-02-01T00:00:00.000Z'),
    ];
    stubOrgScopeQueries(rows, [{ up: 0, down: 0 }]);

    const result = await loadImpactSummary(orgAuth(), { window: 7 });

    expect(result.rebuiltAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is null for an empty window (no rows at all)', async () => {
    stubOrgScopeQueries([], [{ up: 0, down: 0 }]);
    const result = await loadImpactSummary(orgAuth(), { window: 7 });
    expect(result.rebuiltAt).toBeNull();
  });
});

describe('loadImpactSummary — compiled SQL (vacuous-Drizzle trap)', () => {
  it('the series statement carries auth.orgCondition on ai_agent_impact_daily.org_id', async () => {
    const seriesCaptured: Captured = {};
    stubOrgScopeQueries([], [{ up: 0, down: 0 }], seriesCaptured);

    await loadImpactSummary(orgAuth(), { window: 7 });

    const { sql, params } = compile(seriesCaptured.where);
    expect(sql).toMatch(/"ai_agent_impact_daily"\."org_id" = \$\d/);
    expect(params).toEqual(expect.arrayContaining([ORG_A]));
  });

  it('the byOrg statement (partner scope) carries auth.orgCondition on ai_agent_impact_daily.org_id', async () => {
    const byOrgCaptured: Captured = {};
    stubPartnerScopeQueries([], [], [{ up: 0, down: 0 }], {}, byOrgCaptured);

    await loadImpactSummary(partnerAuth(), { window: 7 });

    const { sql, params } = compile(byOrgCaptured.where);
    expect(sql).toMatch(/"ai_agent_impact_daily"\."org_id"/);
    expect(params).toEqual(expect.arrayContaining([ORG_A, ORG_B]));
  });

  it('the positiveFeedback statement carries auth.orgCondition, superseded_by IS NULL, and feedback_at bounds', async () => {
    const feedbackCaptured: Captured = {};
    stubOrgScopeQueries([], [{ up: 0, down: 0 }], {}, feedbackCaptured);

    await loadImpactSummary(orgAuth(), { window: 7 });

    const { sql } = compile(feedbackCaptured.where);
    expect(sql).toMatch(/"ai_alert_verdicts"\."org_id" = \$\d/);
    expect(sql).toMatch(/"ai_alert_verdicts"\."superseded_by" is null/i);
    expect(sql).toMatch(/"ai_alert_verdicts"\."feedback_at" >=/);
    expect(sql).toMatch(/"ai_alert_verdicts"\."feedback_at" </);
  });
});

describe('loadImpactSummary — byOrg', () => {
  it('is empty for organization scope (no byOrg query issued)', async () => {
    stubOrgScopeQueries([], [{ up: 0, down: 0 }]);
    const result = await loadImpactSummary(orgAuth(), { window: 7 });
    expect(result.byOrg).toEqual([]);
    expect(result.byOrgTruncated).toBe(false);
    expect(dbSelectMock).toHaveBeenCalledTimes(2); // series + feedback only
  });

  it('is empty for system scope (no byOrg query issued)', async () => {
    stubOrgScopeQueries([], [{ up: 0, down: 0 }]);
    const result = await loadImpactSummary(systemAuth(), { window: 7, orgId: ORG_A });
    expect(result.byOrg).toEqual([]);
    expect(result.byOrgTruncated).toBe(false);
    expect(dbSelectMock).toHaveBeenCalledTimes(2);
  });

  it('is populated and sorted desc by estSecondsSaved for partner scope', async () => {
    const rows = [orgRow(ORG_A, 'Org A', 10), orgRow(ORG_B, 'Org B', 900)];
    stubPartnerScopeQueries([], rows, [{ up: 0, down: 0 }]);

    const result = await loadImpactSummary(partnerAuth(), { window: 7 });

    expect(result.byOrg).toHaveLength(2);
    expect(result.byOrg[0]!.orgId).toBe(ORG_B); // higher counters => higher estimate => first
    expect(result.byOrg[1]!.orgId).toBe(ORG_A);
    expect(result.byOrg[0]!.estSecondsSaved).toBeGreaterThan(result.byOrg[1]!.estSecondsSaved);
    expect(result.byOrgTruncated).toBe(false);
  });

  it('byOrgTruncated is true at 51 orgs and false at 50', async () => {
    const rows50 = Array.from({ length: 50 }, (_, i) => orgRow(`org-${i}`, `Org ${i}`, i * 10));
    stubPartnerScopeQueries([], rows50, [{ up: 0, down: 0 }]);
    const at50 = await loadImpactSummary(partnerAuth(), { window: 7 });
    expect(at50.byOrg).toHaveLength(AI_AGENT_IMPACT_BY_ORG_LIMIT);
    expect(at50.byOrgTruncated).toBe(false);

    const rows51 = Array.from({ length: 51 }, (_, i) => orgRow(`org-${i}`, `Org ${i}`, i * 10));
    stubPartnerScopeQueries([], rows51, [{ up: 0, down: 0 }]);
    const at51 = await loadImpactSummary(partnerAuth(), { window: 7 });
    expect(at51.byOrg).toHaveLength(AI_AGENT_IMPACT_BY_ORG_LIMIT);
    expect(at51.byOrgTruncated).toBe(true);
  });
});

describe('loadImpactSummary — positiveFeedback', () => {
  it.each([
    [{ up: 0, down: 0 }, null],
    [{ up: 3, down: 0 }, 1],
    [{ up: 3, down: 1 }, 0.75],
  ] as const)('up=%o -> rate %p', async (feedback, expectedRate) => {
    stubOrgScopeQueries([], [feedback]);
    const result = await loadImpactSummary(orgAuth(), { window: 7 });
    expect(result.positiveFeedback).toEqual({ up: feedback.up, down: feedback.down, rate: expectedRate });
  });
});

describe('loadImpactSummary — canEditWeights', () => {
  it('is false for organization scope, true for a full-partner-admin, false for a selected-scope partner user, true for system scope', async () => {
    stubOrgScopeQueries([], [{ up: 0, down: 0 }]);
    expect((await loadImpactSummary(orgAuth(), { window: 7 })).canEditWeights).toBe(false);

    stubPartnerScopeQueries([], [], [{ up: 0, down: 0 }]);
    expect((await loadImpactSummary(partnerAuth('all'), { window: 7 })).canEditWeights).toBe(true);

    stubPartnerScopeQueries([], [], [{ up: 0, down: 0 }]);
    expect((await loadImpactSummary(partnerAuth('selected'), { window: 7 })).canEditWeights).toBe(false);

    stubOrgScopeQueries([], [{ up: 0, down: 0 }]);
    expect((await loadImpactSummary(systemAuth(), { window: 7, orgId: ORG_A })).canEditWeights).toBe(true);
  });
});

describe('loadImpactSummary — org access', () => {
  it('throws ImpactOrgAccessDeniedError for an inaccessible orgId, without issuing any query', async () => {
    await expect(loadImpactSummary(orgAuth(), { window: 7, orgId: ORG_B })).rejects.toThrow(ImpactOrgAccessDeniedError);
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('rejects a system-scoped query with no orgId, without issuing any query', async () => {
    await expect(loadImpactSummary(systemAuth(), { window: 7 })).rejects.toThrow();
    expect(dbSelectMock).not.toHaveBeenCalled();
  });
});
