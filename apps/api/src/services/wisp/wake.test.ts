/**
 * Wisp W05b Task 9 — the wake coordinator's pure round-robin, the 60 s
 * per-(grant, org) debounce, and the event subscriber body.
 *
 * `db.execute` is a router: each statement is rendered with PgDialect and
 * answered from a fixture keyed by its shape, so the SQL predicates the
 * mocks cannot evaluate are asserted on the rendered text. BullMQ is a fake
 * queue that keeps one record per jobId, the way Redis does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

type FakeJobRecord = { name: string; data: unknown; opts: Record<string, unknown>; state: string; timestamp: number };

const h = vi.hoisted(() => ({
  enabled: true,
  inSystem: false,
  executes: [] as Array<{ text: string; params: unknown[]; inSystem: boolean }>,
  route: (_text: string, _params: unknown[]): unknown[] => [],
  jobs: new Map<string, FakeJobRecord>(),
  adds: [] as Array<{ name: string; data: unknown; opts: Record<string, unknown>; inSystem: boolean }>,
  resolveGrantCeiling: vi.fn(),
}));

vi.mock('../../db', async () => {
  const { PgDialect: Dialect } = await import('drizzle-orm/pg-core');
  const dialect = new Dialect();
  return {
    db: {
      execute: vi.fn(async (query: Parameters<InstanceType<typeof Dialect>['sqlToQuery']>[0]) => {
        const { sql: text, params } = dialect.sqlToQuery(query);
        h.executes.push({ text, params, inSystem: h.inSystem });
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
vi.mock('../../config/env', () => ({ wispEnabled: () => h.enabled }));
vi.mock('../redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('./grantAuthority', () => {
  class GrantInactiveError extends Error {}
  return { GrantInactiveError, resolveGrantCeiling: h.resolveGrantCeiling };
});
vi.mock('bullmq', () => {
  const makeJob = (id: string, rec: FakeJobRecord) => ({
    id,
    name: rec.name,
    data: rec.data,
    timestamp: rec.timestamp,
    getState: async () => rec.state,
    remove: async () => { h.jobs.delete(id); },
  });
  return {
    Queue: class {
      async add(name: string, data: unknown, opts: Record<string, unknown>) {
        h.adds.push({ name, data, opts, inSystem: h.inSystem });
        const id = String(opts.jobId);
        let rec = h.jobs.get(id);
        // BullMQ: an add whose jobId still exists in Redis is a silent no-op.
        if (!rec) {
          rec = { name, data, opts, state: opts.delay ? 'delayed' : 'waiting', timestamp: Date.now() };
          h.jobs.set(id, rec);
        }
        return makeJob(id, rec);
      }
      async getJob(id: string) {
        const rec = h.jobs.get(id);
        return rec ? makeJob(id, rec) : undefined;
      }
      async close() {}
    },
  };
});

import { GrantInactiveError } from './grantAuthority';
import {
  WISP_WAKE_DEBOUNCE_MS,
  WISP_WAKE_QUEUE,
  WISP_WAKE_TICK_INTERVAL_MS,
  handleWispWakeEvent,
  pickRoundRobinOrg,
  requestAssessment,
  wakeJobId,
} from './wake';
import type { BreezeEvent } from '../eventBus';

const G1 = '00000000-0000-4000-8000-0000000000a1';
const G2 = '00000000-0000-4000-8000-0000000000a2';
const P1 = '00000000-0000-4000-8000-0000000000c1';
const O1 = '00000000-0000-4000-8000-0000000000b1';
const O2 = '00000000-0000-4000-8000-0000000000b2';
const O3 = '00000000-0000-4000-8000-0000000000b3';
const ALERT = '00000000-0000-4000-8000-0000000000d1';
const RUN = '00000000-0000-4000-8000-0000000000e1';
const TASK = '00000000-0000-4000-8000-0000000000f1';
const REV = '00000000-0000-4000-8000-0000000000f9';

function event(type: string, orgId: string, payload: Record<string, unknown>): BreezeEvent {
  return {
    id: `evt-${type}`,
    type: type as BreezeEvent['type'],
    orgId,
    source: 'test',
    priority: 'normal',
    payload,
    metadata: { timestamp: new Date().toISOString() },
  };
}

function ceiling(orgIds: string[]) {
  return { grantId: G1, revisionId: REV, partnerId: P1, orgIds: new Set(orgIds), siteIds: null, orgTerms: new Map(), status: 'active' };
}

function orgId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Fixture rows per statement shape. */
type Fixtures = {
  eventGrants?: Array<{ grant_id: string }>;
  runProfile?: Array<{ profile: string }>;
  grantRow?: Array<{ id: string; partner_id: string; status: string; current_revision_id: string | null }>;
  orgs?: Array<{ id: string; name: string }>;
  lastAssessed?: Array<{ org_id: string; last_assessed_at: string | Date | null }>;
};

