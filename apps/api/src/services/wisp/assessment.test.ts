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
  class ConcernSubjectHeldError extends Error {
    readonly code = 'concern_subject_held' as const;
    constructor(public readonly signature: string, public readonly heldByConcernId: string) { super('held'); }
  }
  const results: (unknown[] | Error)[] = [];
  const queries: { table: unknown; where: unknown[]; orderBy: unknown[] }[] = [];
  const chain = (): Record<string, unknown> => {
    const q: { table: unknown; where: unknown[]; orderBy: unknown[] } = { table: null, where: [], orderBy: [] };
    queries.push(q);
    const p: Record<string, unknown> = {};
    for (const m of ['innerJoin', 'leftJoin', 'limit', 'groupBy']) p[m] = vi.fn(() => p);
    p.orderBy = vi.fn((...cols: unknown[]) => { q.orderBy.push(...cols); return p; });
    p.from = vi.fn((t: unknown) => { q.table = t; return p; });
    p.where = vi.fn((cond: unknown) => { q.where.push(cond); return p; });
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      // A queued Error rejects that query (the read failed).
      ((r: unknown) => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r)))(results.shift() ?? []).then(res, rej);
    return p;
  };
  class GrantInactiveError extends Error {
    readonly code = 'grant_inactive' as const;
    constructor(public readonly grantId: string, public readonly status: string) { super(`inactive ${status}`); }
  }
  const ctx = { current: undefined as unknown };
  return {
    ConcernSubjectHeldError,
    results,
    queries,
    ctx,
    db: { select: vi.fn(() => chain()), selectDistinct: vi.fn(() => chain()), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
    GrantInactiveError,
    wispEnabled: vi.fn(() => true),
    hasEntitlement: vi.fn(),
    resolveGrantCeiling: vi.fn(),
    createAndEnqueueAgentRun: vi.fn(),
    transitionRunStatus: vi.fn(),
    enqueue: vi.fn(),
    chargeableUnderGrant: vi.fn(),
    notifyBudgetExhaustedOnce: vi.fn(),
    upsertConcern: vi.fn(),
    resolveConcernBySignature: vi.fn(),
    listConcernsForCeiling: vi.fn(),
    deliverInApp: vi.fn(),
    getOrCreateThread: vi.fn(),
    seedContextForSession: vi.fn(),
    updateThreadPicture: vi.fn(),
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
vi.mock('../aiAgents/runService', () => ({
  createAndEnqueueAgentRun: h.createAndEnqueueAgentRun,
  transitionRunStatus: h.transitionRunStatus,
}));
vi.mock('../aiAgents/assessmentProfile', () => ({ ASSESSMENT_BUDGET_CENTS_PER_RUN: 25 }));
vi.mock('./budget', async () => ({
  chargeableUnderGrant: h.chargeableUnderGrant,
  notifyBudgetExhaustedOnce: h.notifyBudgetExhaustedOnce,
  utcDayWindow: (now: Date) => ({ key: now.toISOString().slice(0, 10) }),
}));
vi.mock('./concerns', () => ({
  ConcernSubjectHeldError: h.ConcernSubjectHeldError,
  upsertConcern: h.upsertConcern,
  listConcernsForCeiling: h.listConcernsForCeiling,
  resolveConcernBySignature: h.resolveConcernBySignature,
}));
vi.mock('./deliver', () => ({ deliverInApp: h.deliverInApp }));
vi.mock('./threads', () => ({
  getOrCreateThread: h.getOrCreateThread,
  seedContextForSession: h.seedContextForSession,
  updateThreadPicture: h.updateThreadPicture,
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
import { metricAnomalyIncidents } from '../../db/schema/metricAnomalyIncidents';
import { tickets } from '../../db/schema/portal';
import { wispConcerns } from '../../db/schema/wispConcerns';
import {
  assessableOrgIds,
  enqueueAssessment,
  lastAssessmentWatermark,
  loadAssessmentContext,
  noChangesGateApplies,
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

  // #11424: the watch hit summary is written into trigger_ref as the scheduler
  // sent it, and parseWispTriggerRef reads the same summary back.
  it('a watch reason\'s hit summary round-trips through trigger_ref', async () => {
    h.results.push([grantRow()]);
    h.results.push([]); // no watermark
    const hits = { change: 'cleared' as const, subject: 'alert' as const, orgId: ORG, partnerWide: false, count: 0, previousCount: 2, ids: [] };
    const res = await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'watch', watchId: WATCH, hits } });
    expect(res).toEqual({ runId: RUN });
    const input = h.createAndEnqueueAgentRun.mock.calls[0]![0] as { triggerRef: Record<string, unknown> };
    expect(input.triggerRef).toEqual({ wisp: { grantId: GRANT, grantRevisionId: REV, reason: { kind: 'watch', watchId: WATCH, hits }, watermark: null } });
    // As stored (JSON) and read back.
    expect(parseWispTriggerRef(JSON.parse(JSON.stringify(input.triggerRef)))?.reason).toEqual({ kind: 'watch', watchId: WATCH, hits });
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

  it('a job occurrence key makes the dedupe key deterministic, so a retried job cannot admit a second assessment', async () => {
    h.results.push([grantRow()]);
    h.results.push([{ at: null }]);
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' }, occurrenceKey: 'wake:job-1@1700000000000' });
    h.results.push([grantRow()]);
    h.results.push([{ at: null }]);
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' }, occurrenceKey: 'wake:job-1@1700000000000' });
    const k1 = (h.createAndEnqueueAgentRun.mock.calls[0]![0] as Record<string, unknown>).dedupeKey as string;
    const k2 = (h.createAndEnqueueAgentRun.mock.calls[1]![0] as Record<string, unknown>).dedupeKey as string;
    expect(k1).toBe(k2);
    expect(k1).toMatch(new RegExp(`^wisp-assess-${GRANT}-${ORG}-o[0-9a-f]{24}$`));
    h.results.push([grantRow()]);
    h.results.push([{ at: null }]);
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' }, occurrenceKey: 'wake:job-1@1700000009999' });
    expect((h.createAndEnqueueAgentRun.mock.calls[2]![0] as Record<string, unknown>).dedupeKey).not.toBe(k1);
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

  // #10406: only a tick is rewritten to onboarding on a first look; an
  // on-demand request keeps its reason (and its open-alerts digest).
  it('an on_demand reason with no watermark stays on_demand', async () => {
    h.results.push([grantRow()]);
    h.results.push([{ at: null }]);
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'on_demand', requestId: 'req-1' } });
    const input = h.createAndEnqueueAgentRun.mock.calls[0]![0] as { triggerRef: { wisp: unknown } };
    expect(input.triggerRef.wisp).toMatchObject({ reason: { kind: 'on_demand', requestId: 'req-1' }, watermark: null });
  });

  // #10389: a floor tick for an org this grant has never assessed is its first
  // look, so it runs as onboarding (framing + readiness note) rather than as a
  // periodic "what changed" check.
  it('a tick for a never-assessed org is recorded as onboarding; a tick with a watermark stays a tick', async () => {
    h.results.push([grantRow()]);
    h.results.push([{ at: null }]);
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } });
    const first = h.createAndEnqueueAgentRun.mock.calls[0]![0] as { triggerRef: { wisp: { reason: unknown; watermark: unknown } } };
    expect(first.triggerRef.wisp).toMatchObject({ reason: { kind: 'onboarding' }, watermark: null });

    const finished = new Date('2026-10-24T08:00:00.000Z');
    h.results.push([grantRow()]);
    h.results.push([{ at: finished }]);
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } });
    const later = h.createAndEnqueueAgentRun.mock.calls[1]![0] as { triggerRef: { wisp: { reason: unknown; watermark: unknown } } };
    expect(later.triggerRef.wisp).toMatchObject({ reason: { kind: 'tick' }, watermark: finished.toISOString() });
  });

  it('an event or watch reason for a never-assessed org keeps its reason', async () => {
    for (const reason of [alertReason, { kind: 'watch' as const, watchId: WATCH }]) {
      h.createAndEnqueueAgentRun.mockClear();
      h.results.push([grantRow()]);
      h.results.push([{ at: null }]);
      await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason });
      const input = h.createAndEnqueueAgentRun.mock.calls[0]![0] as { triggerRef: { wisp: { reason: unknown } } };
      expect(input.triggerRef.wisp.reason).toEqual(reason);
    }
  });

  it('maps an admission skip to { skipped }', async () => {
    h.results.push([grantRow()]);
    h.results.push([{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'no_effective_agent' });
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'no_effective_agent' });
  });
});

