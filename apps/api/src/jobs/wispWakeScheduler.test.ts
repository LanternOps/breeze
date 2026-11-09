/**
 * Wisp W05b Task 9 — the wake scheduler: the 5-minute tick (entitlement
 * reconcile, watch stop, floor-tick round-robin, due watches, pollers) and
 * the debounced assess job.
 *
 * `db.execute` is a router (statements rendered with PgDialect, answered by
 * shape); `requestAssessment` is the only part of wake.ts replaced, so the
 * round-robin pick runs for real against the fixtures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  inSystem: false,
  executes: [] as Array<{ text: string; params: unknown[] }>,
  route: (_text: string, _params: unknown[]): unknown[] => [],
  order: [] as string[],
  requestAssessment: vi.fn(async (..._a: unknown[]) => 'queued' as 'queued' | 'coalesced'),
  resolveGrantCeiling: vi.fn(),
  pauseGrant: vi.fn(async (..._a: unknown[]) => undefined),
  resumeGrant: vi.fn(async (..._a: unknown[]) => undefined),
  hasEntitlement: vi.fn(async (..._a: unknown[]) => true),
  claimDueWatches: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
  recordWatchHits: vi.fn(async (..._a: unknown[]) => true),
  evaluateWatchHits: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  stopWatchesForInactiveGrants: vi.fn(async (..._a: unknown[]) => ({ stopped: 0, grantsNotified: 0 })),
  pollStaleTickets: vi.fn(async (..._a: unknown[]) => ({ scanned: 0, published: 0 })),
  pollTicketClusters: vi.fn(async (..._a: unknown[]) => ({ scanned: 0, clustersOpened: 0, clustersUpdated: 0 })),
  correlateIncidents: vi.fn(async (..._a: unknown[]) => ({ partnerIncidentsOpened: 0, updated: 0, autoClosed: 0 })),
  rollupDeviceConcerns: vi.fn(async (..._a: unknown[]) => ({ opened: 0, updated: 0, resolved: 0 })),
  enqueueAssessment: vi.fn(async (..._a: unknown[]): Promise<{ runId: string } | { skipped: string }> => ({ runId: 'r1' })),
  queueAdd: vi.fn(async (..._a: unknown[]) => ({})),
  getRepeatableJobs: vi.fn(async () => [] as Array<{ name: string; key: string }>),
  removeRepeatableByKey: vi.fn(async (..._a: unknown[]) => undefined),
  workers: [] as Array<{ name: string; processor: (job: { name: string; data: unknown; id?: string; timestamp?: number }) => Promise<unknown>; opts: Record<string, unknown> }>,
  attachWorkerObservability: vi.fn(),
  chargeableUnderGrant: vi.fn(async (..._a: unknown[]): Promise<{ ok: true } | { ok: false; reason: 'budget_exhausted' }> => ({ ok: true })),
  notifyBudgetExhaustedOnce: vi.fn(async (..._a: unknown[]) => true),
  captureException: vi.fn(),
  reconcilePartnerDisabled: vi.fn(async (..._a: unknown[]) => ({ paused: 0, resumed: 0 })),
  fireCheckIn: vi.fn(async (..._a: unknown[]): Promise<'fired' | 'cancelled' | 'skipped'> => 'fired'),
  reconcileOrphanCheckIns: vi.fn(async (..._a: unknown[]) => ({ refired: 0 })),
  reconcileCheckInTriggers: vi.fn(async (..._a: unknown[]) => ({ fired: 0, cancelled: 0 })),
}));

vi.mock('../db', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();
  return {
    db: {
      execute: vi.fn(async (query: Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0]) => {
        const { sql: text, params } = dialect.sqlToQuery(query);
        h.executes.push({ text, params });
        return h.route(text, params);
      }),
    },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      h.inSystem = true;
      try { return await fn(); } finally { h.inSystem = false; }
    }),
  };
});
vi.mock('../config/env', () => ({ wispEnabled: () => h.enabled }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: h.attachWorkerObservability }));
vi.mock('bullmq', () => ({
  Queue: class {
    add = (...a: unknown[]) => h.queueAdd(...a);
    getRepeatableJobs = () => h.getRepeatableJobs();
    removeRepeatableByKey = (k: string) => h.removeRepeatableByKey(k);
    getJob = async () => undefined;
    close = async () => undefined;
  },
  Worker: class {
    constructor(name: string, processor: (job: { name: string; data: unknown; id?: string; timestamp?: number }) => Promise<unknown>, opts: Record<string, unknown>) {
      h.workers.push({ name, processor, opts });
    }
    on = vi.fn();
    close = async () => undefined;
  },
}));
vi.mock('../services/wisp/grantAuthority', () => {
  class GrantInactiveError extends Error {}
  return { GrantInactiveError, resolveGrantCeiling: h.resolveGrantCeiling };
});
vi.mock('../services/wisp/wake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/wisp/wake')>();
  return {
    ...actual,
    requestAssessment: (...a: unknown[]) => {
      h.order.push('requestAssessment');
      return h.requestAssessment(...a);
    },
  };
});
vi.mock('../services/wisp/grants', () => ({ pauseGrant: h.pauseGrant, resumeGrant: h.resumeGrant }));
vi.mock('../services/sentry', () => ({ captureException: h.captureException }));
vi.mock('../services/wisp/partnerSettings', () => ({
  reconcilePartnerDisabled: (...a: unknown[]) => { h.order.push('reconcilePartnerDisabled'); return h.reconcilePartnerDisabled(...a); },
}));
vi.mock('../services/entitlements', () => ({ hasEntitlement: h.hasEntitlement }));
vi.mock('../services/wisp/watches', () => ({
  claimDueWatches: (...a: unknown[]) => { h.order.push('claimDueWatches'); return h.claimDueWatches(...a); },
  stopWatchesForInactiveGrants: (...a: unknown[]) => { h.order.push('stopWatchesForInactiveGrants'); return h.stopWatchesForInactiveGrants(...a); },
  recordWatchHits: (...a: unknown[]) => { h.order.push('recordWatchHits'); return h.recordWatchHits(...a); },
}));
// #11424: the evaluator (DB reads) is stubbed; the change decision stays real.
vi.mock('../services/wisp/watchHits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wisp/watchHits')>()),
  evaluateWatchHits: (...a: unknown[]) => { h.order.push('evaluateWatchHits'); return h.evaluateWatchHits(...a); },
}));
vi.mock('../services/wisp/pollers', () => ({
  pollStaleTickets: (...a: unknown[]) => { h.order.push('pollStaleTickets'); return h.pollStaleTickets(...a); },
  pollTicketClusters: (...a: unknown[]) => { h.order.push('pollTicketClusters'); return h.pollTicketClusters(...a); },
}));
vi.mock('../services/wisp/incidentCorrelator', () => ({
  correlateIncidents: (...a: unknown[]) => { h.order.push('correlateIncidents'); return h.correlateIncidents(...a); },
}));
vi.mock('../services/wisp/concernRollup', () => ({
  rollupDeviceConcerns: (...a: unknown[]) => { h.order.push('rollupDeviceConcerns'); return h.rollupDeviceConcerns(...a); },
}));
vi.mock('../services/wisp/assessment', () => ({ enqueueAssessment: h.enqueueAssessment }));
// W07: the running-check-in sweep is pinned by wispCheckInRuns.integration.test.ts.
const reconcileRunningCheckIns = vi.hoisted(() => vi.fn(async (_now: Date) => ({ posted: 0 })));
vi.mock('../services/wisp/checkInRuns', () => ({ reconcileRunningCheckIns }));
vi.mock('../services/wisp/checkIns', () => ({
  fireCheckIn: (...a: unknown[]) => { h.order.push('fireCheckIn'); return h.fireCheckIn(...a); },
  reconcileOrphanCheckIns: (...a: unknown[]) => { h.order.push('reconcileOrphanCheckIns'); return h.reconcileOrphanCheckIns(...a); },
  reconcileCheckInTriggers: (...a: unknown[]) => { h.order.push('reconcileCheckInTriggers'); return h.reconcileCheckInTriggers(...a); },
}));
vi.mock('../services/wisp/budget', () => ({
  chargeableUnderGrant: h.chargeableUnderGrant,
  notifyBudgetExhaustedOnce: h.notifyBudgetExhaustedOnce,
}));

import {
  initializeWispWakeScheduler,
  processAssessJob,
  processCheckInJob,
  processWakeTick,
  shutdownWispWakeScheduler,
} from './wispWakeScheduler';
import { WISP_WAKE_QUEUE, WISP_WAKE_TICK_INTERVAL_MS } from '../services/wisp/wake';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const G1 = '00000000-0000-4000-8000-0000000000a1';
const G2 = '00000000-0000-4000-8000-0000000000a2';
const G3 = '00000000-0000-4000-8000-0000000000a3';
const G4 = '00000000-0000-4000-8000-0000000000a4';
const G5 = '00000000-0000-4000-8000-0000000000a5';
const P1 = '00000000-0000-4000-8000-0000000000c1';
const P2 = '00000000-0000-4000-8000-0000000000c2';
const O1 = '00000000-0000-4000-8000-0000000000b1';
const O2 = '00000000-0000-4000-8000-0000000000b2';
const O3 = '00000000-0000-4000-8000-0000000000b3';
const REV = '00000000-0000-4000-8000-0000000000f9';
const W1 = '00000000-0000-4000-8000-0000000000d1';
const W2 = '00000000-0000-4000-8000-0000000000d2';
const ALERT = '00000000-0000-4000-8000-0000000000e1';
const TASK = '00000000-0000-4000-8000-0000000000e2';

type Fixtures = {
  reconcile?: Array<{ id: string; partner_id: string; status: string; paused_reason: string | null }>;
  due?: Array<{ id: string; partner_id: string; current_revision_id: string | null; last_floor_tick_text: string | null }>;
  /** grant ids whose CAS claim loses (another replica won). */
  casLosers?: string[];
  watchGrants?: Array<{ id: string; partner_id: string; current_revision_id: string | null }>;
  orgs?: Array<{ id: string; name: string }>;
  lastAssessed?: Array<{ org_id: string; last_assessed_at: string | null }>;
  /** Partners whose grants disagree with their Wisp switch (w00 A35). */
  partnerSwitch?: Array<{ partner_id: string }>;
};