function useFixtures(f: Fixtures) {
  h.route = (text) => {
    if (/FROM wisp_grants g\s+JOIN organizations/.test(text)) return f.eventGrants ?? [];
    if (/SELECT profile FROM ai_agent_runs/.test(text)) return f.runProfile ?? [];
    if (/FROM wisp_grants\s+WHERE id =/.test(text)) return f.grantRow ?? [];
    if (/SELECT id, name\s+FROM organizations/.test(text)) return f.orgs ?? [];
    if (/max\(finished_at\)/.test(text)) return f.lastAssessed ?? [];
    throw new Error(`unrouted statement: ${text}`);
  };
}

const assessAdds = () => h.adds.filter((a) => a.name === 'assess');

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
  h.inSystem = false;
  h.executes = [];
  h.jobs = new Map();
  h.adds = [];
  useFixtures({});
  h.resolveGrantCeiling.mockReset();
});

describe('constants', () => {
  it('pins the queue name, the 60 s debounce and the 5 minute tick', () => {
    expect(WISP_WAKE_QUEUE).toBe('wisp-wake');
    expect(WISP_WAKE_DEBOUNCE_MS).toBe(60_000);
    expect(WISP_WAKE_TICK_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('wakeJobId has no ":" (BullMQ reserves it)', () => {
    expect(wakeJobId(G1, O1)).toBe(`wisp-assess-${G1}-${O1}`);
    expect(wakeJobId(G1, O1)).not.toContain(':');
  });
});

describe('pickRoundRobinOrg', () => {
  const t0 = new Date('2026-10-24T08:00:00.000Z');
  const t1 = new Date('2026-10-24T09:00:00.000Z');

  it('returns null for no candidates', () => {
    expect(pickRoundRobinOrg([])).toBeNull();
  });

  it('prefers never-assessed orgs, lowest orgId first', () => {
    expect(pickRoundRobinOrg([
      { orgId: O3, lastAssessedAt: null },
      { orgId: O1, lastAssessedAt: t0 },
      { orgId: O2, lastAssessedAt: null },
    ])).toBe(O2);
  });

  it('otherwise returns the oldest lastAssessedAt; ties by orgId', () => {
    expect(pickRoundRobinOrg([
      { orgId: O1, lastAssessedAt: t1 },
      { orgId: O3, lastAssessedAt: t0 },
      { orgId: O2, lastAssessedAt: t0 },
    ])).toBe(O2);
    expect(pickRoundRobinOrg([
      { orgId: O1, lastAssessedAt: t1 },
      { orgId: O2, lastAssessedAt: t0 },
    ])).toBe(O2);
  });

  it('is deterministic under input shuffling', () => {
    const base = [
      { orgId: O1, lastAssessedAt: t1 },
      { orgId: O2, lastAssessedAt: t0 },
      { orgId: O3, lastAssessedAt: t0 },
      { orgId: orgId(9), lastAssessedAt: t1 },
    ];
    const orders = [base, [...base].reverse(), [base[2]!, base[0]!, base[3]!, base[1]!]];
    for (const order of orders) expect(pickRoundRobinOrg(order)).toBe(O2);
    // and the input is not mutated
    expect(base[0]!.orgId).toBe(O1);
  });
});

describe('requestAssessment', () => {
  it('coalesces N wake requests inside 60 s into one delayed job with id wisp-assess-<grant>-<org>', async () => {
    const results: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      results.push(await requestAssessment({ grantId: G1, orgId: O1, reason: { kind: 'event', eventType: 'alert.triggered', eventId: `e${i}` } }));
    }
    expect(results[0]).toBe('queued');
    expect(results.slice(1).every((r) => r === 'coalesced')).toBe(true);
    expect(h.jobs.size).toBe(1);
    const [job] = [...h.jobs.entries()];
    expect(job![0]).toBe(`wisp-assess-${G1}-${O1}`);
    expect(job![1].state).toBe('delayed');
    expect(job![1].opts).toMatchObject({ jobId: `wisp-assess-${G1}-${O1}`, delay: 60_000 });
    // A transient enqueue failure retries on the same job (same jobId, so the
    // window keeps coalescing while the retry waits in 'delayed').
    expect(job![1].opts).toMatchObject({ attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
    // The first request's reason is the one stored.
    expect(job![1].data).toMatchObject({ grantId: G1, orgId: O1, reason: { kind: 'event', eventId: 'e0' } });
  });

  it('keys the window per (grant, org): another org or grant gets its own job', async () => {
    expect(await requestAssessment({ grantId: G1, orgId: O1, reason: { kind: 'tick' } })).toBe('queued');
    expect(await requestAssessment({ grantId: G1, orgId: O2, reason: { kind: 'tick' } })).toBe('queued');
    expect(await requestAssessment({ grantId: G2, orgId: O1, reason: { kind: 'tick' } })).toBe('queued');
    expect(h.jobs.size).toBe(3);
  });

  it('a new request after the job completed creates a new job', async () => {
    expect(await requestAssessment({ grantId: G1, orgId: O1, reason: { kind: 'tick' } })).toBe('queued');
    // removeOnComplete drops the record ...
    h.jobs.delete(wakeJobId(G1, O1));
    expect(await requestAssessment({ grantId: G1, orgId: O1, reason: { kind: 'watch', watchId: 'w1' } })).toBe('queued');
    // ... and a retained completed / failed record must not swallow the next wake.
    h.jobs.get(wakeJobId(G1, O1))!.state = 'completed';
    expect(await requestAssessment({ grantId: G1, orgId: O1, reason: { kind: 'onboarding' } })).toBe('queued');
    h.jobs.get(wakeJobId(G1, O1))!.state = 'failed';
    expect(await requestAssessment({ grantId: G1, orgId: O1, reason: { kind: 'tick' } })).toBe('queued');
    expect(assessAdds()).toHaveLength(4);
    expect(h.jobs.get(wakeJobId(G1, O1))!.state).toBe('delayed');
  });

  it('carries the deterministic digest hint in the job data', async () => {
    await requestAssessment({
      grantId: G1, orgId: O1, reason: { kind: 'tick' }, subject: { kind: 'alert', id: ALERT },
    });
    expect(h.jobs.get(wakeJobId(G1, O1))!.data).toMatchObject({ subject: { kind: 'alert', id: ALERT } });
  });
});

describe('handleWispWakeEvent', () => {
  it('returns without DB access when wispEnabled() is false', async () => {
    h.enabled = false;
    useFixtures({ eventGrants: [{ grant_id: G1 }] });
    await handleWispWakeEvent(event('alert.triggered', O1, { alertId: ALERT }));
    await handleWispWakeEvent(event('wisp.grant.created', O1, { grantId: G1 }));
    expect(h.executes).toHaveLength(0);
    expect(h.adds).toHaveLength(0);
  });

  it('fans one request per active grant covering the event org; a paused grant gets none', async () => {
    useFixtures({ eventGrants: [{ grant_id: G1 }, { grant_id: G2 }] });
    await handleWispWakeEvent(event('ticket.sla_breached', O1, { ticketId: TASK }));
    const q = h.executes.find((e) => /FROM wisp_grants g/.test(e.text))!;
    expect(q.inSystem).toBe(true);
    // Only active, unexpired grants of the org's partner that cover the org.
    expect(q.text).toMatch(/g\.status = 'active'/);
    expect(q.text).toMatch(/g\.expires_at >/);
    expect(q.text).toMatch(/\(g\.org_id IS NULL OR g\.org_id = organizations\.id\)/);
    expect(q.text).toMatch(/organizations\.partner_id = g\.partner_id/);
    // Live orgs only (copied from aiAgentSweepScheduler's loadPartnerOrgIds).
    expect(q.text).toMatch(/organizations\.type <> 'quick_support'/);
    expect(q.text).toMatch(/organizations\.deleted_at IS NULL/);
    expect(q.text).toMatch(/organizations\.status IN \('active', 'trial'\)/);
    expect(q.text).toMatch(/"organizations"\."type" <>/); // notHoldingOrgCondition()
    expect(q.params).toContain(O1);

    const adds = assessAdds();
    expect(adds.map((a) => (a.data as { grantId: string }).grantId)).toEqual([G1, G2]);
    for (const a of adds) {
      expect(a.inSystem).toBe(false); // never enqueue inside a DB context
      expect(a.data).toMatchObject({
        orgId: O1,
        reason: { kind: 'event', eventType: 'ticket.sla_breached', eventId: 'evt-ticket.sla_breached' },
      });
      // ticket.sla_breached is not a digest event: no hint.
      expect(a.data).not.toHaveProperty('subject');
    }
  });

  it('a non-uuid event org reads nothing', async () => {
    await handleWispWakeEvent(event('alert.triggered', 'not-a-uuid', { alertId: ALERT }));
    expect(h.executes).toHaveLength(0);
    expect(h.adds).toHaveLength(0);
  });

  it('ignores ai.agent.run.completed for profile assessment', async () => {
    useFixtures({ runProfile: [{ profile: 'assessment' }], eventGrants: [{ grant_id: G1 }] });
    await handleWispWakeEvent(event('ai.agent.run.completed', O1, { runId: RUN }));
    await handleWispWakeEvent(event('ai.agent.run.failed', O1, { runId: RUN }));
    expect(h.executes.some((e) => /FROM wisp_grants g/.test(e.text))).toBe(false);
    expect(h.adds).toHaveLength(0);
  });

  it('wakes on ai.agent.run.completed of another profile', async () => {
    useFixtures({ runProfile: [{ profile: 'triage' }], eventGrants: [{ grant_id: G1 }] });
    await handleWispWakeEvent(event('ai.agent.run.completed', O1, { runId: RUN }));
    const lookup = h.executes.find((e) => /SELECT profile FROM ai_agent_runs/.test(e.text))!;
    expect(lookup.params).toContain(RUN);
    expect(assessAdds()).toHaveLength(1);
  });

  it('alert.triggered carries { kind: alert } as the digest hint', async () => {
    useFixtures({ eventGrants: [{ grant_id: G1 }] });
    await handleWispWakeEvent(event('alert.triggered', O1, { alertId: ALERT }));
    expect(assessAdds()[0]!.data).toMatchObject({ subject: { kind: 'alert', id: ALERT } });
  });

  it('a failed operator task carries { kind: task } and failed: true', async () => {
    useFixtures({ eventGrants: [{ grant_id: G1 }] });
    await handleWispWakeEvent(event('ai.operator.task.finished', O1, { taskId: TASK, state: 'failed' }));
    expect(assessAdds()[0]!.data).toMatchObject({ subject: { kind: 'task', id: TASK }, failed: true });
  });

  it('integration.health_opened and ticket.stale name their subjects; a non-uuid id is dropped', async () => {
    useFixtures({ eventGrants: [{ grant_id: G1 }] });
    await handleWispWakeEvent(event('integration.health_opened', O1, { incidentId: ALERT }));
    expect(assessAdds()[0]!.data).toMatchObject({ subject: { kind: 'integration', id: ALERT } });
    h.jobs.clear();
    h.adds = [];
    await handleWispWakeEvent(event('ticket.stale', O1, { ticketId: TASK }));
    expect(assessAdds()[0]!.data).toMatchObject({ subject: { kind: 'ticket', id: TASK } });
    h.jobs.clear();
    h.adds = [];
    await handleWispWakeEvent(event('alert.triggered', O1, { alertId: 'nope' }));
    expect(assessAdds()[0]!.data).not.toHaveProperty('subject');
  });

  it('wisp.grant.created fans ≤ 10 onboarding requests, ordered by org name', async () => {
    // 13 live orgs; 12 inside the ceiling; names deliberately not in id order.
    const names = ['Mango', 'apple', 'Kiwi', 'Banana', 'Lime', 'cherry', 'Date', 'Fig', 'Grape', 'Honeydew', 'Jackfruit', 'Elder', 'Outside'];
    const orgs = names.map((name, i) => ({ id: orgId(100 + i), name }));
    const inCeiling = orgs.filter((o) => o.name !== 'Outside').map((o) => o.id);
    useFixtures({
      grantRow: [{ id: G1, partner_id: P1, status: 'active', current_revision_id: REV }],
      orgs: [...orgs].reverse(), // shuffled relative to name order
    });
    h.resolveGrantCeiling.mockResolvedValue(ceiling(inCeiling));

    // Partner-wide grants route on the partner id (routes/wisp.ts publishGrantEvent).
    await handleWispWakeEvent(event('wisp.grant.created', P1, { grantId: G1, partnerId: P1, orgId: null }));

    expect(h.resolveGrantCeiling).toHaveBeenCalledWith(G1, REV);
    const adds = assessAdds();
    expect(adds).toHaveLength(10);
    const byId = new Map(orgs.map((o) => [o.id, o.name]));
    expect(adds.map((a) => byId.get((a.data as { orgId: string }).orgId))).toEqual([
      'apple', 'Banana', 'cherry', 'Date', 'Elder', 'Fig', 'Grape', 'Honeydew', 'Jackfruit', 'Kiwi',
    ]);
    for (const a of adds) expect(a.data).toMatchObject({ grantId: G1, reason: { kind: 'onboarding' } });
    // The grant's own routing id is never treated as an event org.
    expect(h.executes.some((e) => /FROM wisp_grants g/.test(e.text))).toBe(false);
  });

  it('wisp.grant.created for an inactive grant requests nothing', async () => {
    useFixtures({ grantRow: [{ id: G1, partner_id: P1, status: 'paused', current_revision_id: REV }] });
    await handleWispWakeEvent(event('wisp.grant.created', P1, { grantId: G1 }));
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
    expect(h.adds).toHaveLength(0);

    useFixtures({ grantRow: [{ id: G1, partner_id: P1, status: 'active', current_revision_id: REV }] });
    h.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError(G1, 'paused'));
    await handleWispWakeEvent(event('wisp.grant.created', P1, { grantId: G1 }));
    expect(h.adds).toHaveLength(0);
  });

  it('wisp.grant.resumed issues one tick request for the round-robin org', async () => {
    useFixtures({
      grantRow: [{ id: G1, partner_id: P1, status: 'active', current_revision_id: REV }],
      orgs: [{ id: O1, name: 'A' }, { id: O2, name: 'B' }, { id: O3, name: 'C' }],
      lastAssessed: [
        { org_id: O1, last_assessed_at: '2026-10-24 09:00:00+00' },
        { org_id: O2, last_assessed_at: '2026-10-24 08:00:00+00' },
        { org_id: O3, last_assessed_at: '2026-10-24 07:00:00+00' }, // oldest, but outside the ceiling
      ],
    });
    h.resolveGrantCeiling.mockResolvedValue(ceiling([O1, O2]));
    await handleWispWakeEvent(event('wisp.grant.resumed', O1, { grantId: G1, partnerId: P1, orgId: O1 }));
    const adds = assessAdds();
    expect(adds).toHaveLength(1);
    expect(adds[0]!.data).toMatchObject({ grantId: G1, orgId: O2, reason: { kind: 'tick' } });
    const last = h.executes.find((e) => /max\(finished_at\)/.test(e.text))!;
    expect(last.text).toMatch(/profile = 'assessment'/);
    // An assessment that ended awaiting_approval (it minted an intent) still
    // assessed the org: counting only 'completed' would leave that org
    // "never assessed" and the floor tick would pick it forever.
    expect(last.text).toMatch(/status IN \('completed', 'awaiting_approval'\)/);
    expect(last.text).not.toMatch(/status = 'completed'/);
    expect(last.params).toContain(G1);
  });
});
