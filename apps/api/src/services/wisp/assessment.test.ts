import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * services/wisp/assessment.ts — admission (`enqueueAssessment`), the
 * watermark, the budget-exhausted deterministic digest, and the bounded run
 * context (`loadAssessmentContext`). `db` is a chain fake: each awaited select
 * resolves the next queued result, and every `.from(table)` / `.where(cond)`
 * is recorded so the org pin on each digest read can be compiled and asserted.
 */
const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const queries: { table: unknown; where: unknown[] }[] = [];
  const chain = (): Record<string, unknown> => {
    const q: { table: unknown; where: unknown[] } = { table: null, where: [] };
    queries.push(q);
    const p: Record<string, unknown> = {};
    for (const m of ['innerJoin', 'leftJoin', 'limit', 'orderBy', 'groupBy']) p[m] = vi.fn(() => p);
    p.from = vi.fn((t: unknown) => { q.table = t; return p; });
    p.where = vi.fn((cond: unknown) => { q.where.push(cond); return p; });
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(res, rej);
    return p;
  };
  class GrantInactiveError extends Error {
    readonly code = 'grant_inactive' as const;
    constructor(public readonly grantId: string, public readonly status: string) { super(`inactive ${status}`); }
  }
  const ctx = { current: undefined as unknown };
  return {
    results,
    queries,
    ctx,
    db: { select: vi.fn(() => chain()), selectDistinct: vi.fn(() => chain()), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
    GrantInactiveError,
    wispEnabled: vi.fn(() => true),
    hasEntitlement: vi.fn(),
    resolveGrantCeiling: vi.fn(),
    createAndEnqueueAgentRun: vi.fn(),
    chargeableUnderGrant: vi.fn(),
    notifyBudgetExhaustedOnce: vi.fn(),
    upsertConcern: vi.fn(),
    listConcernsForCeiling: vi.fn(),
    deliverInApp: vi.fn(),
    getOrCreateThread: vi.fn(),
    seedContextForSession: vi.fn(),
    updateThreadSummary: vi.fn(),
    listWatches: vi.fn(),
    readinessInventory: vi.fn(),
    recallForGrant: vi.fn(),
    pauseGrant: vi.fn(),
    captureException: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db: h.db,
  // Promise-aware stand-in for AsyncLocalStorage.exit: the ambient context is
  // restored only once the wrapped work settles.
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    const prev = h.ctx.current;
    h.ctx.current = undefined;
    let out: unknown;
    try { out = fn(); } catch (e) { h.ctx.current = prev; throw e; }
    if (out instanceof Promise) return out.finally(() => { h.ctx.current = prev; });
    h.ctx.current = prev;
    return out;
  }),
  getCurrentDbAccessContext: vi.fn(() => h.ctx.current),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const prev = h.ctx.current;
    h.ctx.current = { scope: 'system' };
    try { return await fn(); } finally { h.ctx.current = prev; }
  }),
}));
vi.mock('../../config/env', () => ({ wispEnabled: h.wispEnabled }));
vi.mock('../entitlements', () => ({ hasEntitlement: h.hasEntitlement }));
// The real assertWithinCeiling gates the digest sections on the grantor's permissions.
vi.mock('./grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./grantAuthority')>()),
  resolveGrantCeiling: h.resolveGrantCeiling,
  GrantInactiveError: h.GrantInactiveError,
}));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
vi.mock('../aiAgents/runService', () => ({ createAndEnqueueAgentRun: h.createAndEnqueueAgentRun }));
vi.mock('../aiAgents/assessmentProfile', () => ({ ASSESSMENT_BUDGET_CENTS_PER_RUN: 25 }));
vi.mock('./budget', async () => ({
  chargeableUnderGrant: h.chargeableUnderGrant,
  notifyBudgetExhaustedOnce: h.notifyBudgetExhaustedOnce,
  utcDayWindow: (now: Date) => ({ key: now.toISOString().slice(0, 10) }),
}));
vi.mock('./concerns', () => ({ upsertConcern: h.upsertConcern, listConcernsForCeiling: h.listConcernsForCeiling }));
vi.mock('./deliver', () => ({ deliverInApp: h.deliverInApp }));
vi.mock('./threads', () => ({
  getOrCreateThread: h.getOrCreateThread,
  seedContextForSession: h.seedContextForSession,
  updateThreadSummary: h.updateThreadSummary,
}));
vi.mock('./watches', () => ({ listWatches: h.listWatches }));
vi.mock('./readiness', () => ({ readinessInventory: h.readinessInventory }));
vi.mock('./memoryBroker', () => ({ recallForGrant: h.recallForGrant }));
// An exhausted budget must never pause a grant (w00 budget.ts).
vi.mock('./grants', () => ({ pauseGrant: h.pauseGrant }));