function useFixtures(f: Fixtures) {
  h.route = (text, params) => {
    if (/paused_reason = 'entitlement_lost'/.test(text)) return f.reconcile ?? [];
    if (/^\s*UPDATE wisp_grants/.test(text)) {
      const id = params.find((p) => typeof p === 'string' && /^[0-9a-f-]{36}$/.test(p) && (f.due ?? []).some((d) => d.id === p));
      return f.casLosers?.includes(String(id)) ? [] : [{ id }];
    }
    if (/last_floor_tick_at <=/.test(text)) return f.due ?? [];
    if (/FROM wisp_grants\s+WHERE id IN/.test(text)) return f.watchGrants ?? [];
    if (/SELECT id, name\s+FROM organizations/.test(text)) return f.orgs ?? [];
    if (/max\(finished_at\)/.test(text)) return f.lastAssessed ?? [];
    if (/wisp_partner_nudge_settings/.test(text)) return f.partnerSwitch ?? [];
    throw new Error(`unrouted statement: ${text}`);
  };
}

const ceilingFor = (orgIds: string[], o: Record<string, unknown> = {}) => ({
  grantId: G1, revisionId: REV, partnerId: P1, orgIds: new Set(orgIds), siteIds: null, orgTerms: new Map(), status: 'active', ...o,
});
const statements = (re: RegExp) => h.executes.filter((e) => re.test(e.text));

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
  h.inSystem = false;
  h.executes = [];
  h.order = [];
  h.workers = [];
  useFixtures({});
  h.resolveGrantCeiling.mockReset();
  h.resolveGrantCeiling.mockResolvedValue(ceilingFor([O1, O2, O3]));
  h.requestAssessment.mockImplementation(async () => 'queued');
  h.hasEntitlement.mockImplementation(async () => true);
  h.claimDueWatches.mockImplementation(async () => []);
  h.recordWatchHits.mockImplementation(async () => true);
  h.evaluateWatchHits.mockImplementation(async () => null);
  h.stopWatchesForInactiveGrants.mockImplementation(async () => ({ stopped: 0, grantsNotified: 0 }));
  h.pollStaleTickets.mockImplementation(async () => ({ scanned: 0, published: 0 }));
  h.pollTicketClusters.mockImplementation(async () => ({ scanned: 0, clustersOpened: 0, clustersUpdated: 0 }));
  h.correlateIncidents.mockImplementation(async () => ({ partnerIncidentsOpened: 0, updated: 0, autoClosed: 0 }));
  h.rollupDeviceConcerns.mockImplementation(async () => ({ opened: 0, updated: 0, resolved: 0 }));
  h.enqueueAssessment.mockImplementation(async () => ({ runId: 'r1' }));
  h.getRepeatableJobs.mockImplementation(async () => []);
  h.chargeableUnderGrant.mockImplementation(async () => ({ ok: true }));
  h.notifyBudgetExhaustedOnce.mockImplementation(async () => true);
  h.reconcilePartnerDisabled.mockImplementation(async () => ({ paused: 0, resumed: 0 }));
  h.fireCheckIn.mockImplementation(async () => 'fired');
  h.reconcileOrphanCheckIns.mockImplementation(async () => ({ refired: 0 }));
  h.reconcileCheckInTriggers.mockImplementation(async () => ({ fired: 0, cancelled: 0 }));
});