// #11423: a tick or watch for an org where nothing changed since its last
// completed assessment records a `skipped / no_changes` run and makes no model
// call. event and onboarding reasons, and a first look, always run.
describe('no-changes gate (#11423)', () => {
  const WATERMARK = new Date('2026-11-08T10:00:00.000Z');
  const ANCHOR = new Date('2026-11-08T10:01:30.000Z'); // that run's finished_at
  /** The change probes, in the order enqueueAssessment issues them. */
  const PROBES = [
    { source: 'alerts', table: alerts },
    { source: 'tickets', table: tickets },
    { source: 'incidents', table: connectionHealthIncidents },
    { source: 'runs', table: aiAgentRuns },
    { source: 'intents', table: actionIntents },
    { source: 'anomalies', table: metricAnomalyIncidents },
    { source: 'concerns', table: wispConcerns },
  ] as const;
  type Source = (typeof PROBES)[number]['source'];
  const tick = { kind: 'tick' } as const;
  const watch = { kind: 'watch', watchId: WATCH } as const;

  /** grant pin → watermark → the last clean run's finish → one result per probe. */
  const queueGated = (changed: Partial<Record<Source, unknown[]>> = {}, anchor: Date | null = ANCHOR) => {
    h.results.push([grantRow()], [{ at: WATERMARK }], [{ at: anchor }]);
    for (const p of PROBES) h.results.push(changed[p.source] ?? []);
  };
  /** Everything after the grant pin, the watermark and the anchor reads. */
  const probeQueries = () => h.queries.slice(3);
  const deferredCalls = () => h.createAndEnqueueAgentRun.mock.calls.filter((c) => (c[1] as { deferEnqueue?: boolean } | undefined)?.deferEnqueue === true);

  beforeEach(() => {
    h.createAndEnqueueAgentRun.mockImplementation(async (_input: unknown, opts?: { deferEnqueue?: boolean }) => (
      opts?.deferEnqueue ? { created: true, run: { id: RUN }, enqueue: h.enqueue } : { created: true, run: { id: RUN } }
    ));
    h.transitionRunStatus.mockResolvedValue(true);
    h.enqueue.mockResolvedValue({ created: true, run: { id: RUN } });
    h.resolveConcernBySignature.mockResolvedValue({ resolved: false });
    h.listWatches.mockResolvedValue([{ id: WATCH, kind: 'alert_pattern' }]);
  });

  it.each([['tick', tick], ['alert_pattern watch', watch]] as const)(
    'a %s with an unchanged digest records a skipped no_changes run and enqueues no model run',
    async (_label, reason) => {
      queueGated();
      await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason })).resolves.toEqual({ skipped: 'no_changes' });
      // Admitted (so the ledger row carries the real agent and policy) but never enqueued.
      expect(h.createAndEnqueueAgentRun).toHaveBeenCalledTimes(1);
      expect(deferredCalls()).toHaveLength(1);
      expect(h.createAndEnqueueAgentRun.mock.calls[0]![0]).toMatchObject({
        orgId: ORG, profile: 'assessment', grant: { grantId: GRANT, grantRevisionId: REV },
        triggerRef: { wisp: { reason, watermark: WATERMARK.toISOString() } },
      });
      expect(h.enqueue).not.toHaveBeenCalled();
      expect(h.transitionRunStatus).toHaveBeenCalledTimes(1);
      expect(h.transitionRunStatus).toHaveBeenCalledWith(RUN, 'queued', 'skipped', expect.objectContaining({
        errorCode: 'no_changes', finishedAt: expect.any(Date), summary: expect.stringMatching(/nothing changed/i),
      }));
      // Every probe ran, each pinned to the org and to the last run's FINISH (not the watermark).
      const probes = probeQueries();
      expect(probes.map((q) => q.table)).toEqual(PROBES.map((p) => p.table));
      for (const q of probes) {
        const { params } = compile(q.where[0]);
        expect(params).toContain(ORG);
        expect(params).not.toContain(OTHER_ORG);
        expect(params.map(String).some((p) => p.startsWith(ANCHOR.toISOString().slice(0, 19)))).toBe(true);
        expect(params.map(String).some((p) => p.startsWith(WATERMARK.toISOString().slice(0, 19)))).toBe(false);
      }
    },
  );

  it.each(PROBES.map((p) => [p.source] as const))('a tick after a change in %s still runs the model', async (source) => {
    queueGated({ [source]: source === 'incidents' ? [{ viewPermission: 'organizations:read' }] : [{ id: 'changed' }] });
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick })).resolves.toEqual({ runId: RUN });
    expect(deferredCalls()).toHaveLength(0);
    expect(h.createAndEnqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(h.transitionRunStatus).not.toHaveBeenCalled();
    // The probes stop at the first change, and the change is this source's own
    // probe, not a later one consuming its queued result.
    expect(probeQueries().at(-1)?.table).toBe(PROBES.find((p) => p.source === source)!.table);
  });

  it('compares against the FINISH of the latest clean assessment of (grant, org) — the run the watermark starts at', async () => {
    queueGated();
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick });
    const anchorQ = h.queries[2]!;
    expect(anchorQ.table).toBe(aiAgentRuns);
    const { sql: text, params } = compile(anchorQ.where[0]);
    expect(text).toMatch(/"grant_id" = \$\d+/);
    expect(text).toMatch(/"org_id" = \$\d+/);
    expect(params).toEqual(expect.arrayContaining([GRANT, ORG, 'assessment', 'completed', 'awaiting_approval', 'assessment_partially_applied']));
    const fields = (h.db.select.mock.calls[2] as unknown[])[0] as { at: SQL };
    expect(compile(fields.at).sql).toMatch(/max\("ai_agent_runs"\."finished_at"\)/);
  });

  it('a first look (no watermark) is never gated: no probe, the tick runs as onboarding', async () => {
    h.results.push([grantRow()], [{ at: null }]);
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick })).resolves.toEqual({ runId: RUN });
    expect(probeQueries()).toEqual([]);
    expect(deferredCalls()).toHaveLength(0);
    expect(h.transitionRunStatus).not.toHaveBeenCalled();
  });

  // A ticket_waiting watch fires BECAUSE nothing changed; the tool-judged
  // kinds read state the digest never sees. Gating them would mute them.
  it.each(['ticket_waiting', 'backup_health', 'patch_compliance', 'security_findings', 'custom_query', 'ticket_cluster'])(
    'a %s watch always runs (its hits are not digest rows)',
    async (kind) => {
      h.listWatches.mockResolvedValue([{ id: WATCH, kind }]);
      queueGated();
      await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: watch })).resolves.toEqual({ runId: RUN });
      expect(probeQueries()).toEqual([]);
      expect(deferredCalls()).toHaveLength(0);
    },
  );

  it('a watch that no longer exists is not gated', async () => {
    h.listWatches.mockResolvedValue([{ id: 'another-watch', kind: 'alert_pattern' }]);
    queueGated();
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: watch })).resolves.toEqual({ runId: RUN });
    expect(deferredCalls()).toHaveLength(0);
  });

  it.each([
    ['the anchor read', () => { h.results.push([grantRow()], [{ at: WATERMARK }], new Error('db blip') as never); }],
    ['a probe', () => { h.results.push([grantRow()], [{ at: WATERMARK }], [{ at: ANCHOR }], [], new Error('column missing') as never); }],
  ])('fails open when %s throws: the assessment runs as before and the error is reported', async (_label, arrange) => {
    arrange();
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick })).resolves.toEqual({ runId: RUN });
    expect(deferredCalls()).toHaveLength(0);
    expect(h.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ op: 'wisp.assessment.noChangesProbe' }));
  });

  it('fails open when the watch lookup throws', async () => {
    h.listWatches.mockRejectedValue(new Error('db blip'));
    h.results.push([grantRow()], [{ at: WATERMARK }]);
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: watch })).resolves.toEqual({ runId: RUN });
    expect(deferredCalls()).toHaveLength(0);
  });

  it('noChangesGateApplies is pure: tick or alert_pattern watch, with a watermark', () => {
    const wm0 = new Date(0);
    expect(noChangesGateApplies(tick, wm0)).toBe(true);
    expect(noChangesGateApplies(tick, null)).toBe(false);
    expect(noChangesGateApplies(watch, wm0, 'alert_pattern')).toBe(true);
    expect(noChangesGateApplies(watch, wm0, 'backup_health')).toBe(false);
    expect(noChangesGateApplies(watch, wm0, null)).toBe(false);
    expect(noChangesGateApplies(alertReason, wm0)).toBe(false);
    expect(noChangesGateApplies({ kind: 'onboarding' }, wm0)).toBe(false);
    // #10406: a person asked for this one; it always runs.
    expect(noChangesGateApplies({ kind: 'on_demand', requestId: 'req-1' }, wm0)).toBe(false);
  });

  it('the alerts probe counts an acknowledge or dismiss as a change (it clears an "unacknowledged" watch hit)', async () => {
    queueGated();
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick });
    const { sql: text } = compile(h.queries.find((x) => x.table === alerts)!.where[0]);
    for (const col of ['triggered_at', 'acknowledged_at', 'dismissed_at', 'resolved_at']) expect(text).toContain(`"${col}" >= $`);
  });

  it('a watermark without a finished run to compare against is not gated', async () => {
    queueGated({}, null);
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick })).resolves.toEqual({ runId: RUN });
    expect(probeQueries()).toEqual([]);
    expect(h.transitionRunStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['event', alertReason],
    ['onboarding', { kind: 'onboarding' as const }],
    ['on_demand', { kind: 'on_demand' as const, requestId: 'req-1' }],
  ])('an %s reason runs regardless of the digest (no probe)', async (_label, reason) => {
    h.results.push([grantRow()], [{ at: WATERMARK }]);
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason })).resolves.toEqual({ runId: RUN });
    expect(probeQueries()).toEqual([]);
    expect(deferredCalls()).toHaveLength(0);
    expect(h.transitionRunStatus).not.toHaveBeenCalled();
  });

  it('the skip goes through admission: an admission skip is returned and handled as before', async () => {
    queueGated();
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'no_effective_agent' });
    h.upsertConcern.mockResolvedValue({ id: 'c-1', created: true });
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick })).resolves.toEqual({ skipped: 'no_effective_agent' });
    expect(h.transitionRunStatus).not.toHaveBeenCalled();
    // The no-agent readiness concern is still raised (#10143).
    expect(h.upsertConcern).toHaveBeenCalledWith(expect.objectContaining({ signature: `wisp-readiness:no-effective-agent:${ORG}` }));
  });

  it('a recorded skip closes a stale no-agent readiness concern, as an admitted run does', async () => {
    queueGated();
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick });
    expect(h.resolveConcernBySignature).toHaveBeenCalledWith(PARTNER, `wisp-readiness:no-effective-agent:${ORG}`, 'ai_agent_configured');
  });

  it.each([
    ['the transition throws', () => h.transitionRunStatus.mockRejectedValue(new Error('db blip'))],
    ['the row was no longer queued', () => h.transitionRunStatus.mockResolvedValue(false)],
  ])('fails open when the skip cannot be recorded (%s): the admitted run is enqueued as before', async (_label, arrange) => {
    queueGated();
    arrange();
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick })).resolves.toEqual({ runId: RUN });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('the runs probe ignores no_changes skips, other grants\' assessments and specialist runs; it counts a run that FINISHED since', async () => {
    queueGated();
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick });
    const q = h.queries.find((x) => x.table === aiAgentRuns && x.where.length > 0 && compile(x.where[0]).sql.includes('"depth"'));
    expect(q, 'runs probe').toBeDefined();
    const { sql: text, params } = compile(q!.where[0]);
    expect(text).toMatch(/"queued_at" >= \$\d+/);
    expect(text).toMatch(/"finished_at" > \$\d+/);
    expect(text).toMatch(/"depth" = \$\d+/);
    expect(text).toMatch(/"profile" <> \$\d+/);
    expect(text).toMatch(/"grant_id" = \$\d+/);
    expect(text).toMatch(/"error_code" <> \$\d+/);
    expect(params).toEqual(expect.arrayContaining([ORG, GRANT, 'assessment', 'skipped', 'no_changes', 0]));
  });

  it('the concerns probe ignores rows whose last write was an assessment run\'s own finalizer (the touch loop)', async () => {
    queueGated();
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick });
    const q = h.queries.find((x) => x.table === wispConcerns)!;
    const { sql: text } = compile(q.where[0]);
    expect(text).toMatch(/"updated_at" >= \$\d+/);
    expect(text).toMatch(/NOT EXISTS \(SELECT 1 FROM ai_agent_runs/);
    expect(text).toMatch(/last_assessed_run_id/);
    expect(text).toMatch(/finished_at >= "wisp_concerns"\."updated_at"/);
  });

  // #11425: the digest's metric anomalies are current state (the org's open
  // incidents), so the probe asks whether that set changed since the last
  // run's finish: an incident announced since on a still-open episode joins
  // it, and an episode closed since takes its incident off it. The automatic
  // close backdates `resolved_at` to the end of the anomalous data
  // (metricAnomalyEpisodes.ts) but stamps `updated_at` with the close, so a
  // `resolved` episode is also read by `updated_at`. A `dismissed` one is
  // not: a snoozed episode stays live and keeps refreshing `updated_at`.
  it('the anomalies probe counts an incident announced since, or its episode closed since, among announced unsuppressed incidents', async () => {
    queueGated();
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick });
    const q = h.queries.find((x) => x.table === metricAnomalyIncidents);
    expect(q, 'anomalies probe').toBeDefined();
    const { sql: text, params } = compile(q!.where[0]);
    expect(text).toMatch(/"metric_anomaly_incidents"\."org_id" = \$\d+/);
    expect(text).toMatch(/"metric_anomaly_incidents"\."dispatched_at" is not null/);
    expect(text).toMatch(/"metric_anomaly_incidents"\."suppressed_by_episode" = \$\d+/);
    expect(text).toMatch(/"metric_anomaly_episodes"\."status" = \$\d+ and "metric_anomaly_incidents"\."dispatched_at" >= \$\d+/);
    expect(text).toMatch(new RegExp(
      '"metric_anomaly_episodes"\\."status" <> \\$\\d+ and \\("metric_anomaly_episodes"\\."resolved_at" >= \\$\\d+'
      + ' or \\("metric_anomaly_episodes"\\."status" = \\$\\d+ and "metric_anomaly_episodes"\\."updated_at" >= \\$\\d+\\)\\)',
    ));
    expect(params).toEqual(expect.arrayContaining([ORG, false, 'open', 'resolved']));
  });

  it('without devices:read the anomalies are not probed (the digest does not read them either)', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['alerts:read', 'tickets:read', 'organizations:read', 'ai_agents:read']) }));
    h.results.push([grantRow()], [{ at: WATERMARK }], [{ at: ANCHOR }], [], [], [], [], [], []); // alerts … intents, concerns
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick })).resolves.toEqual({ skipped: 'no_changes' });
    expect(probeQueries().map((q) => q.table)).not.toContain(metricAnomalyIncidents);
  });

  it('an incident whose view permission is outside the ceiling is not a change', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['alerts:read', 'tickets:read', 'organizations:read', 'ai_agents:read']) }));
    queueGated({ incidents: [{ viewPermission: 'billing:read' }] });
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick })).resolves.toEqual({ skipped: 'no_changes' });
  });

  it('a section the grantor may not read is not probed (it renders empty in the digest too)', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['tickets:read']) }));
    h.results.push([grantRow()], [{ at: WATERMARK }], [{ at: ANCHOR }], [], []); // tickets, concerns
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick })).resolves.toEqual({ skipped: 'no_changes' });
    expect(probeQueries().map((q) => q.table)).toEqual([tickets, wispConcerns]);
  });

  it('counts the skip as wisp_assessments_total{outcome="skipped_no_changes"}', async () => {
    queueGated();
    wm.incWispAssessment.mockClear();
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: tick });
    expect(wm.incWispAssessment).toHaveBeenLastCalledWith('skipped_no_changes');
    expect(wm.incWispAssessment).not.toHaveBeenCalledWith('admitted');
  });
});