import { actionIntents } from '../../db/schema/actionIntents';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { alerts } from '../../db/schema/alerts';
import { connectionHealthIncidents } from '../../db/schema/connectionHealth';
import { tickets } from '../../db/schema/portal';
import {
  assessableOrgIds,
  enqueueAssessment,
  lastAssessmentWatermark,
  loadAssessmentContext,
  parseWispTriggerRef,
  recordDeterministicDigest,
} from './assessment';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '77777777-7777-4777-8777-777777777777';
const USER = '33333333-3333-4333-8333-333333333333';
const GRANT = '44444444-4444-4444-8444-444444444444';
const THREAD = '55555555-5555-4555-8555-555555555555';
const REV = '66666666-6666-4666-8666-666666666666';
const RUN = '88888888-8888-4888-8888-888888888888';
const ALERT = '99999999-9999-4999-8999-999999999999';
const WATCH = 'abababab-abab-4bab-8bab-abababababab';

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

const grantRow = (o: Record<string, unknown> = {}) => ({ id: GRANT, partnerId: PARTNER, currentRevisionId: REV, ...o });
const ceiling = (o: Record<string, unknown> = {}) => ({
  grantId: GRANT, revisionId: REV, partnerId: PARTNER, grantorUserId: USER, scopeOrgId: null, partnerWide: true,
  orgIds: new Set([ORG]), siteIds: null, permissionKeys: new Set(['*:*']), toolAllowlist: null,
  deniedTools: new Set(), orgTerms: new Map(), status: 'active', ...o,
});
const alertReason = { kind: 'event' as const, eventType: 'alert.triggered', eventId: 'evt-1' };

beforeEach(() => {
  vi.clearAllMocks();
  h.results.length = 0;
  h.queries.length = 0;
  h.ctx.current = undefined;
  h.wispEnabled.mockReturnValue(true);
  h.hasEntitlement.mockResolvedValue(true);
  h.resolveGrantCeiling.mockResolvedValue(ceiling());
  h.chargeableUnderGrant.mockResolvedValue({ ok: true });
  h.notifyBudgetExhaustedOnce.mockResolvedValue(true);
  h.getOrCreateThread.mockResolvedValue({ id: THREAD, grantId: GRANT, partnerId: PARTNER });
  h.upsertConcern.mockResolvedValue({ id: 'c1', created: true });
  h.deliverInApp.mockResolvedValue({ created: true });
  h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: RUN } });
});