describe('processWakeTick', () => {
  it('tick does nothing when the flag is off', async () => {
    h.enabled = false;
    const result = await processWakeTick(NOW);
    expect(result).toEqual({
      grantsTicked: 0, watchesFired: 0, watchesUnchanged: 0, staleTicketsPublished: 0, watchesStopped: 0,
      grantsPaused: 0, grantsResumed: 0, ticketClustersOpened: 0, incidentsOpened: 0, concernRollupsOpened: 0, checkInsRefired: 0,
      checkInTriggersFired: 0, checkInTriggersCancelled: 0, checkInRunsPosted: 0,
    });
    expect(h.executes).toHaveLength(0);
    expect(h.order).toEqual([]);
    expect(h.hasEntitlement).not.toHaveBeenCalled();
  });

  it('runs the sections in order: reconcile, stop, floor, watches, check-in reconcile, trigger reconcile, stale, clusters, incidents, rollup', async () => {
    useFixtures({
      due: [{ id: G1, partner_id: P1, current_revision_id: REV, last_floor_tick_text: null }],
      orgs: [{ id: O1, name: 'A' }],
      watchGrants: [{ id: G1, partner_id: P1, current_revision_id: REV }],
    });
    h.claimDueWatches.mockImplementation(async () => [{ id: W1, grantId: G1, orgId: O1 }]);
    await processWakeTick(NOW);
    const firstReconcile = h.executes.findIndex((e) => /paused_reason = 'entitlement_lost'/.test(e.text));
    const firstDue = h.executes.findIndex((e) => /last_floor_tick_at <=/.test(e.text));
    expect(firstReconcile).toBeGreaterThanOrEqual(0);
    expect(firstReconcile).toBeLessThan(firstDue);
    expect(h.order).toEqual([
      'stopWatchesForInactiveGrants',
      'requestAssessment', // floor tick
      'claimDueWatches',
      'evaluateWatchHits', // #11424: in-code evaluation before any watch request
      'requestAssessment', // watch
      'reconcileOrphanCheckIns',
      'reconcileCheckInTriggers',
      'pollStaleTickets',
      'pollTicketClusters',
      'correlateIncidents',
      'rollupDeviceConcerns',
    ]);
    for (const fn of [h.stopWatchesForInactiveGrants, h.reconcileOrphanCheckIns, h.reconcileCheckInTriggers, h.pollStaleTickets, h.pollTicketClusters, h.correlateIncidents, h.rollupDeviceConcerns]) {
      expect(fn).toHaveBeenCalledWith(NOW);
    }
  });

  it('ticks only grants whose last_floor_tick_at is older than floor_tick_minutes and claims with a CAS', async () => {
    const prev = '2026-10-24 11:00:00.123456+00';
    useFixtures({
      due: [
        { id: G1, partner_id: P1, current_revision_id: REV, last_floor_tick_text: null },
        { id: G2, partner_id: P1, current_revision_id: REV, last_floor_tick_text: prev },
      ],
      casLosers: [G2],
      orgs: [{ id: O1, name: 'A' }],
    });
    h.resolveGrantCeiling.mockResolvedValue(ceilingFor([O1]));
    const result = await processWakeTick(NOW);

    const [due] = statements(/last_floor_tick_at <=/);
    expect(due!.text).toMatch(/status = 'active'/);
    expect(due!.text).toMatch(/expires_at >/);
    expect(due!.text).toMatch(/last_floor_tick_at IS NULL OR last_floor_tick_at <= \$\d+::timestamptz - floor_tick_minutes \* interval '1 minute'/);
    expect(due!.params).toContain(NOW.toISOString());

    const cas = statements(/^\s*UPDATE wisp_grants/);
    expect(cas).toHaveLength(2);
    for (const c of cas) {
      expect(c.text).toMatch(/SET last_floor_tick_at = \$\d+::timestamptz/);
      expect(c.text).toMatch(/last_floor_tick_at IS NOT DISTINCT FROM \$\d+::timestamptz/);
      expect(c.text).toMatch(/status = 'active'/);
      expect(c.text).toMatch(/RETURNING id/);
    }
    // The CAS compares against the exact text read (microseconds survive).
    expect(cas[0]!.params).toEqual(expect.arrayContaining([NOW.toISOString(), G1, null]));
    expect(cas[1]!.params).toEqual(expect.arrayContaining([NOW.toISOString(), G2, prev]));

    // G2 lost the claim to another replica: no request for it.
    expect(h.requestAssessment).toHaveBeenCalledTimes(1);
    expect(h.requestAssessment).toHaveBeenCalledWith({ grantId: G1, orgId: O1, reason: { kind: 'tick' } });
    expect(result.grantsTicked).toBe(1);
  });

  it('one assessment request per due grant per tick (not per org)', async () => {
    useFixtures({
      due: [
        { id: G1, partner_id: P1, current_revision_id: REV, last_floor_tick_text: null },
        { id: G2, partner_id: P1, current_revision_id: REV, last_floor_tick_text: null },
      ],
      orgs: [{ id: O1, name: 'A' }, { id: O2, name: 'B' }, { id: O3, name: 'C' }],
      lastAssessed: [
        { org_id: O1, last_assessed_at: '2026-10-24 10:00:00+00' },
        { org_id: O3, last_assessed_at: '2026-10-24 09:00:00+00' },
      ],
    });
    const result = await processWakeTick(NOW);
    expect(h.requestAssessment).toHaveBeenCalledTimes(2);
    // O2 has never been assessed under the grant: it goes first.
    expect(h.requestAssessment).toHaveBeenNthCalledWith(1, { grantId: G1, orgId: O2, reason: { kind: 'tick' } });
    expect(h.requestAssessment).toHaveBeenNthCalledWith(2, { grantId: G2, orgId: O2, reason: { kind: 'tick' } });
    expect(result.grantsTicked).toBe(2);
  });

  it('a grant with no live org in its ceiling, or an inactive ceiling, is claimed but requests nothing', async () => {
    useFixtures({
      due: [
        { id: G1, partner_id: P1, current_revision_id: REV, last_floor_tick_text: null },
        { id: G2, partner_id: P1, current_revision_id: REV, last_floor_tick_text: null },
      ],
      orgs: [{ id: O3, name: 'Holding-free but outside the ceiling' }],
    });
    const { GrantInactiveError } = await import('../services/wisp/grantAuthority');
    h.resolveGrantCeiling
      .mockResolvedValueOnce(ceilingFor([O1]))
      .mockRejectedValueOnce(new GrantInactiveError(G2, 'paused'));
    const result = await processWakeTick(NOW);
    expect(h.requestAssessment).not.toHaveBeenCalled();
    expect(result.grantsTicked).toBe(0);
  });

  it('a due watch requests an assessment with reason watch and advances next_due_at', async () => {
    useFixtures({
      watchGrants: [{ id: G1, partner_id: P1, current_revision_id: REV }, { id: G2, partner_id: P1, current_revision_id: REV }],
      orgs: [{ id: O1, name: 'A' }, { id: O2, name: 'B' }],
      lastAssessed: [{ org_id: O1, last_assessed_at: '2026-10-24 10:00:00+00' }],
    });
    h.resolveGrantCeiling.mockResolvedValue(ceilingFor([O1, O2]));
    h.claimDueWatches.mockImplementation(async () => [
      { id: W1, grantId: G1, orgId: O1 },
      { id: W2, grantId: G2, orgId: null }, // partner-wide: round-robin org of its grant
    ]);
    const result = await processWakeTick(NOW);
    // claimDueWatches is the claim that advances next_due_at (one statement).
    expect(h.claimDueWatches).toHaveBeenCalledWith(NOW, 200);
    expect(h.requestAssessment).toHaveBeenCalledWith({ grantId: G1, orgId: O1, reason: { kind: 'watch', watchId: W1 } });
    expect(h.requestAssessment).toHaveBeenCalledWith({ grantId: G2, orgId: O2, reason: { kind: 'watch', watchId: W2 } });
    expect(result.watchesFired).toBe(2);
    const [lookup] = statements(/FROM wisp_grants\s+WHERE id IN/);
    // Every watch's grant is looked up: org-scoped watches are re-checked
    // against their grant's live ceiling too (claimDueWatches has no filter).
    expect(lookup!.params).toEqual([G1, G2]);
  });

  // Budget (spec §9, w00 budget.ts): an exhausted UTC-day budget suspends the
  // floor tick — no request, the grantor told once per window, never paused.
  it('suspends the floor tick of a grant whose budget is exhausted: no request, notified once, never paused', async () => {
    useFixtures({
      due: [
        { id: G1, partner_id: P1, current_revision_id: REV, last_floor_tick_text: null },
        { id: G2, partner_id: P1, current_revision_id: REV, last_floor_tick_text: null },
      ],
      orgs: [{ id: O1, name: 'A' }],
    });
    h.resolveGrantCeiling.mockResolvedValue(ceilingFor([O1]));
    h.chargeableUnderGrant.mockImplementation(async (grantId: unknown) => (grantId === G1 ? { ok: false, reason: 'budget_exhausted' } : { ok: true }));
    const result = await processWakeTick(NOW);
    expect(h.chargeableUnderGrant).toHaveBeenCalledWith(G1, 25);
    expect(h.notifyBudgetExhaustedOnce).toHaveBeenCalledWith(G1, NOW);
    expect(h.requestAssessment).toHaveBeenCalledTimes(1);
    expect(h.requestAssessment).toHaveBeenCalledWith({ grantId: G2, orgId: O1, reason: { kind: 'tick' } });
    expect(h.pauseGrant).not.toHaveBeenCalled();
    expect(result.grantsTicked).toBe(1);
  });

  // W05a spot-check: claimDueWatches is a system claim with no ceiling filter,
  // so the wake path re-checks every watch against its grant's live ceiling.
  it('a due watch whose org is outside the grant ceiling, or reached only through sites, never produces a request', async () => {
    useFixtures({
      watchGrants: [{ id: G1, partner_id: P1, current_revision_id: REV }],
      orgs: [{ id: O1, name: 'A' }, { id: O2, name: 'B' }, { id: O3, name: 'C' }],
    });
    h.resolveGrantCeiling.mockResolvedValue(ceilingFor([O1, O2], {
      orgTerms: new Map([[O2, { permissionKeys: new Set(['*:*']), siteIds: new Set(['site-1']) }]]),
    }));
    h.claimDueWatches.mockImplementation(async () => [
      { id: W1, grantId: G1, orgId: O3 }, // outside the ceiling
      { id: W2, grantId: G1, orgId: O2 }, // site-restricted in O2
    ]);
    const result = await processWakeTick(NOW);
    expect(h.requestAssessment).not.toHaveBeenCalled();
    expect(result.watchesFired).toBe(0);
  });

  it('a site-restricted ceiling never round-robins a floor tick into an org it reaches only through sites', async () => {
    useFixtures({
      due: [{ id: G1, partner_id: P1, current_revision_id: REV, last_floor_tick_text: null }],
      orgs: [{ id: O1, name: 'A' }, { id: O2, name: 'B' }],
    });
    h.resolveGrantCeiling.mockResolvedValue(ceilingFor([O1, O2], {
      orgTerms: new Map([[O1, { permissionKeys: new Set(['*:*']), siteIds: new Set(['site-1']) }]]),
    }));
    await processWakeTick(NOW);
    expect(h.requestAssessment).toHaveBeenCalledWith({ grantId: G1, orgId: O2, reason: { kind: 'tick' } });
  });

  it('stops watches of a paused grant and notifies once', async () => {
    // Review Focus 1: the grant paused between wake and run start. The stop +
    // single orphan notice is stopWatchesForInactiveGrants (W05a, one call per
    // tick); the paused grant is never floor-ticked (the due query reads
    // status = 'active' only) and its delayed assess job admits nothing.
    h.stopWatchesForInactiveGrants.mockImplementation(async () => ({ stopped: 3, grantsNotified: 1 }));
    const result = await processWakeTick(NOW);
    expect(h.stopWatchesForInactiveGrants).toHaveBeenCalledTimes(1);
    expect(h.stopWatchesForInactiveGrants).toHaveBeenCalledWith(NOW);
    expect(result.watchesStopped).toBe(3);
    expect(h.requestAssessment).not.toHaveBeenCalled();

    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    h.enqueueAssessment.mockImplementation(async () => ({ skipped: 'grant_inactive' }));
    await expect(processAssessJob({ grantId: G1, orgId: O1, reason: { kind: 'tick' } })).resolves.toBeUndefined();
    expect(h.enqueueAssessment).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.some((c) => JSON.stringify(c).includes('grant_inactive'))).toBe(true);
    info.mockRestore();
  });

  it('pauses an active grant with entitlement_lost when the partner lost the wisp entitlement, and resumes a paused/entitlement_lost grant when it is back; never touches paused/grantor_suspended', async () => {
    useFixtures({
      reconcile: [
        { id: G1, partner_id: P1, status: 'active', paused_reason: null },
        { id: G3, partner_id: P1, status: 'active', paused_reason: null },
        { id: G2, partner_id: P2, status: 'paused', paused_reason: 'entitlement_lost' },
        // Defensive: the query never selects these, but if a row slipped
        // through it must still be left alone.
        { id: G4, partner_id: P2, status: 'paused', paused_reason: 'grantor_suspended' },
        { id: G5, partner_id: P2, status: 'paused', paused_reason: 'user_paused' },
      ],
    });
    h.hasEntitlement.mockImplementation(async (partnerId: unknown) => partnerId === P2);
    const result = await processWakeTick(NOW);

    // ONE lookup per distinct partner.
    expect(h.hasEntitlement).toHaveBeenCalledTimes(2);
    expect(h.hasEntitlement).toHaveBeenCalledWith(P1, 'wisp');
    expect(h.hasEntitlement).toHaveBeenCalledWith(P2, 'wisp');

    expect(h.pauseGrant).toHaveBeenCalledTimes(2);
    expect(h.pauseGrant).toHaveBeenCalledWith(G1, 'entitlement_lost', { onlyFromActive: true });
    expect(h.pauseGrant).toHaveBeenCalledWith(G3, 'entitlement_lost', { onlyFromActive: true });
    expect(h.resumeGrant).toHaveBeenCalledTimes(1);
    expect(h.resumeGrant).toHaveBeenCalledWith(G2, 'entitlement_lost');
    expect(result.grantsPaused).toBe(2);
    expect(result.grantsResumed).toBe(1);

    const [q] = statements(/paused_reason = 'entitlement_lost'/);
    expect(q!.text).not.toMatch(/user_paused|grantor_suspended/);
  });

  it('entitlement reconcile ignores user_paused even when the partner is entitled', async () => {
    useFixtures({ reconcile: [{ id: G5, partner_id: P1, status: 'paused', paused_reason: 'user_paused' }] });
    h.hasEntitlement.mockImplementation(async () => true);
    await processWakeTick(NOW);
    expect(h.resumeGrant).not.toHaveBeenCalled();
    expect(h.pauseGrant).not.toHaveBeenCalled();
  });

  it('an entitlement lookup that fails leaves that partner untouched', async () => {
    useFixtures({
      reconcile: [
        { id: G1, partner_id: P1, status: 'active', paused_reason: null },
        { id: G2, partner_id: P2, status: 'active', paused_reason: null },
      ],
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.hasEntitlement.mockImplementation(async (partnerId: unknown) => {
      if (partnerId === P1) throw new Error('entitlements down');
      return false;
    });
    await processWakeTick(NOW);
    expect(h.pauseGrant).toHaveBeenCalledTimes(1);
    expect(h.pauseGrant).toHaveBeenCalledWith(G2, 'entitlement_lost', { onlyFromActive: true });
    err.mockRestore();
  });

  it('a throwing section does not prevent the later sections', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.route = (text) => {
      if (/paused_reason = 'entitlement_lost'/.test(text)) throw new Error('reconcile boom');
      if (/last_floor_tick_at <=/.test(text)) throw new Error('floor boom');
      throw new Error(`unrouted statement: ${text}`);
    };
    h.stopWatchesForInactiveGrants.mockRejectedValue(new Error('stop boom'));
    h.claimDueWatches.mockRejectedValue(new Error('watch boom'));
    h.pollStaleTickets.mockRejectedValue(new Error('stale boom'));
    h.pollTicketClusters.mockRejectedValue(new Error('cluster boom'));
    h.correlateIncidents.mockImplementation(async () => ({ partnerIncidentsOpened: 2, updated: 0, autoClosed: 0 }));
    h.rollupDeviceConcerns.mockImplementation(async () => ({ opened: 3, updated: 0, resolved: 0 }));

    const result = await processWakeTick(NOW);
    expect(h.correlateIncidents).toHaveBeenCalledWith(NOW);
    expect(result.incidentsOpened).toBe(2);
    expect(result.concernRollupsOpened).toBe(3);
    const sections = err.mock.calls.map((c) => String(c[0]));
    for (const name of ['reconcileEntitlements', 'stopWatchesForInactiveGrants', 'floorTicks', 'dueWatches', 'pollStaleTickets', 'pollTicketClusters']) {
      expect(sections.some((s) => s.includes(name)), `console.error names ${name}`).toBe(true);
    }
    err.mockRestore();
  });

  it('a throwing section is reported to Sentry, tagged with its section name', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('cluster boom');
    h.pollTicketClusters.mockRejectedValue(boom);
    await processWakeTick(NOW);
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, { component: 'wisp.wakeScheduler', op: 'tick_section', section: 'pollTicketClusters' });
    err.mockRestore();
  });

  it('a failing floor-tick grant and a failing watch are reported (their cursor already advanced: one interval lost)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useFixtures({
      due: [{ id: G1, partner_id: P1, current_revision_id: REV, last_floor_tick_text: null }],
      watchGrants: [{ id: G2, partner_id: P1, current_revision_id: REV }],
      orgs: [{ id: O1, name: 'A' }],
    });
    h.resolveGrantCeiling.mockResolvedValue(ceilingFor([O1]));
    h.claimDueWatches.mockImplementation(async () => [{ id: W1, grantId: G2, orgId: O1 }]);
    const floorErr = new Error('redis down (floor)');
    const watchErr = new Error('redis down (watch)');
    h.requestAssessment.mockRejectedValueOnce(floorErr).mockRejectedValueOnce(watchErr);
    const result = await processWakeTick(NOW);
    expect(result).toMatchObject({ grantsTicked: 0, watchesFired: 0 });
    expect(h.captureException).toHaveBeenCalledWith(floorErr, undefined, { component: 'wisp.wakeScheduler', op: 'floor_tick_grant' });
    expect(h.captureException).toHaveBeenCalledWith(watchErr, undefined, { component: 'wisp.wakeScheduler', op: 'due_watch' });
    err.mockRestore();
  });

  it('a failed entitlement lookup and a failed grant pause are reported', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useFixtures({
      reconcile: [
        { id: G1, partner_id: P1, status: 'active', paused_reason: null },
        { id: G2, partner_id: P2, status: 'active', paused_reason: null },
      ],
    });
    const lookupErr = new Error('entitlements down');
    const pauseErr = new Error('pause failed');
    h.hasEntitlement.mockImplementation(async (partnerId: unknown) => {
      if (partnerId === P1) throw lookupErr;
      return false;
    });
    h.pauseGrant.mockRejectedValueOnce(pauseErr);
    await processWakeTick(NOW);
    expect(h.captureException).toHaveBeenCalledWith(lookupErr, undefined, { component: 'wisp.wakeScheduler', op: 'reconcile_entitlement_lookup' });
    expect(h.captureException).toHaveBeenCalledWith(pauseErr, undefined, { component: 'wisp.wakeScheduler', op: 'reconcile_grant_update' });
    err.mockRestore();
  });

  it('processWakeTick reports checkInsRefired from the check-in reconcile', async () => {
    h.reconcileOrphanCheckIns.mockImplementation(async () => ({ refired: 3 }));
    const result = await processWakeTick(NOW);
    expect(result.checkInsRefired).toBe(3);
    expect(h.reconcileOrphanCheckIns).toHaveBeenCalledWith(NOW);
  });

  it('W04: processWakeTick reports the event check-ins the trigger reconcile fired and cancelled', async () => {
    h.reconcileCheckInTriggers.mockImplementation(async () => ({ fired: 2, cancelled: 1 }));
    const result = await processWakeTick(NOW);
    expect(result).toMatchObject({ checkInTriggersFired: 2, checkInTriggersCancelled: 1 });
    expect(h.reconcileCheckInTriggers).toHaveBeenCalledWith(NOW);
  });

  it('W07: processWakeTick reports the run check-ins the running reconcile posted', async () => {
    reconcileRunningCheckIns.mockResolvedValueOnce({ posted: 3 });
    const result = await processWakeTick(NOW);
    expect(result.checkInRunsPosted).toBe(3);
    expect(reconcileRunningCheckIns).toHaveBeenCalledWith(NOW);
  });

  it('W07: a running-check-in reconcile failure is reported under its own section and the later sections still run', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('running reconcile boom');
    reconcileRunningCheckIns.mockRejectedValueOnce(boom);
    const result = await processWakeTick(NOW);
    expect(result.checkInRunsPosted).toBe(0);
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, { component: 'wisp.wakeScheduler', op: 'tick_section', section: 'reconcileRunningCheckIns' });
    expect(h.pollStaleTickets).toHaveBeenCalledWith(NOW);
    err.mockRestore();
  });

  it('W04: a trigger reconcile failure is reported under its own section and the later sections still run', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('trigger reconcile boom');
    h.reconcileCheckInTriggers.mockRejectedValue(boom);
    const result = await processWakeTick(NOW);
    expect(result.checkInTriggersFired).toBe(0);
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, { component: 'wisp.wakeScheduler', op: 'tick_section', section: 'reconcileCheckInTriggers' });
    expect(h.pollStaleTickets).toHaveBeenCalledWith(NOW);
    expect(h.rollupDeviceConcerns).toHaveBeenCalledWith(NOW);
    err.mockRestore();
  });

  it('a check-in reconcile failure is reported and the later sections still run', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('reconcile check-ins boom');
    h.reconcileOrphanCheckIns.mockRejectedValue(boom);
    h.correlateIncidents.mockImplementation(async () => ({ partnerIncidentsOpened: 1, updated: 0, autoClosed: 0 }));
    const result = await processWakeTick(NOW);
    expect(result.checkInsRefired).toBe(0);
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, { component: 'wisp.wakeScheduler', op: 'tick_section', section: 'reconcileCheckIns' });
    expect(h.pollStaleTickets).toHaveBeenCalledWith(NOW);
    expect(result.incidentsOpened).toBe(1);
    err.mockRestore();
  });

  // #11426: the same-org rollup runs after the correlator, and a failing
  // correlator does not stop it.
  it('a correlator failure is reported and the concern rollup still runs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.correlateIncidents.mockRejectedValue(new Error('correlate boom'));
    h.rollupDeviceConcerns.mockImplementation(async () => ({ opened: 1, updated: 2, resolved: 0 }));
    const result = await processWakeTick(NOW);
    expect(h.rollupDeviceConcerns).toHaveBeenCalledWith(NOW);
    expect(result.concernRollupsOpened).toBe(1);
    expect(h.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { component: 'wisp.wakeScheduler', op: 'tick_section', section: 'correlateIncidents' });
    err.mockRestore();
  });

  it('reports the pollers\' counts', async () => {
    h.pollStaleTickets.mockImplementation(async () => ({ scanned: 4, published: 3 }));
    h.pollTicketClusters.mockImplementation(async () => ({ scanned: 9, clustersOpened: 2, clustersUpdated: 1 }));
    const result = await processWakeTick(NOW);
    expect(result.staleTicketsPublished).toBe(3);
    expect(result.ticketClustersOpened).toBe(2);
  });
});

