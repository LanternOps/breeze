import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * services/wisp/adminOverview.ts — the platform-admin Wisp overview (W07 Task
 * 9, #10141). `db` is a chain fake: each awaited select resolves the next
 * queued result, and every select / from / where argument is recorded so the
 * "today" windows and filters can be compiled and asserted.
 */
const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const selectArgs: unknown[] = [];
  const whereArgs: unknown[] = [];
  const fromArgs: unknown[] = [];
  const chain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const m of ['innerJoin', 'leftJoin', 'limit', 'orderBy', 'groupBy']) p[m] = vi.fn(() => p);
    // whereArgs[i] belongs to the i-th query (undefined when it has no where).
    p.from = vi.fn((t: unknown) => { fromArgs.push(t); whereArgs.push(undefined); return p; });
    p.where = vi.fn((cond: unknown) => { whereArgs[whereArgs.length - 1] = cond; return p; });
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(res, rej);
    return p;
  };
  return {
    results,
    selectArgs,
    whereArgs,
    fromArgs,
    db: {
      select: vi.fn((fields: unknown) => { selectArgs.push(fields); return chain(); }),
      insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn(),
    },
  };
});

vi.mock('../../db', () => ({ db: h.db }));

import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { partners } from '../../db/schema/orgs';
import { wispGrants } from '../../db/schema/wisp';
import { wispConcerns } from '../../db/schema/wispConcerns';
import {
  SPECIALIST_KEY_PATTERN,
  SPECIALIST_SWEEP_KEY_PATTERN,
  buildWispOverview,
  listGrantsForPartner,
} from './adminOverview';
import { specialistDedupeKey } from './specialistLaunchers';

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

const NOW = new Date('2027-01-05T15:30:00.000Z');
const MIDNIGHT = '2027-01-05T00:00:00.000Z';
const NEXT_MIDNIGHT = '2027-01-06T00:00:00.000Z';
const FUTURE = new Date('2027-03-01T00:00:00.000Z');
const PAST = new Date('2027-01-01T00:00:00.000Z');

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const G1 = 'a1111111-1111-4111-8111-111111111111';
const G2 = 'a2222222-2222-4222-8222-222222222222';
const G3 = 'a3333333-3333-4333-8333-333333333333';
const G4 = 'a4444444-4444-4444-8444-444444444444';
const G5 = 'a5555555-5555-4555-8555-555555555555';
const G6 = 'a6666666-6666-4666-8666-666666666666';
const G7 = 'a7777777-7777-4777-8777-777777777777';

beforeEach(() => {
  h.results.length = 0;
  h.selectArgs.length = 0;
  h.whereArgs.length = 0;
  h.fromArgs.length = 0;
  vi.clearAllMocks();
});

/** The where condition of the query that read `table`. */
function whereFor(table: unknown): { sql: string; params: unknown[] } {
  const i = h.fromArgs.indexOf(table);
  expect(i, 'table was never queried').toBeGreaterThanOrEqual(0);
  return compile(h.whereArgs[i]);
}

/** Asserts `column >= MIDNIGHT` and `column < NEXT_MIDNIGHT` — bound to the right side each. */
function expectTodayWindow(q: { sql: string; params: unknown[] }, column: string) {
  const esc = column.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
  const param = (op: string) => {
    const m = q.sql.match(new RegExp(`${esc} ${op} \\$(\\d+)`));
    expect(m, `${column} ${op} $n`).not.toBeNull();
    const v = q.params[Number(m![1]) - 1];
    return v instanceof Date ? v.toISOString() : v;
  };
  expect(param('>=')).toBe(MIDNIGHT);
  expect(param('<')).toBe(NEXT_MIDNIGHT);
}

/** SQL LIKE (no escapes) → RegExp, to check real keys against the patterns. */
const likeToRegExp = (pattern: string) =>
  new RegExp(`^${pattern.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.')).join('.*')}$`);

it('the specialist key patterns match the coordinator\'s admission keys and nothing else', () => {
  const requestId = 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f';
  expect(SPECIALIST_KEY_PATTERN).toBe(`${specialistDedupeKey('')}%`);
  expect(likeToRegExp(SPECIALIST_KEY_PATTERN).test(specialistDedupeKey(requestId))).toBe(true);
  // aiAgentSweepScheduler: `sweep-${baseline.id}-${orgId}-${occurrenceKey}`, launchSweep: occurrenceKey `wisp-${requestId}`
  const sweep = likeToRegExp(SPECIALIST_SWEEP_KEY_PATTERN);
  expect(sweep.test(`sweep-${P1}-${P2}-wisp-${requestId}`)).toBe(true);
  // a cron sweep occurrence (ISO-ish slot key) is not Wisp's
  expect(sweep.test(`sweep-${P1}-${P2}-2027-01-05T15:00`)).toBe(false);
});