describe('enqueueAssessment', () => {
  it('returns wisp_disabled without touching the DB when the flag is off', async () => {
    h.wispEnabled.mockReturnValue(false);
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'wisp_disabled' });
    expect(h.db.select).not.toHaveBeenCalled();
    expect(h.hasEntitlement).not.toHaveBeenCalled();
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('returns not_entitled when hasEntitlement(partnerId, "wisp") is false and never resolves the ceiling', async () => {
    h.results.push([grantRow()]);
    h.hasEntitlement.mockResolvedValue(false);
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'not_entitled' });
    expect(h.hasEntitlement).toHaveBeenCalledWith(PARTNER, 'wisp');
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('returns grant_inactive for a missing grant or one with no current revision', async () => {
    h.results.push([]);
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'grant_inactive' });
    h.results.push([grantRow({ currentRevisionId: null })]);
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'grant_inactive' });
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('returns grant_inactive on GrantInactiveError and never calls createAndEnqueueAgentRun', async () => {
    h.results.push([grantRow()]);
    h.resolveGrantCeiling.mockRejectedValue(new h.GrantInactiveError(GRANT, 'paused'));
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'grant_inactive' });
    expect(h.resolveGrantCeiling).toHaveBeenCalledWith(GRANT, REV);
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('rethrows a non-grant error from the ceiling resolver', async () => {
    h.results.push([grantRow()]);
    h.resolveGrantCeiling.mockRejectedValue(new Error('db down'));
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).rejects.toThrow('db down');
  });

  it('returns grant_org_out_of_ceiling for an org not in ceiling.orgIds', async () => {
    h.results.push([grantRow()]);
    await expect(enqueueAssessment({ grantId: GRANT, orgId: OTHER_ORG, reason: { kind: 'tick' } }))
      .resolves.toEqual({ skipped: 'grant_org_out_of_ceiling' });
    expect(h.chargeableUnderGrant).not.toHaveBeenCalled();
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  // W05a spot-check: the digest reads are org-wide, so a grant whose reach in
  // the org is narrowed to sites must never get an assessment there (the same
  // rule W05a's concern reads apply).
  it.each([
    ['a ceiling-wide site restriction', { siteIds: new Set(['site-1']) }],
    ['a per-org membership site restriction', { orgTerms: new Map([[ORG, { permissionKeys: new Set(['*:*']), siteIds: new Set(['site-1']) }]]) }],
  ])('returns grant_org_site_restricted for %s and admits nothing', async (_label, o) => {
    h.results.push([grantRow()]);
    h.resolveGrantCeiling.mockResolvedValue(ceiling(o));
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } }))
      .resolves.toEqual({ skipped: 'grant_org_site_restricted' });
    expect(h.chargeableUnderGrant).not.toHaveBeenCalled();
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('assessableOrgIds keeps only ceiling orgs with no site restriction', () => {
    const OTHER = OTHER_ORG;
    const c = ceiling({
      orgIds: new Set([ORG, OTHER]),
      orgTerms: new Map([[OTHER, { permissionKeys: new Set(['*:*']), siteIds: new Set(['s']) }]]),
    });
    expect([...assessableOrgIds(c as never)]).toEqual([ORG]);
    expect([...assessableOrgIds(ceiling({ orgIds: new Set([ORG, OTHER]), siteIds: new Set(['s']) }) as never)]).toEqual([]);
  });

  it('budget exhausted: notifies once, records a deterministic concern for alert.triggered, returns budget_exhausted, admits nothing', async () => {
    h.results.push([grantRow()]);
    h.chargeableUnderGrant.mockResolvedValue({ ok: false, reason: 'budget_exhausted' });
    const res = await enqueueAssessment({
      grantId: GRANT, orgId: ORG, reason: alertReason, subject: { kind: 'alert', id: ALERT },
    });
    expect(res).toEqual({ skipped: 'budget_exhausted' });
    expect(h.chargeableUnderGrant).toHaveBeenCalledWith(GRANT, 25);
    expect(h.notifyBudgetExhaustedOnce).toHaveBeenCalledTimes(1);
    expect(h.notifyBudgetExhaustedOnce).toHaveBeenCalledWith(GRANT);
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    expect(h.upsertConcern).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: PARTNER,
      orgId: ORG,
      subject: { kind: 'alert', id: ALERT },
      severity: 'low',
      summary: "alert.triggered (recorded while Wisp's budget was exhausted)",
      evidence: { eventId: 'evt-1', recordedWithoutModel: true },
      raisedByGrantId: GRANT,
    }));
    expect(h.deliverInApp).toHaveBeenCalledTimes(1);
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
    // Budget exhaustion never pauses the grant (w00).
    expect(h.pauseGrant).not.toHaveBeenCalled();
  });

  it('budget exhausted on a tick records nothing but still notifies the grantor and never pauses', async () => {
    h.results.push([grantRow()]);
    h.chargeableUnderGrant.mockResolvedValue({ ok: false, reason: 'budget_exhausted' });
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'budget_exhausted' });
    expect(h.notifyBudgetExhaustedOnce).toHaveBeenCalledTimes(1);
    expect(h.upsertConcern).not.toHaveBeenCalled();
    expect(h.deliverInApp).not.toHaveBeenCalled();
    expect(h.pauseGrant).not.toHaveBeenCalled();
  });

  it('happy path passes grant, profile assessment, kind triage, triggerKind schedule and the watermark in triggerRef', async () => {
    const finished = new Date('2026-10-24T08:00:00.000Z');
    h.results.push([grantRow()]);
    h.results.push([{ at: finished }]); // watermark
    const before = Date.now();
    const res = await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'watch', watchId: WATCH } });
    expect(res).toEqual({ runId: RUN });
    expect(h.createAndEnqueueAgentRun).toHaveBeenCalledTimes(1);
    const input = h.createAndEnqueueAgentRun.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({
      orgId: ORG,
      kind: 'triage',
      triggerKind: 'schedule',
      deviceId: null,
      profile: 'assessment',
      grant: { grantId: GRANT, grantRevisionId: REV },
      triggerRef: { wisp: { grantId: GRANT, grantRevisionId: REV, reason: { kind: 'watch', watchId: WATCH }, watermark: finished.toISOString() } },
    });
    const m = /^wisp-assess-(.+)-(\d+)$/.exec(input.dedupeKey as string);
    expect(m?.[1]).toBe(`${GRANT}-${ORG}`);
    expect(Number(m?.[2])).toBeGreaterThanOrEqual(before);
  });

  it('calls createAndEnqueueAgentRun with no ambient DB context (#1105) even when the caller holds one', async () => {
    h.results.push([grantRow()]);
    h.results.push([{ at: null }]);
    let seen: unknown = 'unset';
    h.createAndEnqueueAgentRun.mockImplementation(async () => { seen = h.ctx.current; return { created: true, run: { id: RUN } }; });
    h.ctx.current = { scope: 'request' };
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } });
    expect(seen).toBeUndefined();
  });

  it('passes the onboarding reason through triggerRef with a null watermark', async () => {
    h.results.push([grantRow()]);
    h.results.push([{ at: null }]);
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'onboarding' } });
    const input = h.createAndEnqueueAgentRun.mock.calls[0]![0] as { triggerRef: { wisp: unknown } };
    expect(input.triggerRef.wisp).toEqual({ grantId: GRANT, grantRevisionId: REV, reason: { kind: 'onboarding' }, watermark: null });
  });

  it('maps an admission skip to { skipped }', async () => {
    h.results.push([grantRow()]);
    h.results.push([{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'no_effective_agent' });
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'no_effective_agent' });
  });
});