// #11424: a watch is evaluated in code at claim time; only a changed hit-set
// (or the first evaluation) launches a model run.
describe('processWakeTick — stateful watches (#11424)', () => {
  const LATER = new Date(NOW.getTime() + 60 * 60_000);
  const ALERT_2 = '00000000-0000-4000-8000-0000000000e3';
  // sha256-hex shaped, as the aggregate returns them (parseWatchHitRecord checks the shape).
  const HASH_A = 'a'.repeat(64);
  const HASH_AB = 'b'.repeat(64);
  const HASH_EMPTY = 'e'.repeat(64);
  const hitSet = (ids: string[], hash: string) => ({ subject: 'alert', count: ids.length, hash, ids });

  /**
   * A stateful watch row: claimDueWatches returns what recordWatchHits last
   * stored, and a 'queued' request runs the real processAssessJob (admission =
   * the enqueueAssessment mock), which is where the hit-set is recorded.
   */
  function statefulWatch(over: Record<string, unknown> = {}, stored: { hitHash: string | null; hitCount: number | null } = { hitHash: null, hitCount: null }) {
    const row = { id: W1, grantId: G1, orgId: O1, kind: 'alert_pattern', params: { severity: 'medium' }, ...stored, ...over };
    h.claimDueWatches.mockImplementation(async () => [{ ...row }]);
    h.recordWatchHits.mockImplementation(async (...a: unknown[]) => {
      const next = a[2] as { hash: string; count: number };
      if (a[1] !== row.hitHash) return false;
      row.hitHash = next.hash;
      row.hitCount = next.count;
      return true;
    });
    h.requestAssessment.mockImplementation(async (data: unknown) => {
      await processAssessJob(data as Parameters<typeof processAssessJob>[0]);
      return 'queued';
    });
    return row;
  }

  beforeEach(() => {
    useFixtures({
      watchGrants: [{ id: G1, partner_id: P1, current_revision_id: REV }],
      orgs: [{ id: O1, name: 'A' }, { id: O2, name: 'B' }],
      lastAssessed: [{ org_id: O1, last_assessed_at: '2026-10-24 10:00:00+00' }],
    });
    h.resolveGrantCeiling.mockResolvedValue(ceilingFor([O1, O2]));
  });

  it('the same active alert on two consecutive cadences launches one run, not two', async () => {
    statefulWatch();
    h.evaluateWatchHits.mockImplementation(async () => hitSet([ALERT], HASH_A));

    const first = await processWakeTick(NOW);
    const second = await processWakeTick(LATER);

    expect(h.requestAssessment).toHaveBeenCalledTimes(1);
    expect(h.enqueueAssessment).toHaveBeenCalledTimes(1);
    expect(first.watchesFired).toBe(1);
    expect(second.watchesFired).toBe(0);
    expect(second.watchesUnchanged).toBe(1);
    // Both cadences were evaluated (the claim already advanced next_due_at / last_ran_at).
    expect(h.evaluateWatchHits).toHaveBeenCalledTimes(2);
  });

  it('the first evaluation launches a run carrying the hit summary; the hit-set is recorded once the run is admitted', async () => {
    statefulWatch();
    h.evaluateWatchHits.mockImplementation(async () => hitSet([ALERT], HASH_A));
    await processWakeTick(NOW);
    expect(h.evaluateWatchHits).toHaveBeenCalledWith(expect.objectContaining({ kind: 'alert_pattern', params: { severity: 'medium' } }), O1, NOW);
    expect(h.requestAssessment).toHaveBeenCalledWith({
      grantId: G1,
      orgId: O1,
      reason: {
        kind: 'watch',
        watchId: W1,
        hits: { change: 'first', subject: 'alert', orgId: O1, partnerWide: false, count: 1, previousCount: null, ids: [ALERT] },
      },
      watchRecord: { watchId: W1, previousHash: null, hash: HASH_A, count: 1 },
    });
    expect(h.recordWatchHits).toHaveBeenCalledWith(W1, null, { hash: HASH_A, count: 1 });
    expect(h.enqueueAssessment.mock.invocationCallOrder[0]!).toBeLessThan(h.recordWatchHits.mock.invocationCallOrder[0]!);
  });

  it('an alert that resolves launches one run whose reason says cleared', async () => {
    statefulWatch({}, { hitHash: HASH_A, hitCount: 1 });
    h.evaluateWatchHits.mockImplementation(async () => hitSet([], HASH_EMPTY));
    await processWakeTick(NOW);
    await processWakeTick(LATER);
    expect(h.requestAssessment).toHaveBeenCalledTimes(1);
    expect(h.requestAssessment).toHaveBeenCalledWith(expect.objectContaining({
      grantId: G1,
      orgId: O1,
      reason: {
        kind: 'watch',
        watchId: W1,
        hits: { change: 'cleared', subject: 'alert', orgId: O1, partnerWide: false, count: 0, previousCount: 1, ids: [] },
      },
    }));
  });

  it('a new hit after an empty evaluation is reported as new, a different hit-set as changed', async () => {
    const row = statefulWatch({}, { hitHash: HASH_EMPTY, hitCount: 0 });
    h.evaluateWatchHits.mockImplementationOnce(async () => hitSet([ALERT], HASH_A));
    await processWakeTick(NOW);
    expect(h.requestAssessment).toHaveBeenLastCalledWith(expect.objectContaining({
      reason: expect.objectContaining({ hits: expect.objectContaining({ change: 'new', count: 1, previousCount: 0 }) }),
    }));
    expect(row.hitHash).toBe(HASH_A);
    h.evaluateWatchHits.mockImplementationOnce(async () => hitSet([ALERT, ALERT_2], HASH_AB));
    await processWakeTick(LATER);
    expect(h.requestAssessment).toHaveBeenLastCalledWith(expect.objectContaining({
      reason: expect.objectContaining({ hits: expect.objectContaining({ change: 'changed', count: 2, previousCount: 1 }) }),
      watchRecord: { watchId: W1, previousHash: HASH_A, hash: HASH_AB, count: 2 },
    }));
    expect(h.requestAssessment).toHaveBeenCalledTimes(2);
  });

  it('a kind the scheduler does not evaluate (custom_query) runs every cadence, with no hit summary and nothing recorded', async () => {
    statefulWatch({ kind: 'custom_query' });
    await processWakeTick(NOW);
    await processWakeTick(LATER);
    expect(h.requestAssessment).toHaveBeenCalledTimes(2);
    expect(h.requestAssessment).toHaveBeenCalledWith({ grantId: G1, orgId: O1, reason: { kind: 'watch', watchId: W1 } });
    expect(h.recordWatchHits).not.toHaveBeenCalled();
  });

  it('a coalesced request records nothing, so the next cadence asks again', async () => {
    statefulWatch();
    h.evaluateWatchHits.mockImplementation(async () => hitSet([ALERT], HASH_A));
    h.requestAssessment.mockImplementationOnce(async () => 'coalesced');
    await processWakeTick(NOW);
    expect(h.recordWatchHits).not.toHaveBeenCalled();
    await processWakeTick(LATER);
    expect(h.requestAssessment).toHaveBeenCalledTimes(2);
    expect(h.recordWatchHits).toHaveBeenCalledTimes(1);
  });

  it('a failed request records nothing (the change is not lost) and is reported', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    statefulWatch();
    h.evaluateWatchHits.mockImplementation(async () => hitSet([ALERT], HASH_A));
    const boom = new Error('redis down');
    h.requestAssessment.mockRejectedValueOnce(boom);
    await processWakeTick(NOW);
    expect(h.recordWatchHits).not.toHaveBeenCalled();
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, { component: 'wisp.wakeScheduler', op: 'due_watch' });
    err.mockRestore();
  });

  it.each([['budget_exhausted'], ['no_effective_agent'], ['not_entitled']])(
    'a queued request whose admission is skipped (%s) records nothing; the next cadence asks again',
    async (skipped) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      statefulWatch();
      h.evaluateWatchHits.mockImplementation(async () => hitSet([ALERT], HASH_A));
      h.enqueueAssessment.mockResolvedValueOnce({ skipped });
      await processWakeTick(NOW);
      expect(h.recordWatchHits).not.toHaveBeenCalled();
      await processWakeTick(LATER);
      expect(h.requestAssessment).toHaveBeenCalledTimes(2);
      expect(h.recordWatchHits).toHaveBeenCalledTimes(1);
      info.mockRestore();
    },
  );

  it('a record failure after admission is reported, does not throw, and the next cadence asks again', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    statefulWatch();
    h.evaluateWatchHits.mockImplementation(async () => hitSet([ALERT], HASH_A));
    const boom = new Error('db blip');
    h.recordWatchHits.mockRejectedValueOnce(boom);
    const first = await processWakeTick(NOW);
    expect(first.watchesFired).toBe(1);
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, { component: 'wisp.wakeScheduler', op: 'watch_record' });
    expect(h.captureException).not.toHaveBeenCalledWith(boom, undefined, expect.objectContaining({ op: 'due_watch' }));
    await processWakeTick(LATER);
    expect(h.requestAssessment).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('an evaluation failure falls back to a plain watch run (as before) and is reported', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    statefulWatch();
    const boom = new Error('statement timeout');
    h.evaluateWatchHits.mockRejectedValueOnce(boom);
    const result = await processWakeTick(NOW);
    expect(h.requestAssessment).toHaveBeenCalledWith({ grantId: G1, orgId: O1, reason: { kind: 'watch', watchId: W1 } });
    expect(result.watchesFired).toBe(1);
    expect(h.recordWatchHits).not.toHaveBeenCalled();
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, { component: 'wisp.wakeScheduler', op: 'watch_evaluate' });
    err.mockRestore();
  });

  it('a partner-wide watch is evaluated in its grant\'s round-robin org only (no fan-out)', async () => {
    statefulWatch({ orgId: null });
    h.evaluateWatchHits.mockImplementation(async () => hitSet([], HASH_EMPTY));
    await processWakeTick(NOW);
    expect(h.evaluateWatchHits).toHaveBeenCalledTimes(1);
    expect(h.evaluateWatchHits).toHaveBeenCalledWith(expect.anything(), O2, NOW);
    expect(h.requestAssessment).toHaveBeenCalledTimes(1);
    expect(h.requestAssessment).toHaveBeenCalledWith(expect.objectContaining({ orgId: O2 }));
  });

  it('a partner-wide watch never claims cleared / new: its previous evaluation may have covered another org', async () => {
    statefulWatch({ orgId: null }, { hitHash: HASH_A, hitCount: 1 });
    h.evaluateWatchHits.mockImplementation(async () => hitSet([], HASH_EMPTY));
    await processWakeTick(NOW);
    expect(h.requestAssessment).toHaveBeenCalledWith(expect.objectContaining({
      orgId: O2,
      reason: expect.objectContaining({ hits: expect.objectContaining({ change: 'changed', partnerWide: true, orgId: O2, count: 0, previousCount: 1 }) }),
    }));
  });

  it('a watch whose org is outside the grant ceiling is not evaluated', async () => {
    statefulWatch({ orgId: O3 });
    await processWakeTick(NOW);
    expect(h.evaluateWatchHits).not.toHaveBeenCalled();
    expect(h.requestAssessment).not.toHaveBeenCalled();
  });
});