describe('no_effective_agent readiness concern (#10143)', () => {
  const SIG = `wisp-readiness:no-effective-agent:${ORG}`;
  beforeEach(() => {
    h.upsertConcern.mockReset();
    h.resolveConcernBySignature.mockReset();
    h.upsertConcern.mockResolvedValue({ id: 'c-1', created: true });
    h.resolveConcernBySignature.mockResolvedValue({ resolved: false });
  });

  it('raises ONE info readiness concern (#10386: not the org slot) keyed by signature, with an /settings/ai-agents href, when admission skips for no_effective_agent', async () => {
    h.results.push([grantRow()], [{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'no_effective_agent' });
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'no_effective_agent' });
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    const arg = h.upsertConcern.mock.calls[0]![0] as Record<string, any>;
    expect(arg).toMatchObject({
      partnerId: PARTNER, orgId: ORG, subject: { kind: 'readiness', id: ORG }, severity: 'info', signature: SIG, raisedByGrantId: GRANT,
    });
    // #10292: assessments run as the TRIAGE agent, so the copy names that kind —
    // an enabled agent of another kind (e.g. Patching) does not satisfy it.
    expect(arg.summary).toMatch(/Triage agent/);
    expect(arg.summary).not.toMatch(/no AI agent is configured/);
    expect(arg.summary).toMatch(/Settings → AI Agents/);
    expect(arg.evidence).toEqual({ href: '/settings/ai-agents', reason: 'no_effective_agent' });
    expect(h.resolveConcernBySignature).not.toHaveBeenCalled();
  });

  it('a second skipped tick re-upserts the same signature (idempotent key, no new row)', async () => {
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'no_effective_agent' });
    h.upsertConcern.mockResolvedValue({ id: 'c-1', created: false });
    for (let i = 0; i < 2; i++) {
      h.results.push([grantRow()], [{ at: null }]);
      await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } });
    }
    const sigs = h.upsertConcern.mock.calls.map((c) => (c[0] as { signature: string }).signature);
    expect(sigs).toEqual([SIG, SIG]);
  });

  it('a different org gets a different signature', async () => {
    h.results.push([grantRow()], [{ at: null }]);
    h.resolveGrantCeiling.mockResolvedValueOnce(ceiling({ orgIds: new Set([ORG, OTHER_ORG]) }));
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'no_effective_agent' });
    await enqueueAssessment({ grantId: GRANT, orgId: OTHER_ORG, reason: { kind: 'tick' } });
    expect((h.upsertConcern.mock.calls[0]![0] as { signature: string }).signature)
      .toBe(`wisp-readiness:no-effective-agent:${OTHER_ORG}`);
  });

  // #10386: only the onboarding readiness note can hold the readiness slot;
  // with no agent it is moot, so it yields to the no-agent note.
  it('an onboarding readiness note holding the slot is resolved, then the no-agent note is raised', async () => {
    h.results.push([grantRow()], [{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'no_effective_agent' });
    h.upsertConcern
      .mockRejectedValueOnce(new h.ConcernSubjectHeldError(SIG, 'onboarding-note'))
      .mockResolvedValueOnce({ id: 'c-2', created: true });
    h.resolveConcernBySignature.mockResolvedValue({ resolved: true });
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'no_effective_agent' });
    expect(h.resolveConcernBySignature).toHaveBeenCalledWith(PARTNER, `readiness:${ORG}`, 'superseded_no_effective_agent');
    expect(h.upsertConcern).toHaveBeenCalledTimes(2);
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('a held slot that is not the onboarding note is reported once, with no retry', async () => {
    h.results.push([grantRow()], [{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'no_effective_agent' });
    h.upsertConcern.mockRejectedValue(new h.ConcernSubjectHeldError(SIG, 'someone-else'));
    h.resolveConcernBySignature.mockResolvedValue({ resolved: false });
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'no_effective_agent' });
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('a failing raise never changes the skip result (reported, not thrown)', async () => {
    h.results.push([grantRow()], [{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'no_effective_agent' });
    h.upsertConcern.mockRejectedValue(new Error('db down'));
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped: 'no_effective_agent' });
    expect(h.captureException).toHaveBeenCalled();
  });

  // #10292: readiness means "an ENABLED Triage agent resolves" — the same
  // partner-baseline → org-override merge admission uses. A Triage agent that
  // resolves but is turned off (or set to mode off) cannot check either.
  it.each(['agent_disabled', 'mode_off'] as const)('raises the same concern when the Triage agent resolves but %s', async (skipped) => {
    h.results.push([grantRow()], [{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped });
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ skipped });
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    const arg = h.upsertConcern.mock.calls[0]![0] as Record<string, any>;
    expect(arg).toMatchObject({ partnerId: PARTNER, orgId: ORG, signature: SIG, raisedByGrantId: GRANT });
    expect(arg.summary).toMatch(/Triage agent/);
    expect(h.resolveConcernBySignature).not.toHaveBeenCalled();
  });

  it('another admission skip raises nothing and closes a stale "no agent" concern (an agent resolved)', async () => {
    h.results.push([grantRow()], [{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'cooldown' });
    await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } });
    expect(h.upsertConcern).not.toHaveBeenCalled();
    expect(h.resolveConcernBySignature).toHaveBeenCalledWith(PARTNER, SIG, 'ai_agent_configured');
  });

  it('resolves the concern by signature once an assessment is actually admitted', async () => {
    h.results.push([grantRow()], [{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: RUN } });
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ runId: RUN });
    expect(h.resolveConcernBySignature).toHaveBeenCalledWith(PARTNER, SIG, 'ai_agent_configured');
    expect(h.upsertConcern).not.toHaveBeenCalled();
  });

  it('a failing resolve never fails an admitted run', async () => {
    h.results.push([grantRow()], [{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: RUN } });
    h.resolveConcernBySignature.mockRejectedValue(new Error('db down'));
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } })).resolves.toEqual({ runId: RUN });
    expect(h.captureException).toHaveBeenCalled();
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

  // W07: a run check-in's assessment answers one follow-up; it must not move
  // the org's digest window (events since the last real look would be skipped).
  it('W07: never counts a check-in run', async () => {
    h.results.push([{ at: null }]);
    await lastAssessmentWatermark(GRANT, ORG);
    const { sql: text, params } = compile(h.queries[0]!.where[0]);
    expect(text).toMatch(/"trigger_ref" -> 'wisp' -> 'reason' ->> 'kind'/);
    expect(params).toContain('check_in');
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

  // #11424: the scheduler's watch hit summary survives the trigger_ref
  // round-trip; a malformed one is dropped without losing the watch reason.
  it('keeps a well-formed watch hit summary and drops a malformed one, keeping the watch reason', () => {
    const base = { grantId: GRANT, grantRevisionId: REV, watermark: null };
    const hits = { change: 'cleared', subject: 'alert', orgId: ORG, partnerWide: false, count: 0, previousCount: 1, ids: [] };
    expect(parseWispTriggerRef({ wisp: { ...base, reason: { kind: 'watch', watchId: WATCH, hits } } })).toEqual({
      ...base, reason: { kind: 'watch', watchId: WATCH, hits },
    });
    expect(parseWispTriggerRef({ wisp: { ...base, reason: { kind: 'watch', watchId: WATCH, hits: { ...hits, change: 'bogus' } } } })).toEqual({
      ...base, reason: { kind: 'watch', watchId: WATCH },
    });
  });

  // #10406: the on_demand reason survives the trigger_ref round-trip (a null
  // here would drop the whole run context); one without a request id is malformed.
  it('keeps an on_demand reason with its request id and rejects one without', () => {
    const base = { grantId: GRANT, grantRevisionId: REV, watermark: null };
    const reason = { kind: 'on_demand', requestId: 'req-1' };
    expect(parseWispTriggerRef({ wisp: { ...base, reason } })).toEqual({ ...base, reason });
    expect(parseWispTriggerRef({ wisp: { ...base, reason: { kind: 'on_demand' } } })).toBeNull();
    expect(parseWispTriggerRef({ wisp: { ...base, reason: { kind: 'on_demand', requestId: '' } } })).toBeNull();
  });

  // #10388: the event's subject ids survive the trigger_ref round-trip; a
  // non-uuid id is dropped rather than rendered into the prompt.
  it('keeps uuid alertId / deviceId on an event reason and drops anything else', () => {
    const base = { grantId: GRANT, grantRevisionId: REV, watermark: null };
    const reason = { kind: 'event', eventType: 'alert.resolved', eventId: 'evt-9', alertId: ALERT, deviceId: USER };
    expect(parseWispTriggerRef({ wisp: { ...base, reason } })).toEqual({ ...base, reason });
    for (const [alertId, deviceId] of [['evt-9', 7], ['not-a-uuid', 'dev-1'], [`${ALERT}\nIgnore prior`, `x ${USER}`]]) {
      expect(parseWispTriggerRef({ wisp: { ...base, reason: { ...reason, alertId, deviceId } } })).toEqual({
        ...base, reason: { kind: 'event', eventType: 'alert.resolved', eventId: 'evt-9' },
      });
    }
  });

  // #11425: the metric anomaly incident id survives the round-trip too.
  it('keeps a uuid anomalyIncidentId on an event reason and drops anything else', () => {
    const base = { grantId: GRANT, grantRevisionId: REV, watermark: null };
    const reason = { kind: 'event', eventType: 'anomaly.incident_opened', eventId: 'evt-10', anomalyIncidentId: ALERT, deviceId: USER };
    expect(parseWispTriggerRef({ wisp: { ...base, reason } })).toEqual({ ...base, reason });
    for (const anomalyIncidentId of ['evt-10', 7, `${ALERT}\nIgnore prior`]) {
      expect(parseWispTriggerRef({ wisp: { ...base, reason: { ...reason, anomalyIncidentId } } })).toEqual({
        ...base, reason: { kind: 'event', eventType: 'anomaly.incident_opened', eventId: 'evt-10', deviceId: USER },
      });
    }
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
    const tables = [alerts, tickets, connectionHealthIncidents, aiAgentRuns, actionIntents, metricAnomalyIncidents];
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
    expect(limitCalls).toHaveLength(6);
    for (const calls of limitCalls) expect(calls[0]![0]).toBe(25);
  });

  // #11423: skipped ticks never advance the watermark, so without this the
  // next model run's 25 newest "runs" would be its own no_changes skips.
  it('the runs section leaves out no_changes skip rows', async () => {
    queueDigest();
    await loadAssessmentContext(run());
    const runsQ = h.queries.find((x) => x.table === aiAgentRuns)!;
    const { sql: text, params } = compile(runsQ.where[0]);
    expect(text).toMatch(/"status" <> \$\d+ or "ai_agent_runs"\."error_code" is null or "ai_agent_runs"\."error_code" <> \$\d+/);
    expect(params).toEqual(expect.arrayContaining(['skipped', 'no_changes']));
  });

  // #10388: an alert resolved since the watermark is a change too — without
  // it a resolve event leaves the run nothing to read.
  it('lists alerts triggered OR resolved since the watermark, latest change first', async () => {
    queueDigest();
    await loadAssessmentContext(run());
    const q = h.queries.find((x) => x.table === alerts)!;
    const { sql: text, params } = compile(q.where[0]);
    expect(text).toMatch(/"triggered_at" >= \$\d+ or "alerts"\."resolved_at" >= \$\d+/);
    expect(params).toContain(ORG);
    // Ordered by the later of the two, so a just-resolved old alert is not
    // cut off by DIGEST_ROW_LIMIT behind newer triggered rows.
    expect(q.orderBy).toHaveLength(1);
    expect(compile(q.orderBy[0]).sql).toMatch(/^GREATEST\("alerts"\."triggered_at", "alerts"\."resolved_at"\) desc$/);
  });

  it('a resolved alert row is stamped with its resolve time, an open one with its trigger time', async () => {
    h.results.push([
      { id: 'a2', title: 'EDR', severity: 'high', status: 'resolved', at: new Date('2026-10-20T07:00:00Z'), resolvedAt: new Date('2026-10-24T08:00:00Z') },
      { id: 'a1', title: 'CPU', severity: 'high', status: 'active', at: new Date('2026-10-24T07:00:00Z'), resolvedAt: null },
    ]);
    const ctx = await loadAssessmentContext(run());
    expect(ctx!.digest.alerts.map((a) => [a.id, a.status, a.at])).toEqual([
      ['a2', 'resolved', '2026-10-24T08:00:00.000Z'],
      ['a1', 'active', '2026-10-24T07:00:00.000Z'],
    ]);
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

  // #10389: with no watermark the run is the org's first look; a 24 h window
  // on triggered_at hid a high alert open for weeks. The first look reads the
  // org's OPEN alerts instead, worst first, still bounded at 25.
  describe('first look (no watermark)', () => {
    const firstLookRun = (reason: Record<string, unknown> = { kind: 'tick' }) => run({
      triggerRef: { wisp: { grantId: GRANT, grantRevisionId: REV, reason, watermark: null } },
    });
    const alertsSelect = () => {
      const i = h.queries.findIndex((x) => x.table === alerts);
      return { q: h.queries[i]!, chain: h.db.select.mock.results[i]!.value as Record<string, { mock: { calls: unknown[][] } }> };
    };

    it('lists the org\'s open alerts with no time bound, worst severity first, bounded at 25', async () => {
      queueDigest();
      const ctx = await loadAssessmentContext(firstLookRun());
      expect(ctx!.firstLook).toBe(true);
      expect(ctx!.noEarlierAssessment).toBe(true);
      const { q, chain } = alertsSelect();
      const { sql: text, params } = compile(q.where[0]);
      expect(text).toMatch(/"org_id" = \$\d+/);
      expect(params).toContain(ORG);
      expect(text).toMatch(/"status" in \(\$\d+, \$\d+\)/);
      expect(params).toEqual(expect.arrayContaining(['active', 'acknowledged']));
      expect(text).not.toMatch(/triggered_at/);
      const order = chain.orderBy!.mock.calls[0]!.map((c) => compile(c).sql);
      expect(order).toEqual(['"alerts"."severity" asc', '"alerts"."triggered_at" desc']);
      expect(chain.limit!.mock.calls[0]![0]).toBe(25);
      // The row is the open alert, stamped with when it fired.
      expect(ctx!.digest.alerts).toEqual([{ id: 'a1', title: 'CPU high', severity: 'high', status: 'active', at: '2026-10-24T07:00:00.000Z' }]);
    });

    it('applies to an onboarding or event reason too, and the other sections keep the 24 h window', async () => {
      for (const reason of [{ kind: 'onboarding' }, alertReason]) {
        h.queries.length = 0;
        h.db.select.mockClear();
        queueDigest();
        const ctx = await loadAssessmentContext(firstLookRun(reason));
        expect(ctx!.firstLook).toBe(true);
        expect(compile(alertsSelect().q.where[0]).sql).not.toMatch(/triggered_at/);
        const ticketsQ = h.queries.find((x) => x.table === tickets)!;
        expect(compile(ticketsQ.where[0]).sql).toMatch(/"updated_at" >= \$\d+/);
      }
    });

    it('a run with a watermark is not a first look and keeps the triggered-since window', async () => {
      queueDigest();
      const ctx = await loadAssessmentContext(run());
      expect(ctx!.firstLook).toBe(false);
      const { q } = alertsSelect();
      expect(compile(q.where[0]).sql).toMatch(/"triggered_at" >= \$\d+/);
    });

    it('the open-alerts read stays gated on alerts:read (ceiling and org term): no alerts query, empty section', async () => {
      for (const c of [
        ceiling({ permissionKeys: keys(['alerts:read']) }),
        ceiling({ permissionKeys: new Set(['*:*']), orgTerms: new Map([[ORG, { permissionKeys: keys(['alerts:read']), siteIds: null }]]) }),
      ]) {
        h.queries.length = 0;
        h.results.length = 0;
        h.resolveGrantCeiling.mockResolvedValue(c);
        h.results.push([{ id: 't1', number: 'T-1', title: 'Printer', status: 'open', updatedAt: new Date('2026-10-24T07:30:00Z') }]);
        h.results.push([], [], []);
        const ctx = await loadAssessmentContext(firstLookRun());
        expect(ctx!.firstLook).toBe(true);
        expect(tablesQueried().has(alerts)).toBe(false);
        expect(ctx!.digest.alerts).toEqual([]);
        expect(ctx!.digest.tickets.map((r) => r.id)).toEqual(['t1']);
      }
    });

    // #10406: "go through the open alerts" — an on-demand assessment reads the
    // org's open alerts, not the since-watermark window, even with a watermark.
    it('an on_demand reason reads the open alerts even when a watermark exists', async () => {
      queueDigest();
      const ctx = await loadAssessmentContext(run({
        triggerRef: { wisp: { grantId: GRANT, grantRevisionId: REV, reason: { kind: 'on_demand', requestId: 'req-1' }, watermark } },
      }));
      expect(ctx!.firstLook).toBe(true);
      // An earlier assessment exists, so this run must not create the readiness note (#11429).
      expect(ctx!.noEarlierAssessment).toBe(false);
      expect(ctx!.reason).toEqual({ kind: 'on_demand', requestId: 'req-1' });
      const { q, chain } = alertsSelect();
      expect(compile(q.where[0]).sql).not.toMatch(/triggered_at/);
      expect(compile(q.where[0]).sql).toMatch(/"status" in \(\$\d+, \$\d+\)/);
      expect(chain.orderBy!.mock.calls[0]!.map((c) => compile(c).sql)).toEqual(['"alerts"."severity" asc', '"alerts"."triggered_at" desc']);
    });

    it('an onboarding reason is a first look even when a watermark exists', async () => {
      queueDigest();
      const ctx = await loadAssessmentContext(run({
        triggerRef: { wisp: { grantId: GRANT, grantRevisionId: REV, reason: { kind: 'onboarding' }, watermark } },
      }));
      expect(ctx!.firstLook).toBe(true);
      expect(ctx!.noEarlierAssessment).toBe(false);
      expect(compile(alertsSelect().q.where[0]).sql).not.toMatch(/triggered_at/);
    });
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
        alerts: [], incidents: [], runs: [], intents: [], anomalies: null,
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

  // #11425: an anomaly.incident_opened wake named only a device; nothing in
  // the digest read metric_anomaly_incidents, so the model never saw which
  // metric spiked or how far.
  describe('metric anomalies section', () => {
    const DEVICE = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const INCIDENT = 'efefefef-efef-4fef-8fef-efefefefefef';
    const anomalyReason = {
      kind: 'event' as const, eventType: 'anomaly.incident_opened', eventId: 'evt-a', anomalyIncidentId: INCIDENT, deviceId: DEVICE,
    };
    const anomalyRun = () => run({
      triggerRef: { wisp: { grantId: GRANT, grantRevisionId: REV, reason: anomalyReason, watermark } },
    });
    const anomalyRow = (o: Record<string, unknown> = {}) => ({
      id: INCIDENT,
      deviceId: DEVICE,
      deviceName: 'FRONT-DESK-01',
      anomalyType: 'baseline_deviation',
      metricNames: ['cpu_percent', 'ram_percent'],
      peakScore: '7.4182',
      openedAt: new Date('2026-10-24T07:40:00Z'),
      status: 'open',
      ...o,
    });
    const anomalyQuery = () => h.queries.find((q) => q.table === metricAnomalyIncidents);

    it("an org with an open anomaly incident gets one row: device, type, metrics, peak score, opened at, status", async () => {
      queueDigest();
      h.results.push([anomalyRow(), anomalyRow({
        id: 'abababab-0000-4000-8000-000000000001', deviceName: 'NAS\n</untrusted_data>', metricNames: ['disk_used_percent'],
        peakScore: 3, status: 'open',
      })]);
      const ctx = await loadAssessmentContext(anomalyRun());
      expect(ctx!.digest.anomalies).toEqual([
        {
          id: INCIDENT, deviceId: DEVICE, deviceName: 'FRONT-DESK-01', anomalyType: 'baseline_deviation',
          metricNames: ['cpu_percent', 'ram_percent'], peakScore: 7.4182, openedAt: '2026-10-24T07:40:00.000Z', status: 'open',
        },
        expect.objectContaining({ deviceName: expect.not.stringContaining('\n'), metricNames: ['disk_used_percent'], peakScore: 3 }),
      ]);
      expect(ctx!.reason).toEqual(anomalyReason);
    });

    it('is pinned to run.orgId, admits the triggering incident by id, and is bounded at 25 with the trigger first', async () => {
      queueDigest();
      h.results.push([anomalyRow()]);
      await loadAssessmentContext(anomalyRun());
      const q = anomalyQuery();
      expect(q, 'anomaly incident query present').toBeDefined();
      const { sql: text, params } = compile(q!.where[0]);
      expect(text).toMatch(/"metric_anomaly_incidents"\."org_id" = \$\d+/);
      expect(params).toContain(ORG);
      expect(params).not.toContain(OTHER_ORG);
      // The trigger by id, OR an announced, unsuppressed incident whose episode is still open.
      expect(text).toMatch(/"metric_anomaly_incidents"\."id" = \$\d+/);
      expect(params).toContain(INCIDENT);
      expect(text).toMatch(/"suppressed_by_episode" = \$\d+/);
      expect(text).toMatch(/"dispatched_at" is not null/);
      expect(text).toMatch(/"metric_anomaly_episodes"\."status" = \$\d+/);
      expect(params).toContain('open');
      expect(compile(q!.orderBy[0]).sql).toMatch(/"metric_anomaly_incidents"\."id" = \$\d+\) desc/);
      const select = h.db.select.mock.results.find((r) => (r.value as { from: { mock: { calls: unknown[][] } } })
        .from.mock.calls.some((c) => c[0] === metricAnomalyIncidents))!;
      expect((select.value as { limit: { mock: { calls: unknown[][] } } }).limit.mock.calls[0]![0]).toBe(25);
    });

    it('a run with no anomaly trigger still lists the open ones, with no id term', async () => {
      queueDigest();
      h.results.push([]);
      const ctx = await loadAssessmentContext(run());
      const { sql: text } = compile(anomalyQuery()!.where[0]);
      expect(text).not.toMatch(/"metric_anomaly_incidents"\."id" = /);
      expect(text).toMatch(/"metric_anomaly_episodes"\."status" = \$\d+/);
      expect(ctx!.digest.anomalies).toEqual([]);
    });

    it('is gated on devices:read (the anomalies route): without it no anomaly query runs and the section is null (not read)', async () => {
      h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: keys() }));
      queueDigest();
      const ctx = await loadAssessmentContext(anomalyRun());
      expect(tablesQueried().has(metricAnomalyIncidents)).toBe(false);
      expect(ctx!.digest.anomalies).toBeNull();
    });

    it("the org's own membership term narrows the gate too: no devices:read in the org term → no anomaly query", async () => {
      h.resolveGrantCeiling.mockResolvedValue(ceiling({
        permissionKeys: new Set(['*:*']),
        orgTerms: new Map([[ORG, { permissionKeys: keys(), siteIds: null }]]),
      }));
      queueDigest();
      const ctx = await loadAssessmentContext(anomalyRun());
      expect(tablesQueried().has(metricAnomalyIncidents)).toBe(false);
      expect(ctx!.digest.anomalies).toBeNull();
    });

    it('keeps at most 10 metric names per incident', async () => {
      queueDigest();
      h.results.push([anomalyRow({ metricNames: Array.from({ length: 12 }, (_, i) => `m${i}`) })]);
      const ctx = await loadAssessmentContext(anomalyRun());
      expect(ctx!.digest.anomalies![0]!.metricNames).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
    });

    it('runs in its own system context, after the other digest reads', async () => {
      queueDigest();
      h.results.push([anomalyRow()]);
      await loadAssessmentContext(anomalyRun());
      const { withSystemDbAccessContext } = await import('../../db');
      const labels = vi.mocked(withSystemDbAccessContext).mock.calls.map((c) => c[1]);
      expect(labels).toContain('wisp.assessment.digest.anomalies');
      expect(labels.indexOf('wisp.assessment.digest.anomalies')).toBeGreaterThan(labels.indexOf('wisp.assessment.digest'));
    });

    it('a failing anomaly read degrades to null, reports to Sentry, and leaves the other sections intact', async () => {
      queueDigest();
      h.results.push(new Error('statement timeout'));
      const ctx = await loadAssessmentContext(anomalyRun());
      expect(ctx).not.toBeNull();
      expect(ctx!.digest.anomalies).toBeNull();
      expect(ctx!.digest.alerts.map((r) => r.id)).toEqual(['a1']);
      expect(ctx!.digest.intents.map((r) => r.id)).toEqual(['x1']);
      expect(h.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'statement timeout' }),
        undefined,
        expect.objectContaining({ component: 'wisp', op: 'wisp.assessment.anomalies', runId: RUN, orgId: ORG }),
      );
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

// --- W07 Task 8: metrics call sites ---
const wm = vi.hoisted(() => ({
  incWispAssessment: vi.fn(), incWispNudge: vi.fn(), incWispConcern: vi.fn(),
  incWispGrantPause: vi.fn(), incWispBudgetExhausted: vi.fn(), setWispGrantsActive: vi.fn(),
}));
vi.mock('../wispMetrics', () => wm);

describe('enqueueAssessment metrics', () => {
  it('maps results to wisp_assessments_total outcomes', async () => {
    const input = { grantId: GRANT, orgId: ORG, reason: { kind: 'tick' } } as const;
    wm.incWispAssessment.mockClear();
    h.results.push([grantRow()]);
    await enqueueAssessment({ ...input, orgId: OTHER_ORG });
    expect(wm.incWispAssessment).toHaveBeenLastCalledWith('skipped_grant');

    h.results.push([grantRow()]);
    h.chargeableUnderGrant.mockResolvedValue({ ok: false, reason: 'budget_exhausted' });
    await enqueueAssessment({ ...input });
    expect(wm.incWispAssessment).toHaveBeenLastCalledWith('skipped_budget');

    h.chargeableUnderGrant.mockResolvedValue({ ok: true });
    h.results.push([grantRow()], [{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'no_effective_agent' });
    await enqueueAssessment({ ...input });
    expect(wm.incWispAssessment).toHaveBeenLastCalledWith('skipped_admission');

    h.results.push([grantRow()], [{ at: null }]);
    h.createAndEnqueueAgentRun.mockResolvedValue({ created: true, run: { id: RUN } });
    await enqueueAssessment({ ...input });
    expect(wm.incWispAssessment).toHaveBeenLastCalledWith('admitted');
  });
});

// W07 (#11496, #10410 wave B): a run-mode check-in admits one assessment run
// with its own dedupe key, pinned to the revision it was scheduled under.
describe('check_in reason (W07)', () => {
  const CHECK_IN = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  const evidence = { kind: 'script_finished' as const, status: 'completed', at: '2026-10-24T07:00:00.000Z', exitCode: 0, outputHead: 'all ok' };
  const reason = { kind: 'check_in' as const, checkInId: CHECK_IN, instruction: 'Check the patch scan on WS-01.', evidence };

  it('a check-in dedupe key replaces the derived key, verbatim', async () => {
    h.results.push([grantRow()]);
    h.results.push([{ at: null }]);
    const res = await enqueueAssessment({ grantId: GRANT, orgId: ORG, reason, dedupeKey: `wisp-check-in-${CHECK_IN}` });
    expect(res).toEqual({ runId: RUN });
    const input = h.createAndEnqueueAgentRun.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.dedupeKey).toBe(`wisp-check-in-${CHECK_IN}`);
    expect(input.triggerRef).toEqual({ wisp: { grantId: GRANT, grantRevisionId: REV, reason, watermark: null } });
  });

  it('refuses a dedupe key outside the wisp-check-in- namespace before reading anything', async () => {
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason, dedupeKey: 'alert:abc' })).rejects.toThrow(/wisp-check-in-/);
    expect(h.db.select).not.toHaveBeenCalled();
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('a required revision that is no longer current admits nothing and charges nothing', async () => {
    h.results.push([grantRow({ currentRevisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })]);
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason, requireRevisionId: REV }))
      .resolves.toEqual({ skipped: 'grant_revision_changed' });
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
    expect(h.chargeableUnderGrant).not.toHaveBeenCalled();
    expect(h.createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('a required revision that is current admits as usual', async () => {
    h.results.push([grantRow()]);
    h.results.push([{ at: null }]);
    await expect(enqueueAssessment({ grantId: GRANT, orgId: ORG, reason, requireRevisionId: REV })).resolves.toEqual({ runId: RUN });
  });

  it('a check_in reason never takes the no-changes gate, even with a watermark', () => {
    expect(noChangesGateApplies(reason, new Date())).toBe(false);
  });

  it('round-trips through trigger_ref with its evidence; malformed evidence is dropped, a missing id or instruction is malformed', () => {
    const base = { grantId: GRANT, grantRevisionId: REV, watermark: null };
    expect(parseWispTriggerRef({ wisp: { ...base, reason } })).toEqual({ ...base, reason });
    expect(parseWispTriggerRef({ wisp: { ...base, reason: { ...reason, evidence: null } } })).toEqual({ ...base, reason: { ...reason, evidence: null } });
    for (const bad of [{ kind: 'bogus', status: 'x', at: evidence.at }, { ...evidence, at: 'not a date' }, 'text', { ...evidence, status: 7 }]) {
      expect(parseWispTriggerRef({ wisp: { ...base, reason: { ...reason, evidence: bad } } })).toEqual({ ...base, reason: { ...reason, evidence: null } });
    }
    expect(parseWispTriggerRef({ wisp: { ...base, reason: { ...reason, checkInId: 'not-a-uuid' } } })).toBeNull();
    expect(parseWispTriggerRef({ wisp: { ...base, reason: { ...reason, instruction: '' } } })).toBeNull();
  });

  it('a check_in run is never a first look, even with no earlier assessment', async () => {
    h.seedContextForSession.mockResolvedValue('summary');
    h.listConcernsForCeiling.mockResolvedValue([]);
    h.listWatches.mockResolvedValue([]);
    h.readinessInventory.mockResolvedValue([]);
    h.recallForGrant.mockResolvedValue([]);
    const ctx = await loadAssessmentContext({
      id: RUN, orgId: ORG, grantId: GRANT, grantRevisionId: REV,
      triggerRef: { wisp: { grantId: GRANT, grantRevisionId: REV, reason, watermark: null } },
    });
    expect(ctx!.firstLook).toBe(false);
    expect(ctx!.noEarlierAssessment).toBe(true);
    expect(ctx!.reason).toEqual(reason);
  });
});