describe('lastAssessmentWatermark', () => {
  it('is read for (grant, org, profile assessment)', async () => {
    const at = new Date('2026-10-23T22:00:00.000Z');
    h.results.push([{ at }]);
    await expect(lastAssessmentWatermark(GRANT, ORG)).resolves.toEqual(at);
    const q = h.queries[0]!;
    expect(q.table).toBe(aiAgentRuns);
    const { sql: text, params } = compile(q.where[0]);
    expect(text).toContain('"grant_id" = $');
    expect(text).toContain('"org_id" = $');
    expect(text).toContain('"profile" = $');
    expect(params).toEqual(expect.arrayContaining([GRANT, ORG, 'assessment']));
  });

  // A run that left a pending intent finishes `awaiting_approval`; excluding
  // it would re-read the same window and could re-propose the same action.
  it('counts runs that ended completed OR awaiting_approval', async () => {
    h.results.push([{ at: null }]);
    await lastAssessmentWatermark(GRANT, ORG);
    const { sql: text, params } = compile(h.queries[0]!.where[0]);
    expect(text).toMatch(/"status" in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['completed', 'awaiting_approval']));
  });

  // An event landing while run A ran (after A loaded its digest, before it
  // finished) must still be in B's window: the watermark is when A STARTED.
  it('is the latest qualifying run START (started_at, else queued_at), never finished_at', async () => {
    h.results.push([{ at: null }]);
    await lastAssessmentWatermark(GRANT, ORG);
    const selection = (h.db.select.mock.calls[0] as unknown[])[0] as { at: SQL };
    const { sql: text } = compile(selection.at);
    expect(text).toMatch(/max\(coalesce\("ai_agent_runs"\."started_at", "ai_agent_runs"\."queued_at"\)\)/);
    expect(text).not.toContain('finished_at');
  });

  // The finalizer's `assessment_partially_applied` (stored in error_code)
  // means work was dropped: that run must not advance the watermark, so the
  // next run re-assesses its window. A NULL error_code still counts.
  it('excludes a run whose finalizer reported assessment_partially_applied, null-safely', async () => {
    h.results.push([{ at: null }]);
    await lastAssessmentWatermark(GRANT, ORG);
    const { sql: text, params } = compile(h.queries[0]!.where[0]);
    expect(text).toMatch(/"error_code" is null or "ai_agent_runs"\."error_code" <> \$\d+/);
    expect(params).toContain('assessment_partially_applied');
  });

  it('is null when there is no completed assessment', async () => {
    h.results.push([{ at: null }]);
    await expect(lastAssessmentWatermark(GRANT, ORG)).resolves.toBeNull();
  });

  it('accepts a string timestamp from the driver', async () => {
    h.results.push([{ at: '2026-10-23 22:00:00+00' }]);
    await expect(lastAssessmentWatermark(GRANT, ORG)).resolves.toEqual(new Date('2026-10-23T22:00:00.000Z'));
  });
});