describe('processAssessJob — watch hit-set record (#11424)', () => {
  const HASH_A = 'a'.repeat(64);
  const job = (watchRecord: unknown) => ({ grantId: G1, orgId: O1, reason: { kind: 'watch' as const, watchId: W1 }, watchRecord }) as Parameters<typeof processAssessJob>[0];

  it('records the hit-set after an admitted run', async () => {
    await processAssessJob(job({ watchId: W1, previousHash: null, hash: HASH_A, count: 2 }));
    expect(h.recordWatchHits).toHaveBeenCalledWith(W1, null, { hash: HASH_A, count: 2 });
  });

  it('a job without a watchRecord records nothing', async () => {
    await processAssessJob({ grantId: G1, orgId: O1, reason: { kind: 'tick' } });
    expect(h.recordWatchHits).not.toHaveBeenCalled();
  });

  it('a malformed watchRecord is reported and not recorded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await processAssessJob(job({ watchId: 'w-1', previousHash: null, hash: 'not-a-hash', count: -1 }));
    expect(h.recordWatchHits).not.toHaveBeenCalled();
    expect(h.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { component: 'wisp.wakeScheduler', op: 'watch_record_malformed' });
    warn.mockRestore();
  });

  it('a lost compare-and-set is logged, not thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.recordWatchHits.mockResolvedValueOnce(false);
    await expect(processAssessJob(job({ watchId: W1, previousHash: null, hash: HASH_A, count: 1 }))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not recorded'), { watchId: W1 });
    warn.mockRestore();
  });
});