describe('buildWispOverview', () => {
  const grant = (o: Record<string, unknown>) => ({
    status: 'active', pausedReason: null, expiresAt: FUTURE, budgetCentsPerDay: 200, ...o,
  });

  it('returns [] and reads nothing else when no partner has a grant', async () => {
    h.results.push([]);
    expect(await buildWispOverview(NOW)).toEqual([]);
    expect(h.fromArgs).toEqual([wispGrants]);
  });

  it('aggregates grants, today\'s assessments, specialists, spend and open concerns per partner', async () => {
    h.results.push(
      // 1. every grant
      [
        grant({ id: G1, partnerId: P1 }),
        grant({ id: G2, partnerId: P1, status: 'paused', pausedReason: 'budget_exhausted' }),
        grant({ id: G3, partnerId: P1, status: 'paused', pausedReason: 'budget_exhausted' }),
        grant({ id: G4, partnerId: P1, status: 'paused', pausedReason: 'grantor_suspended' }),
        // status still 'active' but already past expiry: neither active nor live
        grant({ id: G5, partnerId: P1, expiresAt: PAST }),
        grant({ id: G6, partnerId: P2, status: 'revoked' }),
        // paused with no recorded reason
        grant({ id: G7, partnerId: P2, status: 'paused', pausedReason: null }),
      ],
      // 2. partners
      [
        { id: P2, name: 'Globex IT', plan: 'starter' },
        { id: P1, name: 'Acme MSP', plan: 'pro' },
      ],
      // 3. today's runs per grant
      [
        // active grant at exactly its budget: exhausted (chargeableUnderGrant refuses any estimate > 0)
        { grantId: G1, assessments: 4, specialistRuns: 1, spentCents: '200' },
        // paused grant over budget: exhausted
        { grantId: G2, assessments: '2', specialistRuns: '0', spentCents: 300 },
        // paused grant under budget: not exhausted
        { grantId: G4, assessments: 0, specialistRuns: 0, spentCents: 199 },
        // expired-by-time grant and revoked grant over budget: not live, not counted
        { grantId: G5, assessments: 0, specialistRuns: 0, spentCents: 500 },
        { grantId: G6, assessments: 1, specialistRuns: 0, spentCents: 999 },
      ],
      // 4. today's specialist tasks per grant
      [{ grantId: G1, n: 2 }, { grantId: G3, n: '1' }],
      // 5. open concerns per partner
      [{ partnerId: P1, n: '5' }],
    );

    const rows = await buildWispOverview(NOW);

    expect(rows).toEqual([
      {
        partnerId: P1, partnerName: 'Acme MSP', plan: 'pro',
        activeGrants: 1,
        pausedGrants: { budget_exhausted: 2, grantor_suspended: 1 },
        assessmentsToday: 6,
        specialistRequestsToday: 4,
        openConcerns: 5,
        budgetExhaustedGrantsToday: 2,
      },
      {
        partnerId: P2, partnerName: 'Globex IT', plan: 'starter',
        activeGrants: 0, pausedGrants: { unknown: 1 },
        assessmentsToday: 1, specialistRequestsToday: 0, openConcerns: 0, budgetExhaustedGrantsToday: 0,
      },
    ]);
    expect(h.fromArgs).toEqual([wispGrants, partners, aiAgentRuns, aiOperatorTasks, wispConcerns]);
  });

  it('counts assessmentsToday from ai_agent_runs: profile assessment, grant runs only, queued_at ≥ UTC midnight', async () => {
    h.results.push([grant({ id: G1, partnerId: P1 })], [{ id: P1, name: 'Acme', plan: 'pro' }]);
    await buildWispOverview(NOW);

    const where = whereFor(aiAgentRuns);
    expect(where.sql).toContain('"ai_agent_runs"."grant_id" is not null');
    expectTodayWindow(where, '"ai_agent_runs"."queued_at"');

    const fields = h.selectArgs[h.fromArgs.indexOf(aiAgentRuns)] as Record<string, unknown>;
    const assessments = compile(fields.assessments);
    expect(assessments.sql).toContain('"ai_agent_runs"."profile" = $');
    expect(assessments.params).toContain('assessment');
    // specialist runs: direct admissions (wisp-specialist-<requestId>) OR Wisp sweep runs
    const specialists = compile(fields.specialistRuns);
    expect(specialists.sql).toMatch(/"ai_agent_runs"\."dedupe_key" like \$\d+ or \("ai_agent_runs"\."profile" = \$\d+ and "ai_agent_runs"\."dedupe_key" like \$\d+\)/);
    expect(specialists.params).toEqual([SPECIALIST_KEY_PATTERN, 'sweep', SPECIALIST_SWEEP_KEY_PATTERN]);
    // spend mirrors budget.ts spentUnderGrant: skipped runs cost nothing
    const spent = compile(fields.spentCents);
    expect(spent.sql).toContain('"ai_agent_runs"."cost_cents"');
    expect(spent.sql).toContain('"ai_agent_runs"."status" <> $');
    expect(spent.params).toContain('skipped');
  });

  it('counts specialist Operator tasks by the coordinator idempotency key created today, and only open concerns', async () => {
    h.results.push(
      [grant({ id: G1, partnerId: P1 }), grant({ id: G2, partnerId: P2 })],
      [{ id: P1, name: 'Acme', plan: 'pro' }, { id: P2, name: 'Globex', plan: 'pro' }],
    );
    await buildWispOverview(NOW);

    const tasks = whereFor(aiOperatorTasks);
    expect(tasks.sql).toContain('"ai_operator_tasks"."grant_id" is not null');
    expect(tasks.sql).toContain('"ai_operator_tasks"."client_idempotency_key" like $');
    expect(tasks.params).toContain('wisp-specialist-%');
    expectTodayWindow(tasks, '"ai_operator_tasks"."created_at"');

    const concerns = whereFor(wispConcerns);
    expect(concerns.sql).toContain('"wisp_concerns"."status" = $');
    expect(concerns.params).toContain('open');
    expect(concerns.sql).toContain('"wisp_concerns"."partner_id" in (');
    expect(concerns.params).toEqual(['open', P1, P2]);
  });

  it('a grant with no runs today is not budget-exhausted, and a missing partner row still renders', async () => {
    h.results.push(
      [grant({ id: G1, partnerId: P1, budgetCentsPerDay: 0 })],
      [],
      [],
      [],
      [],
    );
    expect(await buildWispOverview(NOW)).toEqual([{
      partnerId: P1, partnerName: P1, plan: 'unknown', activeGrants: 1, pausedGrants: {},
      assessmentsToday: 0, specialistRequestsToday: 0, openConcerns: 0, budgetExhaustedGrantsToday: 0,
    }]);
  });
});