describe('recordDeterministicDigest', () => {
  const now = new Date('2026-10-24T15:00:00.000Z');

  it.each([
    ['alert.triggered', { kind: 'alert', id: ALERT }],
    ['integration.health_opened', { kind: 'integration', id: ALERT }],
    ['ticket.stale', { kind: 'ticket', id: ALERT }],
  ] as const)('records a low concern for %s and delivers one digest per UTC day', async (eventType, subject) => {
    await recordDeterministicDigest(GRANT, ORG, { kind: 'event', eventType, eventId: 'e9' }, { subject, ceiling: ceiling() as never, now });
    expect(h.upsertConcern).toHaveBeenCalledWith(expect.objectContaining({
      subject, severity: 'low', orgId: ORG, partnerId: PARTNER,
      summary: `${eventType} (recorded while Wisp's budget was exhausted)`,
      evidence: { eventId: 'e9', recordedWithoutModel: true },
    }));
    expect(h.deliverInApp).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER,
      orgId: ORG,
      dedupeKey: `wisp-digest-${GRANT}-2026-10-24`,
      link: `/ai/wisp/thread/${THREAD}`,
      threadId: THREAD,
      grantId: GRANT,
    }));
  });

  it('records a failed operator task, but not a successful one', async () => {
    const reason = { kind: 'event' as const, eventType: 'ai.operator.task.finished', eventId: 'e2' };
    await recordDeterministicDigest(GRANT, ORG, reason, { subject: { kind: 'task', id: ALERT }, failed: false, ceiling: ceiling() as never, now });
    expect(h.upsertConcern).not.toHaveBeenCalled();
    await recordDeterministicDigest(GRANT, ORG, reason, { subject: { kind: 'task', id: ALERT }, failed: true, ceiling: ceiling() as never, now });
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: 'tick' }],
    [{ kind: 'watch', watchId: WATCH }],
    [{ kind: 'onboarding' }],
    [{ kind: 'event', eventType: 'ai.intent.decided', eventId: 'e3' }],
  ] as const)('records nothing for %j', async (reason) => {
    const res = await recordDeterministicDigest(GRANT, ORG, reason, { subject: { kind: 'alert', id: ALERT }, ceiling: ceiling() as never, now });
    expect(res).toEqual({ recorded: false });
    expect(h.upsertConcern).not.toHaveBeenCalled();
    expect(h.deliverInApp).not.toHaveBeenCalled();
  });

  it('records nothing for an event reason without a subject, or whose subject kind does not match the event', async () => {
    await recordDeterministicDigest(GRANT, ORG, alertReason, { ceiling: ceiling() as never, now });
    await recordDeterministicDigest(GRANT, ORG, alertReason, { subject: { kind: 'ticket', id: ALERT }, ceiling: ceiling() as never, now });
    expect(h.upsertConcern).not.toHaveBeenCalled();
  });

  it('records nothing for an org outside the ceiling', async () => {
    await recordDeterministicDigest(GRANT, OTHER_ORG, alertReason, { subject: { kind: 'alert', id: ALERT }, ceiling: ceiling() as never, now });
    expect(h.upsertConcern).not.toHaveBeenCalled();
  });
});

describe('parseWispTriggerRef', () => {
  it('accepts a well-formed ref and rejects malformed ones', () => {
    const ok = { grantId: GRANT, grantRevisionId: REV, reason: { kind: 'tick' }, watermark: null };
    expect(parseWispTriggerRef({ wisp: ok })).toEqual(ok);
    expect(parseWispTriggerRef({})).toBeNull();
    expect(parseWispTriggerRef({ wisp: { ...ok, reason: { kind: 'bogus' } } })).toBeNull();
    expect(parseWispTriggerRef({ wisp: { ...ok, watermark: 'not a date' } })).toBeNull();
    expect(parseWispTriggerRef({ wisp: { ...ok, reason: { kind: 'watch' } } })).toBeNull();
  });
});