describe('processAssessJob', () => {
  it('passes the alert digest hint through to enqueueAssessment', async () => {
    const data = {
      grantId: G1, orgId: O1,
      reason: { kind: 'event' as const, eventType: 'alert.triggered', eventId: 'e1' },
      subject: { kind: 'alert' as const, id: ALERT },
    };
    await processAssessJob(data);
    expect(h.enqueueAssessment).toHaveBeenCalledWith(data);
  });

  it('passes a failed task hint through to enqueueAssessment', async () => {
    const data = {
      grantId: G1, orgId: O1,
      reason: { kind: 'event' as const, eventType: 'ai.operator.task.finished', eventId: 'e2' },
      subject: { kind: 'task' as const, id: TASK }, failed: true,
    };
    await processAssessJob(data);
    expect(h.enqueueAssessment).toHaveBeenCalledWith(data);
  });

  it('threads the job occurrence key into enqueueAssessment (retry-stable dedupe)', async () => {
    const data = { grantId: G1, orgId: O1, reason: { kind: 'tick' as const } };
    await processAssessJob(data, 'wisp-assess:g:o@1700000000000');
    expect(h.enqueueAssessment).toHaveBeenCalledWith({ ...data, occurrenceKey: 'wisp-assess:g:o@1700000000000' });
  });

  it('does nothing when the flag is off', async () => {
    h.enabled = false;
    await processAssessJob({ grantId: G1, orgId: O1, reason: { kind: 'tick' } });
    expect(h.enqueueAssessment).not.toHaveBeenCalled();
  });
});