describe('listGrantsForPartner', () => {
  it('returns [] without reading runs when the partner has no grants', async () => {
    h.results.push([]);
    expect(await listGrantsForPartner(P1, NOW)).toEqual([]);
    expect(h.fromArgs).toEqual([wispGrants]);
    expect(compile(h.whereArgs[0]).sql).toContain('"wisp_grants"."partner_id" = $');
  });

  it('lists the partner\'s grants with grantor name and today\'s assessments per grant', async () => {
    h.results.push(
      [
        {
          id: G1, orgId: null, grantorUserId: P2, grantorName: 'Ada Lovelace', status: 'active', pausedReason: null,
          expiresAt: FUTURE, budgetCentsPerDay: 200, floorTickMinutes: 30, currentRevisionId: G5,
        },
        {
          id: G2, orgId: G6, grantorUserId: P2, grantorName: null, status: 'paused', pausedReason: 'budget_exhausted',
          expiresAt: FUTURE, budgetCentsPerDay: 100, floorTickMinutes: 15, currentRevisionId: null,
        },
      ],
      [{ grantId: G1, n: '3' }],
    );

    expect(await listGrantsForPartner(P1, NOW)).toEqual([
      {
        id: G1, orgId: null, grantorUserId: P2, grantorName: 'Ada Lovelace', status: 'active', pausedReason: null,
        expiresAt: FUTURE.toISOString(), budgetCentsPerDay: 200, floorTickMinutes: 30, currentRevisionId: G5,
        assessmentsToday: 3,
      },
      {
        id: G2, orgId: G6, grantorUserId: P2, grantorName: null, status: 'paused', pausedReason: 'budget_exhausted',
        expiresAt: FUTURE.toISOString(), budgetCentsPerDay: 100, floorTickMinutes: 15, currentRevisionId: null,
        assessmentsToday: 0,
      },
    ]);

    expect(h.fromArgs).toEqual([wispGrants, aiAgentRuns]);
    const runs = whereFor(aiAgentRuns);
    expect(runs.sql).toContain('"ai_agent_runs"."profile" = $');
    expect(runs.params).toContain('assessment');
    expect(runs.sql).toContain('"ai_agent_runs"."grant_id" in (');
    expect(runs.params).toEqual(expect.arrayContaining([G1, G2]));
    expectTodayWindow(runs, '"ai_agent_runs"."queued_at"');
  });
});
