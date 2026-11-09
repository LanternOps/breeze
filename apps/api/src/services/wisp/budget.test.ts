import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * services/wisp/budget.ts — per-grant UTC-day budget (spec §9, w00 budget.ts,
 * A32; W05 Review Focus 4). `db` is a chain fake: each awaited select resolves
 * the next queued result; every `.where(...)` condition is recorded so the
 * spend query's window and status filter can be compiled and asserted.
 */
const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const whereArgs: unknown[] = [];
  const fromArgs: unknown[] = [];
  const chain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const m of ['innerJoin', 'leftJoin', 'limit', 'orderBy', 'groupBy']) p[m] = vi.fn(() => p);
    p.from = vi.fn((t: unknown) => { fromArgs.push(t); return p; });
    p.where = vi.fn((cond: unknown) => { whereArgs.push(cond); return p; });
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(res, rej);
    return p;
  };
  return {
    results,
    whereArgs,
    fromArgs,
    db: { select: vi.fn(() => chain()), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
    inSystemContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    deliverInApp: vi.fn(),
    getOrCreateThread: vi.fn(),
    getEntitlements: vi.fn(),
    pauseGrant: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db: h.db,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./grantAuthority', () => ({ inSystemContext: h.inSystemContext }));
vi.mock('./deliver', () => ({ deliverInApp: h.deliverInApp }));
vi.mock('./threads', () => ({ getOrCreateThread: h.getOrCreateThread }));
vi.mock('../entitlements', async (orig) => ({
  ...(await orig<typeof import('../entitlements')>()),
  getEntitlements: h.getEntitlements,
}));
// budget.ts must never pause a grant (w00): an exhausted budget keeps it active.
vi.mock('./grants', () => ({ pauseGrant: h.pauseGrant }));

import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiInvocations } from '../../db/schema/aiInvocations';
import { wispGrants } from '../../db/schema/wisp';
import {
  GRANT_OVERHEAD_SOURCE_REF_PREFIXES,
  INSTRUCTION_EXTRACT_SOURCE_REF_PREFIX,
  GrantNotFoundForBudgetError,
  SUMMARY_REFINE_SOURCE_REF_PREFIX,
  WISP_BUDGET_DEFAULT_BY_PLAN,
  chargeableUnderGrant,
  combineSpendLines,
  grantOverheadSourceRefs,
  grantSettingsBounds,
  notifyBudgetExhaustedOnce,
  spendBreakdownUnderGrant,
  spendSummary,
  spentUnderGrant,
  summaryRefineSourceRef,
  utcDayWindow,
} from './budget';

const GRANT = '44444444-4444-4444-8444-444444444444';
const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const THREAD = '55555555-5555-4555-8555-555555555555';

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

const grantBudgetRow = (o: Record<string, unknown> = {}) => ({
  id: GRANT, partnerId: PARTNER, orgId: ORG, grantorUserId: USER, budgetCentsPerDay: 200, ...o,
});

const LIMITS = {
  pro: { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 },
  enterprise: { maxGrants: 100, budgetCentsPerDayCeiling: 2500, minFloorTickMinutes: 15 },
  unlimited: { maxGrants: 500, budgetCentsPerDayCeiling: 5000, minFloorTickMinutes: 15 },
} as const;
const entitlementsFor = (plan: string, limits: unknown) => ({
  plan,
  entitlements: { wisp: { state: 'enabled', source: 'plan', limits } },
});

beforeEach(() => {
  h.results.length = 0;
  h.whereArgs.length = 0;
  h.fromArgs.length = 0;
  vi.clearAllMocks();
  h.getOrCreateThread.mockResolvedValue({ id: THREAD, grantId: GRANT });
  h.deliverInApp.mockResolvedValue({ created: true });
});

describe('utcDayWindow', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('23:59:59.999Z and 00:00:00.000Z fall in different windows', () => {
    const before = utcDayWindow(new Date('2027-01-04T23:59:59.999Z'));
    const after = utcDayWindow(new Date('2027-01-05T00:00:00.000Z'));
    expect(before.key).toBe('2027-01-04');
    expect(after.key).toBe('2027-01-05');
    expect(before.start.toISOString()).toBe('2027-01-04T00:00:00.000Z');
    expect(before.end.toISOString()).toBe('2027-01-05T00:00:00.000Z');
    // end is exclusive: midnight belongs to the next window.
    expect(after.start.getTime()).toBe(before.end.getTime());
    expect(after.end.toISOString()).toBe('2027-01-06T00:00:00.000Z');
  });

  it('key is UTC, not local (TZ=America/Chicago)', () => {
    process.env.TZ = 'America/Chicago';
    // 2027-01-05 02:00Z is still 2027-01-04 20:00 in Chicago.
    const w = utcDayWindow(new Date('2027-01-05T02:00:00.000Z'));
    expect(w.key).toBe('2027-01-05');
    expect(w.start.toISOString()).toBe('2027-01-05T00:00:00.000Z');
    expect(w.end.toISOString()).toBe('2027-01-06T00:00:00.000Z');
  });

  it('crosses month and year ends', () => {
    expect(utcDayWindow(new Date('2026-12-31T12:00:00Z')).end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(utcDayWindow(new Date('2027-02-28T12:00:00Z')).end.toISOString()).toBe('2027-03-01T00:00:00.000Z');
  });
});

// #10414: the grant meter counts chat. Three raw lines (runs in whole cents,
// overhead and chat as ledger fractions) become one total rounded up ONCE, and
// a chat/background split that always adds back up to that total.
describe('combineSpendLines', () => {
  it('rounds overhead + chat up once and gives chat its own rounded line, capped at total − runs', () => {
    expect(combineSpendLines({ runsCents: 30, overheadRaw: 0.4, chatRaw: 169.2 }))
      .toEqual({ totalCents: 200, chatCents: 170, backgroundCents: 30 });
    // 0.2 + 0.2 rounds up to 1 once (not 1 + 1), and chat cannot exceed what is left after runs.
    expect(combineSpendLines({ runsCents: 0, overheadRaw: 0.2, chatRaw: 0.2 }))
      .toEqual({ totalCents: 1, chatCents: 1, backgroundCents: 0 });
    expect(combineSpendLines({ runsCents: 25, overheadRaw: 0, chatRaw: 0 }))
      .toEqual({ totalCents: 25, chatCents: 0, backgroundCents: 25 });
  });

  it('overhead alone is background; chat alone is chat', () => {
    expect(combineSpendLines({ runsCents: 0, overheadRaw: 12.25, chatRaw: 0 }))
      .toEqual({ totalCents: 13, chatCents: 0, backgroundCents: 13 });
    expect(combineSpendLines({ runsCents: 0, overheadRaw: 0, chatRaw: 1.4 }))
      .toEqual({ totalCents: 2, chatCents: 2, backgroundCents: 0 });
  });

  it('a whole-cent sum is not rounded up a second time', () => {
    expect(combineSpendLines({ runsCents: 10, overheadRaw: 0.7, chatRaw: 0.3 }))
      .toEqual({ totalCents: 11, chatCents: 1, backgroundCents: 10 });
    expect(combineSpendLines({ runsCents: 0, overheadRaw: 1.1, chatRaw: 0.9 }))
      .toEqual({ totalCents: 2, chatCents: 1, backgroundCents: 1 });
  });

  it('invariant: backgroundCents + chatCents === totalCents, and no line is negative', () => {
    const inputs = [
      { runsCents: 0, overheadRaw: 0, chatRaw: 0 },
      { runsCents: 7, overheadRaw: 0.000001, chatRaw: 0 },
      { runsCents: 0, overheadRaw: 0, chatRaw: 0.000001 },
      { runsCents: 3, overheadRaw: 0.5, chatRaw: 0.5 },
      { runsCents: 100, overheadRaw: 2.999999, chatRaw: 47.000001 },
      { runsCents: 59, overheadRaw: 0.1, chatRaw: 251.5 },
      { runsCents: 1, overheadRaw: 99.9, chatRaw: 0.2 },
    ];
    for (const input of inputs) {
      const b = combineSpendLines(input);
      expect(b.backgroundCents + b.chatCents, JSON.stringify(input)).toBe(b.totalCents);
      expect(b.chatCents, JSON.stringify(input)).toBeGreaterThanOrEqual(0);
      expect(b.backgroundCents, JSON.stringify(input)).toBeGreaterThanOrEqual(input.runsCents);
      expect(Number.isInteger(b.totalCents) && Number.isInteger(b.chatCents)).toBe(true);
    }
  });
});

describe('grant overhead source refs', () => {
  it('lists the session-summary and instruction-extract prefixes and keys every prefix by grant id', () => {
    expect(GRANT_OVERHEAD_SOURCE_REF_PREFIXES).toEqual([SUMMARY_REFINE_SOURCE_REF_PREFIX, INSTRUCTION_EXTRACT_SOURCE_REF_PREFIX]);
    expect(INSTRUCTION_EXTRACT_SOURCE_REF_PREFIX).toBe('wisp_instruction_extract:');
    expect(grantOverheadSourceRefs(GRANT)).toEqual([summaryRefineSourceRef(GRANT), `wisp_instruction_extract:${GRANT}`]);
  });
});

describe('spendBreakdownUnderGrant', () => {
  it('reads runs, overhead and chat in one system context and combines them', async () => {
    h.results.push([{ total: '30' }], [{ total: '0.400000' }], [{ total: '169.200000' }]);
    const now = new Date('2027-01-05T12:00:00.000Z');
    await expect(spendBreakdownUnderGrant(GRANT, now))
      .resolves.toEqual({ totalCents: 200, chatCents: 170, backgroundCents: 30 });
    expect(h.inSystemContext).toHaveBeenCalled();
    expect(h.fromArgs).toEqual([aiAgentRuns, aiInvocations, aiInvocations]);
  });

  it("the chat line is the grant's Wisp sessions' invocations that are not a run's own, by created_at in the window", async () => {
    h.results.push([{ total: 0 }], [{ total: 0 }], [{ total: 0 }]);
    await spendBreakdownUnderGrant(GRANT, new Date('2027-01-05T12:00:00.000Z'));
    const q = compile(h.whereArgs[2]);
    // Scoped through the grant's sessions (ai_sessions_wisp_grant_idx → ai_invocations_session_idx), not the org index.
    expect(q.sql).toContain('"ai_invocations"."session_id" = ANY(ARRAY(SELECT');
    expect(q.sql).toContain('wisp_grant_id = $');
    expect(q.sql).toContain('"ai_invocations"."agent_run_id" is null');
    expect(q.sql).toContain('"ai_invocations"."created_at" >= $');
    expect(q.sql).toContain('"ai_invocations"."created_at" < $');
    expect(q.params).toEqual(expect.arrayContaining([GRANT, '2027-01-05T00:00:00.000Z', '2027-01-06T00:00:00.000Z']));
  });

  it('no spend → all zero', async () => {
    h.results.push([{ total: null }], [{ total: null }], [{ total: null }]);
    await expect(spendBreakdownUnderGrant(GRANT)).resolves.toEqual({ totalCents: 0, chatCents: 0, backgroundCents: 0 });
  });
});

describe('spentUnderGrant', () => {
  it('is the breakdown total: chat counts toward the grant budget (#10414)', async () => {
    h.results.push([{ total: '30' }], [{ total: '0.4' }], [{ total: '169.2' }]);
    expect(await spentUnderGrant(GRANT, new Date('2027-01-05T12:00:00.000Z'))).toBe(200);
  });

  it('sums cost_cents for the grant by queued_at in [start, end) and excludes skipped, in system context', async () => {
    h.results.push([{ total: '137' }]);
    const now = new Date('2027-01-05T00:30:00.000Z');
    expect(await spentUnderGrant(GRANT, now)).toBe(137);
    expect(h.inSystemContext).toHaveBeenCalled();
    expect(h.fromArgs[0]).toBe(aiAgentRuns);
    const q = compile(h.whereArgs[0]);
    expect(q.sql).toContain('"ai_agent_runs"."grant_id" = $');
    expect(q.sql).toContain('"ai_agent_runs"."queued_at" >= $');
    expect(q.sql).toContain('"ai_agent_runs"."queued_at" < $');
    expect(q.sql).toContain('"ai_agent_runs"."status" <> $');
    // The window is today's (UTC), so a run queued yesterday — even one that
    // finished after midnight — is not charged to today (Review Focus 4).
    expect(q.params).toEqual(expect.arrayContaining([
      GRANT, 'skipped', '2027-01-05T00:00:00.000Z', '2027-01-06T00:00:00.000Z',
    ]));
    expect(q.sql).not.toContain('completed_at');
  });

  it('no runs → 0', async () => {
    h.results.push([{ total: null }], [{ total: null }]);
    expect(await spentUnderGrant(GRANT)).toBe(0);
    h.results.push([], []);
    expect(await spentUnderGrant(GRANT)).toBe(0);
  });

  // #10390: a model-written session summary (opt-in per grant) is not a run, so
  // its settled ledger rows are added by their grant-keyed source_ref.
  it("adds the grant's session-summary model calls from ai_invocations, by created_at in the same window", async () => {
    h.results.push([{ total: '137' }], [{ total: '11.25' }]);
    const now = new Date('2027-01-05T00:30:00.000Z');
    expect(await spentUnderGrant(GRANT, now)).toBe(149);
    expect(h.fromArgs).toEqual([aiAgentRuns, aiInvocations, aiInvocations]);
    const q = compile(h.whereArgs[1]);
    // The closed list of grant-keyed overhead refs (W05's extractor appends to it).
    expect(q.sql).toContain('"ai_invocations"."source_ref" in ($');
    expect(q.sql).toContain('"ai_invocations"."created_at" >= $');
    expect(q.sql).toContain('"ai_invocations"."created_at" < $');
    // Bounded to the grant's partner, so ai_invocations_org_created_idx serves it, not a day of every tenant.
    expect(q.sql).toContain('"ai_invocations"."org_id" IN (SELECT');
    expect(q.params).toEqual(expect.arrayContaining([
      `wisp_thread_summary:${GRANT}`, '2027-01-05T00:00:00.000Z', '2027-01-06T00:00:00.000Z',
    ]));
  });

  // #10428 (W05): a turn-end instruction extraction is sessionless overhead,
  // charged to the grant's BACKGROUND line by its grant-keyed source_ref.
  it("counts the grant's instruction-extract ledger rows on the background line", async () => {
    h.results.push([{ total: '0' }], [{ total: '1.5' }], [{ total: '0' }]);
    const now = new Date('2027-01-05T00:30:00.000Z');
    const b = await spendBreakdownUnderGrant(GRANT, now);
    expect(b).toEqual({ backgroundCents: 2, chatCents: 0, totalCents: 2 });
    const q = compile(h.whereArgs[1]);
    expect(q.params).toEqual(expect.arrayContaining([`wisp_instruction_extract:${GRANT}`]));
  });

  it('summaryRefineSourceRef is the grant-keyed ledger ref', () => {
    expect(summaryRefineSourceRef(GRANT)).toBe(`wisp_thread_summary:${GRANT}`);
  });
});

describe('chargeableUnderGrant', () => {
  it('ok when spent + estimate == budget', async () => {
    h.results.push([grantBudgetRow({ budgetCentsPerDay: 200 })], [{ total: 175 }]);
    await expect(chargeableUnderGrant(GRANT, 25)).resolves.toEqual({ ok: true });
  });

  it('budget_exhausted when spent + estimate > budget, and never pauses the grant', async () => {
    h.results.push([grantBudgetRow({ budgetCentsPerDay: 200 })], [{ total: 176 }]);
    await expect(chargeableUnderGrant(GRANT, 25)).resolves.toEqual({ ok: false, reason: 'budget_exhausted' });
    expect(h.pauseGrant).not.toHaveBeenCalled();
  });

  it('session-summary spend counts against the budget like run spend', async () => {
    h.results.push([grantBudgetRow({ budgetCentsPerDay: 200 })], [{ total: 150 }], [{ total: 26 }]);
    await expect(chargeableUnderGrant(GRANT, 25)).resolves.toEqual({ ok: false, reason: 'budget_exhausted' });
    h.results.push([grantBudgetRow({ budgetCentsPerDay: 200 })], [{ total: 150 }], [{ total: 25 }]);
    await expect(chargeableUnderGrant(GRANT, 25)).resolves.toEqual({ ok: true });
  });

  it('chat spend under the grant counts against the budget too (#10414)', async () => {
    h.results.push([grantBudgetRow({ budgetCentsPerDay: 200 })], [{ total: 0 }], [{ total: 0 }], [{ total: '175.5' }]);
    await expect(chargeableUnderGrant(GRANT, 25)).resolves.toEqual({ ok: false, reason: 'budget_exhausted' });
    h.results.push([grantBudgetRow({ budgetCentsPerDay: 200 })], [{ total: 0 }], [{ total: 0 }], [{ total: '175' }]);
    await expect(chargeableUnderGrant(GRANT, 25)).resolves.toEqual({ ok: true });
  });

  it('a zero budget refuses any positive estimate', async () => {
    h.results.push([grantBudgetRow({ budgetCentsPerDay: 0 })], [{ total: 0 }]);
    await expect(chargeableUnderGrant(GRANT, 1)).resolves.toEqual({ ok: false, reason: 'budget_exhausted' });
  });

  it('counts runs by queued_at: the window queried is the one `now` falls in', async () => {
    // Yesterday's 23:59 run is outside today's window; the mock returns what
    // the query would (today's runs only) and the where clause pins today.
    h.results.push([grantBudgetRow({ budgetCentsPerDay: 200 })], [{ total: 0 }]);
    await expect(chargeableUnderGrant(GRANT, 25, new Date('2027-01-05T00:00:01.000Z'))).resolves.toEqual({ ok: true });
    const spendWhere = compile(h.whereArgs[1]);
    expect(spendWhere.params).toEqual(expect.arrayContaining(['2027-01-05T00:00:00.000Z', '2027-01-06T00:00:00.000Z']));
    expect(spendWhere.params).not.toContain('2027-01-04T00:00:00.000Z');
  });

  it('an unknown grant throws GrantNotFoundForBudgetError (never a silent ok)', async () => {
    h.results.push([]);
    await expect(chargeableUnderGrant(GRANT, 1)).rejects.toBeInstanceOf(GrantNotFoundForBudgetError);
  });

  it('rejects a negative or non-finite estimate', async () => {
    await expect(chargeableUnderGrant(GRANT, -1)).rejects.toThrow(RangeError);
    await expect(chargeableUnderGrant(GRANT, Number.NaN)).rejects.toThrow(RangeError);
  });

  it('reads the grant by id in system context', async () => {
    h.results.push([grantBudgetRow()], [{ total: 0 }]);
    await chargeableUnderGrant(GRANT, 1);
    expect(h.inSystemContext).toHaveBeenCalled();
    expect(h.fromArgs[0]).toBe(wispGrants);
    expect(compile(h.whereArgs[0]).params).toEqual([GRANT]);
  });
});

describe('notifyBudgetExhaustedOnce', () => {
  const now = new Date('2027-01-05T15:00:00.000Z');

  it('delivers to the grantor with a per-window dedupe key and links to the grant\'s thread page', async () => {
    h.results.push([grantBudgetRow()]);
    await expect(notifyBudgetExhaustedOnce(GRANT, now)).resolves.toBe(true);
    expect(h.getOrCreateThread).toHaveBeenCalledWith(GRANT);
    expect(h.deliverInApp).toHaveBeenCalledWith({
      userId: USER,
      orgId: ORG,
      // The grant stays active (w00), so the copy must not say "paused" (#10145).
      title: "Wisp is over today's budget: background checks resume at 00:00 UTC",
      body: 'Chat keeps working. Raise the budget from the thread header to resume background checks sooner.',
      link: `/ai/wisp/thread/${THREAD}`,
      threadId: THREAD,
      grantId: GRANT,
      deepLink: `/ai/wisp/thread/${THREAD}`,
      dedupeKey: `wisp-budget-${GRANT}-2027-01-05`,
    });
    // W02a: a budget notice is never a thread post (explicit post kinds only).
    expect(h.deliverInApp.mock.calls[0]![0]).not.toHaveProperty('post');
  });

  it('second call in the same window returns false (dedupe key collides)', async () => {
    h.results.push([grantBudgetRow()], [grantBudgetRow()]);
    h.deliverInApp.mockResolvedValueOnce({ created: true }).mockResolvedValueOnce({ created: false });
    expect(await notifyBudgetExhaustedOnce(GRANT, now)).toBe(true);
    expect(await notifyBudgetExhaustedOnce(GRANT, new Date('2027-01-05T23:59:59.999Z'))).toBe(false);
    const keys = h.deliverInApp.mock.calls.map((c) => (c[0] as { dedupeKey: string }).dedupeKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it('a partner-wide grant notifies with orgId null', async () => {
    h.results.push([grantBudgetRow({ orgId: null })]);
    await notifyBudgetExhaustedOnce(GRANT, now);
    expect(h.deliverInApp).toHaveBeenCalledWith(expect.objectContaining({ orgId: null }));
  });

  it('an unknown grant throws and delivers nothing', async () => {
    h.results.push([]);
    await expect(notifyBudgetExhaustedOnce(GRANT, now)).rejects.toBeInstanceOf(GrantNotFoundForBudgetError);
    expect(h.deliverInApp).not.toHaveBeenCalled();
  });
});

describe('spendSummary', () => {
  it('returns today\'s spend, the grant budget, and budgetResetsAt = window end', async () => {
    h.results.push([grantBudgetRow({ budgetCentsPerDay: 500 })], [{ total: 30 }], [{ total: 0 }], [{ total: '12.2' }]);
    const now = new Date('2027-01-05T18:00:00.000Z');
    const s = await spendSummary(GRANT, now);
    expect(s).toEqual({ spentTodayCents: 43, backgroundCents: 30, chatCents: 13, budgetCentsPerDay: 500, budgetResetsAt: utcDayWindow(now).end });
    expect(s.budgetResetsAt.toISOString()).toBe('2027-01-06T00:00:00.000Z');
  });
});

describe('plan defaults and bounds', () => {
  it('WISP_BUDGET_DEFAULT_BY_PLAN: pro 200, enterprise 500, unlimited 1000, every other plan 200', () => {
    expect(WISP_BUDGET_DEFAULT_BY_PLAN).toEqual({
      free: 200, starter: 200, community: 200, pro: 200, enterprise: 500, unlimited: 1000,
    });
  });

  it('grantSettingsBounds is min(5 × plan default, ceiling) and max(15, minFloorTickMinutes)', async () => {
    h.getEntitlements.mockResolvedValueOnce(entitlementsFor('pro', LIMITS.pro));
    await expect(grantSettingsBounds(PARTNER)).resolves.toEqual({ budgetCentsPerDayMax: 1000, minFloorTickMinutes: 15 });
    h.getEntitlements.mockResolvedValueOnce(entitlementsFor('enterprise', LIMITS.enterprise));
    await expect(grantSettingsBounds(PARTNER)).resolves.toEqual({ budgetCentsPerDayMax: 2500, minFloorTickMinutes: 15 });
    h.getEntitlements.mockResolvedValueOnce(entitlementsFor('unlimited', LIMITS.unlimited));
    await expect(grantSettingsBounds(PARTNER)).resolves.toEqual({ budgetCentsPerDayMax: 5000, minFloorTickMinutes: 15 });
    expect(h.getEntitlements).toHaveBeenCalledWith(PARTNER);
  });

  it('a lower ceiling wins over 5×; a higher minFloorTickMinutes wins over 15; 15 is the floor', async () => {
    h.getEntitlements.mockResolvedValueOnce(entitlementsFor('enterprise', { maxGrants: 5, budgetCentsPerDayCeiling: 700, minFloorTickMinutes: 60 }));
    await expect(grantSettingsBounds(PARTNER)).resolves.toEqual({ budgetCentsPerDayMax: 700, minFloorTickMinutes: 60 });
    h.getEntitlements.mockResolvedValueOnce(entitlementsFor('pro', { maxGrants: 5, budgetCentsPerDayCeiling: 9999, minFloorTickMinutes: 5 }));
    await expect(grantSettingsBounds(PARTNER)).resolves.toEqual({ budgetCentsPerDayMax: 1000, minFloorTickMinutes: 15 });
  });

  it('null limits → 5 × plan default and 15 minutes; a manual entitlement on free uses 200', async () => {
    h.getEntitlements.mockResolvedValueOnce(entitlementsFor('enterprise', null));
    await expect(grantSettingsBounds(PARTNER)).resolves.toEqual({ budgetCentsPerDayMax: 2500, minFloorTickMinutes: 15 });
    h.getEntitlements.mockResolvedValueOnce(entitlementsFor('free', null));
    await expect(grantSettingsBounds(PARTNER)).resolves.toEqual({ budgetCentsPerDayMax: 1000, minFloorTickMinutes: 15 });
  });

  it('an entitlement resolution failure propagates (the route maps it to 503)', async () => {
    const { EntitlementResolutionError } = await import('../entitlements');
    const err = new EntitlementResolutionError(PARTNER, new Error('db down'));
    h.getEntitlements.mockRejectedValueOnce(err);
    await expect(grantSettingsBounds(PARTNER)).rejects.toBe(err);
  });
});

// --- W07 Task 8: metrics call sites ---
const wm = vi.hoisted(() => ({
  incWispAssessment: vi.fn(), incWispNudge: vi.fn(), incWispConcern: vi.fn(),
  incWispGrantPause: vi.fn(), incWispBudgetExhausted: vi.fn(), setWispGrantsActive: vi.fn(),
}));
vi.mock('../wispMetrics', () => wm);

describe('chargeableUnderGrant metrics', () => {
  it('counts wisp_budget_exhausted_total only on a refusal', async () => {
    wm.incWispBudgetExhausted.mockClear();
    h.results.push([grantBudgetRow({ budgetCentsPerDay: 200 })], [{ total: 175 }]);
    await chargeableUnderGrant(GRANT, 25);
    expect(wm.incWispBudgetExhausted).not.toHaveBeenCalled();
    h.results.push([grantBudgetRow({ budgetCentsPerDay: 200 })], [{ total: 176 }]);
    await chargeableUnderGrant(GRANT, 25);
    expect(wm.incWispBudgetExhausted).toHaveBeenCalledTimes(1);
  });
});