describe('processCheckInJob', () => {
  const CI = '00000000-0000-4000-8000-0000000000f1';

  it('fires the check-in named by the job', async () => {
    await processCheckInJob({ checkInId: CI });
    expect(h.fireCheckIn).toHaveBeenCalledWith(CI);
  });

  it('returns without firing when wispEnabled() is false (the tick reconcile fires it once Wisp is back on)', async () => {
    h.enabled = false;
    await processCheckInJob({ checkInId: CI });
    expect(h.fireCheckIn).not.toHaveBeenCalled();
  });

  it('drops a payload whose checkInId is not a uuid, logs and reports it, and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const data of [{ checkInId: 'nope' }, {}, null] as unknown[]) {
      await expect(processCheckInJob(data as { checkInId: string })).resolves.toBeUndefined();
    }
    expect(h.fireCheckIn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(h.captureException).toHaveBeenCalledTimes(3);
    expect(h.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { component: 'wisp.wakeScheduler', op: 'check_in_malformed_payload' });
    warn.mockRestore();
  });

  it('a fireCheckIn throw propagates so BullMQ retries', async () => {
    h.fireCheckIn.mockRejectedValue(new Error('db blip'));
    await expect(processCheckInJob({ checkInId: CI })).rejects.toThrow('db blip');
  });
});