describe('loadAssessmentContext', () => {
  const watermark = '2026-10-24T06:00:00.000Z';
  const run = (o: Record<string, unknown> = {}) => ({
    id: RUN,
    orgId: ORG,
    grantId: GRANT,
    grantRevisionId: REV,
    triggerRef: { wisp: { grantId: GRANT, grantRevisionId: REV, reason: alertReason, watermark } },
    ...o,
  });
  const queueDigest = () => {
    h.results.push([{ id: 'a1', title: 'CPU\nhigh', severity: 'high', status: 'active', at: new Date('2026-10-24T07:00:00Z') }]);
    h.results.push([{ id: 't1', number: 'T-1', title: 'Printer', status: 'open', updatedAt: new Date('2026-10-24T07:30:00Z') }]);
    h.results.push([{ viewPermission: 'organizations:read' }]); // incidents: distinct view permissions present
    h.results.push([{ id: 'i1', sourceKind: 'psa', condition: 'auth_failed', openedAt: new Date('2026-10-24T08:00:00Z') }]);
    h.results.push([{ id: 'r1', profile: 'full', status: 'completed', summary: 'did a thing' }]);
    h.results.push([{ id: 'x1', toolName: 'restart_service', status: 'pending_approval' }]);
  };
  const ALL_DIGEST_KEYS = ['alerts:read', 'tickets:read', 'organizations:read', 'ai_agents:read'];
  const keys = (omit: string[] = []) => new Set(ALL_DIGEST_KEYS.filter((k) => !omit.includes(k)));
  const tablesQueried = () => new Set(h.queries.map((q) => q.table));
  beforeEach(() => {
    h.seedContextForSession.mockResolvedValue('## Wisp thread\nsummary');
    h.listConcernsForCeiling.mockResolvedValue([{ id: 'c1' }]);
    h.listWatches.mockResolvedValue([]);
    h.readinessInventory.mockResolvedValue([{ orgId: ORG, orgName: 'Acme', checks: [], missingIntegrations: [] }]);
    h.recallForGrant.mockResolvedValue([]);
  });

  it('returns null when the grant is inactive', async () => {
    h.resolveGrantCeiling.mockRejectedValue(new h.GrantInactiveError(GRANT, 'revoked'));
    await expect(loadAssessmentContext(run())).resolves.toBeNull();
    expect(h.getOrCreateThread).not.toHaveBeenCalled();
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it('returns null when the trigger ref is missing, the run carries no grant, or the ref names another grant', async () => {
    await expect(loadAssessmentContext(run({ triggerRef: {} }))).resolves.toBeNull();
    await expect(loadAssessmentContext(run({ grantId: null }))).resolves.toBeNull();
    await expect(loadAssessmentContext(run({
      triggerRef: { wisp: { grantId: OTHER_ORG, grantRevisionId: REV, reason: { kind: 'tick' }, watermark: null } },
    }))).resolves.toBeNull();
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('returns null when the grant reaches the run org only through a site restriction', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({ siteIds: new Set(['site-1']) }));
    await expect(loadAssessmentContext(run())).resolves.toBeNull();
    expect(h.getOrCreateThread).not.toHaveBeenCalled();
  });

  it('returns null when the run org has left the ceiling', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({ orgIds: new Set([OTHER_ORG]) }));
    await expect(loadAssessmentContext(run())).resolves.toBeNull();
  });

  it('builds the full context from the pinned ceiling', async () => {
    queueDigest();
    const ctx = await loadAssessmentContext(run());
    expect(h.resolveGrantCeiling).toHaveBeenCalledWith(GRANT, REV);
    expect(h.seedContextForSession).toHaveBeenCalledWith(THREAD, expect.objectContaining({ grantId: GRANT }));
    expect(h.listConcernsForCeiling).toHaveBeenCalledWith(expect.objectContaining({ grantId: GRANT }), { status: ['open', 'snoozed'], orgId: ORG });
    expect(ctx).toMatchObject({
      grantId: GRANT,
      grantRevisionId: REV,
      grantorUserId: USER,
      threadId: THREAD,
      threadSummary: '## Wisp thread\nsummary',
      openConcerns: [{ id: 'c1' }],
      changedSince: watermark,
      reason: alertReason,
      watch: null,
      readiness: { orgId: ORG, orgName: 'Acme' },
      nudgeFeedback: [],
    });
    expect(ctx!.digest.alerts).toEqual([{ id: 'a1', title: 'CPU high', severity: 'high', status: 'active', at: '2026-10-24T07:00:00.000Z' }]);
    expect(ctx!.digest.tickets).toEqual([{ id: 't1', number: 'T-1', title: 'Printer', status: 'open', updatedAt: '2026-10-24T07:30:00.000Z' }]);
    expect(ctx!.digest.incidents).toEqual([{ id: 'i1', sourceKind: 'psa', condition: 'auth_failed', openedAt: '2026-10-24T08:00:00.000Z' }]);
    expect(ctx!.digest.runs).toEqual([{ id: 'r1', profile: 'full', status: 'completed', summary: 'did a thing' }]);
    expect(ctx!.digest.intents).toEqual([{ id: 'x1', toolName: 'restart_service', status: 'pending_approval' }]);
  });

  it('pins every digest read to run.orgId, bounds it, and excludes the current run', async () => {
    queueDigest();
    await loadAssessmentContext(run());
    const tables = [alerts, tickets, connectionHealthIncidents, aiAgentRuns, actionIntents];
    for (const table of tables) {
      const q = h.queries.find((x) => x.table === table);
      expect(q, 'digest query present').toBeDefined();
      const { sql: text, params } = compile(q!.where[0]);
      expect(text).toMatch(/"org_id" = \$\d+/);
      expect(params).toContain(ORG);
      expect(params).not.toContain(OTHER_ORG);
    }
    const runsQ = h.queries.find((x) => x.table === aiAgentRuns)!;
    const { sql: runsSql, params: runsParams } = compile(runsQ.where[0]);
    expect(runsSql).toMatch(/"id" <> \$\d+/);
    expect(runsParams).toContain(RUN);
    // Every digest query is bounded at 25.
    const limitCalls = h.db.select.mock.results
      .map((r) => (r.value as { limit: { mock: { calls: unknown[][] } } }).limit.mock.calls)
      .filter((calls) => calls.length > 0);
    expect(limitCalls).toHaveLength(5);
    for (const calls of limitCalls) expect(calls[0]![0]).toBe(25);
  });

  it('falls back to now − 24 h when there is no watermark', async () => {
    queueDigest();
    const before = Date.now();
    const ctx = await loadAssessmentContext(run({
      triggerRef: { wisp: { grantId: GRANT, grantRevisionId: REV, reason: { kind: 'tick' }, watermark: null } },
    }));
    const since = Date.parse(ctx!.changedSince!);
    expect(since).toBeGreaterThanOrEqual(before - 24 * 3600_000 - 1000);
    expect(since).toBeLessThanOrEqual(Date.now() - 24 * 3600_000 + 1000);
  });

  it('resolves the reason watch from listWatches', async () => {
    queueDigest();
    const watch = { id: WATCH, kind: 'ticket_waiting', grantId: GRANT };
    h.listWatches.mockResolvedValue([{ id: 'other' }, watch]);
    const ctx = await loadAssessmentContext(run({
      triggerRef: { wisp: { grantId: GRANT, grantRevisionId: REV, reason: { kind: 'watch', watchId: WATCH }, watermark: null } },
    }));
    expect(ctx!.watch).toEqual(watch);
  });

  it('yields readiness: null when the readiness inventory fails, and reports it to Sentry', async () => {
    queueDigest();
    const err = new Error('boom');
    h.readinessInventory.mockRejectedValue(err);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = await loadAssessmentContext(run());
    expect(ctx).not.toBeNull();
    expect(ctx!.readiness).toBeNull();
    expect(h.readinessInventory).toHaveBeenCalledWith(expect.objectContaining({ grantId: GRANT }), { orgIds: [ORG] });
    expect(h.captureException).toHaveBeenCalledWith(err, undefined, expect.objectContaining({
      component: 'wisp', op: 'wisp.assessment.readiness',
    }));
    warn.mockRestore();
  });

  it('carries no nudge feedback when the recall fails, and reports it to Sentry', async () => {
    queueDigest();
    const err = new Error('recall down');
    h.recallForGrant.mockRejectedValue(err);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = await loadAssessmentContext(run());
    expect(ctx!.nudgeFeedback).toEqual([]);
    expect(h.captureException).toHaveBeenCalledWith(err, undefined, expect.objectContaining({
      component: 'wisp', op: 'wisp.assessment.nudgeFeedback',
    }));
    warn.mockRestore();
  });

  // Each digest section is what a human with the grantor's (delegated)
  // permissions could read: alerts:read, tickets:read, organizations:read
  // (+ each incident's own view permission, routes/connectionHealth.ts), and
  // ai_agents:read for runs and intents (routes/aiAgents.ts run detail).
  describe('digest sections gated on the grantor permissions', () => {
    it('a ceiling without tickets:read issues no tickets query and renders an empty tickets list', async () => {
      h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: keys(['tickets:read']) }));
      h.results.push([{ id: 'a1', title: 'CPU', severity: 'high', status: 'active', at: new Date('2026-10-24T07:00:00Z') }]);
      h.results.push([{ viewPermission: 'organizations:read' }]);
      h.results.push([{ id: 'i1', sourceKind: 'psa', condition: 'auth_failed', openedAt: new Date('2026-10-24T08:00:00Z') }]);
      h.results.push([{ id: 'r1', profile: 'full', status: 'completed', summary: null }]);
      h.results.push([{ id: 'x1', toolName: 'restart_service', status: 'pending_approval' }]);
      const ctx = await loadAssessmentContext(run());
      expect(tablesQueried().has(tickets)).toBe(false);
      expect(ctx!.digest.tickets).toEqual([]);
      expect(ctx!.digest.alerts.map((r) => r.id)).toEqual(['a1']);
      expect(ctx!.digest.incidents.map((r) => r.id)).toEqual(['i1']);
      expect(ctx!.digest.runs.map((r) => r.id)).toEqual(['r1']);
      expect(ctx!.digest.intents.map((r) => r.id)).toEqual(['x1']);
    });

    it('with only tickets:read, the tickets query runs and nothing else is read', async () => {
      h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['tickets:read']) }));
      h.results.push([{ id: 't1', number: null, title: 'Printer', status: 'open', updatedAt: new Date('2026-10-24T07:30:00Z') }]);
      const ctx = await loadAssessmentContext(run());
      const digestTables = [alerts, tickets, connectionHealthIncidents, aiAgentRuns, actionIntents];
      expect(digestTables.filter((t) => tablesQueried().has(t))).toEqual([tickets]);
      expect(ctx!.digest).toEqual({
        alerts: [], incidents: [], runs: [], intents: [],
        tickets: [{ id: 't1', number: null, title: 'Printer', status: 'open', updatedAt: '2026-10-24T07:30:00.000Z' }],
      });
    });

    it("the org's own membership term narrows it too: no alerts:read in the org term → no alerts query", async () => {
      h.resolveGrantCeiling.mockResolvedValue(ceiling({
        permissionKeys: new Set(['*:*']),
        orgTerms: new Map([[ORG, { permissionKeys: keys(['alerts:read']), siteIds: null }]]),
      }));
      h.results.push([{ id: 't1', number: 'T-1', title: 'Printer', status: 'open', updatedAt: new Date('2026-10-24T07:30:00Z') }]);
      h.results.push([]); // no incidents present
      h.results.push([]);
      h.results.push([]);
      const ctx = await loadAssessmentContext(run());
      expect(tablesQueried().has(alerts)).toBe(false);
      expect(ctx!.digest.alerts).toEqual([]);
      expect(ctx!.digest.tickets.map((r) => r.id)).toEqual(['t1']);
    });

    it('without ai_agents:read neither runs nor intents are read', async () => {
      h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: keys(['ai_agents:read']) }));
      h.results.push([], [], []);
      const ctx = await loadAssessmentContext(run());
      expect(tablesQueried().has(aiAgentRuns)).toBe(false);
      expect(tablesQueried().has(actionIntents)).toBe(false);
      expect(ctx!.digest.runs).toEqual([]);
      expect(ctx!.digest.intents).toEqual([]);
    });

    it('without organizations:read no incident is read at all', async () => {
      h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: keys(['organizations:read']) }));
      h.results.push([], [], [], []);
      const ctx = await loadAssessmentContext(run());
      expect(tablesQueried().has(connectionHealthIncidents)).toBe(false);
      expect(h.db.selectDistinct).not.toHaveBeenCalled();
      expect(ctx!.digest.incidents).toEqual([]);
    });

    it("incidents are narrowed to the view permissions the grantor holds (the route's per-row rule)", async () => {
      h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: keys() }));
      h.results.push([], []);
      h.results.push([{ viewPermission: 'organizations:read' }, { viewPermission: 'billing:read' }, { viewPermission: 'malformed' }]);
      h.results.push([{ id: 'i1', sourceKind: 'psa', condition: 'auth_failed', openedAt: new Date('2026-10-24T08:00:00Z') }]);
      h.results.push([], []);
      const ctx = await loadAssessmentContext(run());
      const incidentQueries = h.queries.filter((q) => q.table === connectionHealthIncidents);
      expect(incidentQueries).toHaveLength(2);
      const { sql: text, params } = compile(incidentQueries[1]!.where[0]);
      expect(text).toMatch(/"view_permission" in \(\$\d+\)/);
      expect(params).toContain('organizations:read');
      expect(params).not.toContain('billing:read');
      expect(params).not.toContain('malformed');
      expect(ctx!.digest.incidents.map((r) => r.id)).toEqual(['i1']);
    });

    it('when the grantor may view none of the incidents present, the incident rows are never read', async () => {
      h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: keys() }));
      h.results.push([], []);
      h.results.push([{ viewPermission: 'billing:read' }]);
      h.results.push([], []);
      const ctx = await loadAssessmentContext(run());
      expect(h.queries.filter((q) => q.table === connectionHealthIncidents)).toHaveLength(1);
      expect(ctx!.digest.incidents).toEqual([]);
    });
  });

  it('recalls at most 20 nudge_feedback preference blocks of the grantor and renders one line each', async () => {
    queueDigest();
    const blocks = Array.from({ length: 25 }, (_, i) => ({
      id: `b${i}`,
      subjectKey: `nudge_feedback:ticket:high`,
      blockType: 'preference',
      content: { useful: i % 2 === 0, concernId: 'c', summary: `Summary\n${i}`, note: i === 1 ? 'too noisy' : undefined },
    }));
    h.recallForGrant.mockResolvedValue(blocks);
    const ctx = await loadAssessmentContext(run());
    expect(h.recallForGrant).toHaveBeenCalledWith(expect.objectContaining({ grantId: GRANT }), {
      owners: ['user'], blockTypes: ['preference'], subjectKeyPrefix: 'nudge_feedback:', limit: 20,
    });
    expect(ctx!.nudgeFeedback).toHaveLength(20);
    expect(ctx!.nudgeFeedback[0]).toBe('nudge_feedback:ticket:high · useful · Summary 0');
    expect(ctx!.nudgeFeedback[1]).toBe('nudge_feedback:ticket:high · not useful · Summary 1 · note: too noisy');
    for (const line of ctx!.nudgeFeedback) expect(line).not.toContain('\n');
  });
});