describe('worker lifecycle', () => {
  it('replaces the old tick repeatable and registers wisp-wake-tick every 5 minutes, concurrency 4', async () => {
    expect(WISP_WAKE_TICK_INTERVAL_MS).toBe(5 * 60 * 1000);
    h.getRepeatableJobs.mockImplementation(async () => [{ name: 'tick', key: 'old-key' }, { name: 'other', key: 'keep' }]);
    await initializeWispWakeScheduler();
    expect(h.removeRepeatableByKey).toHaveBeenCalledTimes(1);
    expect(h.removeRepeatableByKey).toHaveBeenCalledWith('old-key');
    expect(h.queueAdd).toHaveBeenCalledWith('tick', {}, expect.objectContaining({
      jobId: 'wisp-wake-tick',
      repeat: { every: WISP_WAKE_TICK_INTERVAL_MS },
    }));
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0]!.name).toBe(WISP_WAKE_QUEUE);
    expect(h.workers[0]!.opts).toMatchObject({ concurrency: 4 });
    expect(h.attachWorkerObservability).toHaveBeenCalledTimes(1);
    await shutdownWispWakeScheduler();
  });

  it('the worker dispatches tick, assess and check-in by name and refuses unknown names', async () => {
    h.enabled = false;
    await initializeWispWakeScheduler();
    const processor = h.workers[0]!.processor;
    await expect(processor({ name: 'tick', data: {} })).resolves.toMatchObject({ grantsTicked: 0 });
    h.enabled = true;
    await processor({ name: 'assess', id: 'assess-job', timestamp: 1700000000000, data: { grantId: G1, orgId: O1, reason: { kind: 'tick' } } });
    expect(h.enqueueAssessment).toHaveBeenCalledWith({
      grantId: G1, orgId: O1, reason: { kind: 'tick' }, occurrenceKey: 'assess-job@1700000000000',
    });
    const CI = '00000000-0000-4000-8000-0000000000f1';
    await processor({ name: 'check-in', id: `wisp-check-in-${CI}`, timestamp: 1700000000000, data: { checkInId: CI } });
    expect(h.fireCheckIn).toHaveBeenCalledWith(CI);
    await expect(processor({ name: 'mystery', data: {} })).rejects.toThrow(/unknown/);
    await shutdownWispWakeScheduler();
  });
});

// --- W07 Task 8: metrics call sites ---
const wm = vi.hoisted(() => ({
  incWispAssessment: vi.fn(), incWispNudge: vi.fn(), incWispConcern: vi.fn(),
  incWispGrantPause: vi.fn(), incWispBudgetExhausted: vi.fn(), setWispGrantsActive: vi.fn(),
}));
vi.mock('../services/wispMetrics', () => wm);

describe('processWakeTick — partner enable switch (w00 A35)', () => {
  it('ONE query finds the partners whose grants disagree with their switch, then reconciles each', async () => {
    useFixtures({ partnerSwitch: [{ partner_id: P1 }, { partner_id: P2 }] });
    h.reconcilePartnerDisabled
      .mockResolvedValueOnce({ paused: 2, resumed: 0 })
      .mockResolvedValueOnce({ paused: 0, resumed: 1 });
    const result = await processWakeTick(NOW);

    const finds = statements(/wisp_partner_nudge_settings/);
    expect(finds).toHaveLength(1);
    const q = finds[0]!.text;
    // A missing settings row means enabled.
    expect(q).toMatch(/LEFT JOIN wisp_partner_nudge_settings/);
    expect(q).toMatch(/COALESCE\(s\.enabled, true\) = false AND g\.status = 'active'/);
    expect(q).toMatch(/COALESCE\(s\.enabled, true\) = true AND g\.status = 'paused' AND g\.paused_reason = 'partner_disabled'/);
    expect(q).toMatch(/expires_at > \$\d+::timestamptz/);
    expect(q).not.toMatch(/user_paused|entitlement_lost/);
    expect(finds[0]!.params).toContain(NOW.toISOString());

    expect(h.reconcilePartnerDisabled).toHaveBeenCalledTimes(2);
    expect(h.reconcilePartnerDisabled).toHaveBeenNthCalledWith(1, P1, NOW);
    expect(h.reconcilePartnerDisabled).toHaveBeenNthCalledWith(2, P2, NOW);
    expect(result.grantsPaused).toBe(2);
    expect(result.grantsResumed).toBe(1);
  });

  it('runs after the entitlement reconcile (an entitlement resume of a disabled partner is re-paused in the same tick) and before the floor ticks', async () => {
    useFixtures({
      partnerSwitch: [{ partner_id: P1 }],
      due: [{ id: G1, partner_id: P1, current_revision_id: REV, last_floor_tick_text: null }],
      orgs: [{ id: O1, name: 'A' }],
    });
    await processWakeTick(NOW);
    const ent = h.executes.findIndex((e) => /paused_reason = 'entitlement_lost'/.test(e.text));
    const sw = h.executes.findIndex((e) => /wisp_partner_nudge_settings/.test(e.text));
    const due = h.executes.findIndex((e) => /last_floor_tick_at <=/.test(e.text));
    expect(ent).toBeGreaterThanOrEqual(0);
    expect(sw).toBeGreaterThan(ent);
    expect(due).toBeGreaterThan(sw);
    expect(h.order.indexOf('reconcilePartnerDisabled')).toBeLessThan(h.order.indexOf('stopWatchesForInactiveGrants'));
  });

  it('no partner needs work ⇒ no reconcile call', async () => {
    await processWakeTick(NOW);
    expect(statements(/wisp_partner_nudge_settings/)).toHaveLength(1);
    expect(h.reconcilePartnerDisabled).not.toHaveBeenCalled();
  });

  it('one partner failing is logged and reported; the next partner still reconciles', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useFixtures({ partnerSwitch: [{ partner_id: P1 }, { partner_id: P2 }] });
    const boom = new Error('reconcile failed');
    h.reconcilePartnerDisabled.mockRejectedValueOnce(boom).mockResolvedValueOnce({ paused: 1, resumed: 0 });
    const result = await processWakeTick(NOW);
    expect(h.reconcilePartnerDisabled).toHaveBeenCalledWith(P2, NOW);
    expect(result.grantsPaused).toBe(1);
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, { component: 'wisp.wakeScheduler', op: 'reconcile_partner_disabled' });
    err.mockRestore();
  });

  it('a failing finder query is its own section: later sections still run', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = h.route;
    h.route = (text, params) => {
      if (/wisp_partner_nudge_settings/.test(text)) throw new Error('finder boom');
      return base(text, params);
    };
    await processWakeTick(NOW);
    expect(err.mock.calls.some((c) => String(c[0]).includes('reconcilePartnerDisabled'))).toBe(true);
    expect(h.stopWatchesForInactiveGrants).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('processWakeTick metrics', () => {
  it('sets wisp_grants_active to the active grants left after the reconcile (no extra query)', async () => {
    wm.setWispGrantsActive.mockClear();
    useFixtures({
      reconcile: [
        { id: G1, partner_id: P1, status: 'active', paused_reason: null },
        { id: G3, partner_id: P1, status: 'active', paused_reason: null },
        { id: G2, partner_id: P2, status: 'paused', paused_reason: 'entitlement_lost' },
      ],
    });
    h.hasEntitlement.mockImplementation(async (partnerId: unknown) => partnerId === P2);
    await processWakeTick(NOW);
    // G1 + G3 paused (P1 lost the entitlement), G2 resumed => 1 active.
    expect(wm.setWispGrantsActive).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('the partner-switch reconcile adjusts the gauge by what it paused and resumed', async () => {
    wm.setWispGrantsActive.mockClear();
    useFixtures({
      reconcile: [
        { id: G1, partner_id: P1, status: 'active', paused_reason: null },
        { id: G3, partner_id: P2, status: 'active', paused_reason: null },
      ],
      partnerSwitch: [{ partner_id: P2 }],
    });
    h.reconcilePartnerDisabled.mockResolvedValueOnce({ paused: 1, resumed: 0 });
    await processWakeTick(NOW);
    expect(wm.setWispGrantsActive).toHaveBeenCalledExactlyOnceWith(1);
  });
});
