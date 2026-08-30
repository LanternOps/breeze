/**
 * aiAgentSweepScheduler (Phase 2 wave P2-2, task 9) — mocked-DB unit tests.
 *
 * Covers the two halves of the fixed-tick sweeper:
 *  - `processSweepTick` — one occurrence job per due partner baseline, the
 *    deterministic (colon-free) jobId, the ADD-then-CAS ordering that makes a
 *    crash between the two harmless, and the `lastOccurrenceKey` skip;
 *  - `processSweepOccurrence` — per-org fan-out under the partner, the
 *    `quick_support` exclusion, the tighten-only override merge, the skip
 *    tally, and the aggregate-only `last_run_summary` (no org identifiers).
 *
 * `createAndEnqueueAgentRun` itself (every admission gate) is covered by
 * runService.test.ts and agentRunAdmission.integration.test.ts — mocked here,
 * same as alertVerdictScheduler.test.ts mocks `enqueueVerdictRunForAlert`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  capturedWorkerProcessors,
  attachWorkerObservabilityMock,
  callOrder,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  capturedWorkerProcessors: { current: [] as Array<(job: { name: string; data: unknown }) => Promise<unknown>> },
  attachWorkerObservabilityMock: vi.fn(),
  callOrder: { current: [] as string[] },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (key: string) => removeRepeatableByKeyMock(key);
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: { name: string; data: unknown }) => Promise<unknown>) {
      capturedWorkerProcessors.current.push(processor);
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

const shared = vi.hoisted(() => ({ aiAgentsEnabled: true }));

// `envFlag`, not a frozen `AI_AGENTS_ENABLED` const: the module header
// promises the kill switch resumes sweeping WITHOUT a process restart, which
// is only true if the producer reads it at call time (review fix, #4189).
// Mocked as the real function shape so the module cannot go back to a
// module-scope read without this suite noticing.
vi.mock('../config/env', () => ({
  envFlag: vi.fn((name: string, fallback = false) => (
    name === 'BREEZE_AI_AGENTS_ENABLED' ? shared.aiAgentsEnabled : fallback
  )),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: (...args: unknown[]) => attachWorkerObservabilityMock(...(args as [])),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
}));

const resolveEffectiveSchedulesForPartner = vi.hoisted(() => vi.fn());
vi.mock('../services/aiAgents/scheduleService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiAgents/scheduleService')>();
  return { ...actual, resolveEffectiveSchedulesForPartner };
});

const createAndEnqueueAgentRun = vi.hoisted(() => vi.fn());
vi.mock('../services/aiAgents/runService', () => ({ createAndEnqueueAgentRun }));

import { db } from '../db';
import {
  AI_AGENT_SWEEP_QUEUE,
  SWEEP_TICK_INTERVAL_MS,
  getSweepOccurrenceJobId,
  initializeAiAgentSweepScheduler,
  MAX_ORGS_PER_OCCURRENCE,
  processSweepOccurrence,
  processSweepTick,
  shutdownAiAgentSweepScheduler,
} from './aiAgentSweepScheduler';

const SCHEDULE_ID = '00000000-0000-4000-8000-00000000a001';
const AGENT_ID = '00000000-0000-4000-8000-00000000a002';
const PARTNER_ID = '00000000-0000-4000-8000-00000000a003';
const ORG_A = '00000000-0000-4000-8000-00000000a0aa';
const ORG_B = '00000000-0000-4000-8000-00000000a0bb';
const ORG_QS = '00000000-0000-4000-8000-00000000a0cc';

// ---------------------------------------------------------------------------
// Drizzle chain mocks
// ---------------------------------------------------------------------------

/** `db.select(...).from(...)[.innerJoin(...)].where(...)` -> rows. */
function queueSelect(rows: unknown[]) {
  const orderBy = vi.fn();
  const terminal = Object.assign(Promise.resolve(rows), {
    limit: vi.fn().mockResolvedValue(rows),
    orderBy,
  });
  orderBy.mockReturnValue(terminal);
  const where = vi.fn().mockReturnValue(terminal);
  const from = { innerJoin: vi.fn().mockReturnValue({ where }), where };
  vi.mocked(db.select).mockReturnValueOnce({ from: vi.fn().mockReturnValue(from) } as never);
}

/** `db.update(...).set(...).where(...)[.returning(...)]` -> rows. */
function queueUpdate(rows: unknown[], label = 'cas') {
  const terminal = Object.assign(Promise.resolve(rows), {
    returning: vi.fn().mockResolvedValue(rows),
  });
  const where = vi.fn().mockImplementation(() => {
    callOrder.current.push(label);
    return terminal;
  });
  vi.mocked(db.update).mockReturnValueOnce({
    set: vi.fn().mockReturnValue({ where }),
  } as never);
}

function baselineRow(over: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID,
    agentId: AGENT_ID,
    partnerId: PARTNER_ID,
    cron: '0 6 * * *',
    timezone: 'Europe/Berlin',
    kind: 'sweep',
    sweepKinds: ['disk_pressure', 'stale_agents'],
    enabled: true,
    lastOccurrenceKey: null,
    ...over,
  };
}

const OCCURRENCE_KEY = '2026-08-29T06:00@Europe/Berlin';
/** 07:07 Berlin on 2026-08-29 — the 06:00 occurrence is 67 minutes back. */
const NOW = new Date('2026-08-29T05:07:00Z');

beforeEach(() => {
  shared.aiAgentsEnabled = true;
  addMock.mockReset().mockResolvedValue(undefined);
  getRepeatableJobsMock.mockReset().mockResolvedValue([]);
  removeRepeatableByKeyMock.mockReset().mockResolvedValue(undefined);
  queueCloseMock.mockReset().mockResolvedValue(undefined);
  workerCloseMock.mockReset().mockResolvedValue(undefined);
  attachWorkerObservabilityMock.mockReset();
  capturedWorkerProcessors.current = [];
  callOrder.current = [];
  vi.mocked(db.select).mockReset();
  vi.mocked(db.update).mockReset();
  resolveEffectiveSchedulesForPartner.mockReset();
  createAndEnqueueAgentRun.mockReset().mockResolvedValue({ created: true, run: { id: 'run-1' } });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------

describe('constants', () => {
  it('ticks every 5 minutes on the shared sweep queue', () => {
    expect(SWEEP_TICK_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(AI_AGENT_SWEEP_QUEUE).toBe('ai-agent-sweep');
  });
});

describe('getSweepOccurrenceJobId', () => {
  it('is deterministic and strips every character BullMQ rejects in a jobId', () => {
    const id = getSweepOccurrenceJobId(SCHEDULE_ID, OCCURRENCE_KEY);
    expect(id).toBe(`sweep-occ-${SCHEDULE_ID}-20260829T0600EuropeBerlin`);
    expect(id).not.toContain(':');
    expect(id).toBe(getSweepOccurrenceJobId(SCHEDULE_ID, OCCURRENCE_KEY));
  });
});

describe('processSweepTick', () => {
  it('enqueues one occurrence job per due baseline, then CASes the key', async () => {
    queueSelect([baselineRow()]);
    queueUpdate([{ id: SCHEDULE_ID }]);

    const result = await processSweepTick(NOW);

    expect(result).toEqual({ scanned: 1, enqueued: 1 });
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(
      'occurrence',
      { scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY },
      expect.objectContaining({
        jobId: getSweepOccurrenceJobId(SCHEDULE_ID, OCCURRENCE_KEY),
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        // Retention, not `true`: the jobId is only a duplicate guard for as
        // long as the job still exists in Redis.
        removeOnComplete: { count: 200 },
        removeOnFail: 50,
      }),
    );
  });

  it('adds the job BEFORE the CAS — a crash in between is deduped by the jobId', async () => {
    queueSelect([baselineRow()]);
    queueUpdate([{ id: SCHEDULE_ID }]);
    addMock.mockImplementation(async () => { callOrder.current.push('add'); });

    await processSweepTick(NOW);

    expect(callOrder.current).toEqual(['add', 'cas']);
  });

  it('skips a baseline whose lastOccurrenceKey already equals the computed key', async () => {
    queueSelect([baselineRow({ lastOccurrenceKey: OCCURRENCE_KEY })]);

    const result = await processSweepTick(NOW);

    expect(result).toEqual({ scanned: 1, enqueued: 0 });
    expect(addMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('skips a baseline with no occurrence inside the lookback', async () => {
    // Monday-only cron, evaluated on a Saturday.
    queueSelect([baselineRow({ cron: '0 6 * * 1', timezone: 'UTC' })]);

    const result = await processSweepTick(NOW);

    expect(result).toEqual({ scanned: 1, enqueued: 0 });
    expect(addMock).not.toHaveBeenCalled();
  });

  it('a lost CAS (another replica won) is not an error', async () => {
    queueSelect([baselineRow()]);
    queueUpdate([]); // zero rows updated

    await expect(processSweepTick(NOW)).resolves.toEqual({ scanned: 1, enqueued: 1 });
  });

  it('one bad baseline (invalid IANA timezone) does not abort the scan for the others', async () => {
    const broken = baselineRow({ id: 'schedule-broken', timezone: 'Mars/Olympus' });
    queueSelect([broken, baselineRow()]);
    queueUpdate([{ id: SCHEDULE_ID }]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // `isCronDue` builds an Intl.DateTimeFormat for the row's zone and throws
    // RangeError on the first candidate minute — a per-schedule fault.
    const result = await processSweepTick(NOW);

    expect(result).toEqual({ scanned: 2, enqueued: 1 });
    expect(addMock).toHaveBeenCalledTimes(1);
    expect((addMock.mock.calls[0]![1] as { scheduleId: string }).scheduleId).toBe(SCHEDULE_ID);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('tick failed for one schedule'),
      expect.objectContaining({ scheduleId: 'schedule-broken', timezone: 'Mars/Olympus' }),
    );
  });

  it('a transient queue.add failure is logged and the scan continues', async () => {
    queueSelect([baselineRow({ id: 'schedule-redis-blip' }), baselineRow()]);
    queueUpdate([{ id: SCHEDULE_ID }]);
    addMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(undefined);

    const result = await processSweepTick(NOW);

    expect(result).toEqual({ scanned: 2, enqueued: 1 });
    // The failed baseline's CAS never ran, so the next tick retries it.
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the kill switch is off — nothing is read and nothing is added', async () => {
    shared.aiAgentsEnabled = false;

    const result = await processSweepTick(NOW);

    expect(result).toEqual({ scanned: 0, enqueued: 0 });
    expect(db.select).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  // Item 5 (#4189). The module header claims flipping the switch back on
  // resumes sweeping "without a process restart". A module-scope
  // `AI_AGENTS_ENABLED` const freezes the value at import, which makes that
  // claim false; only a per-call read keeps it true. Both directions, in ONE
  // module instance — no vi.resetModules().
  it('reads the kill switch at CALL time, so flipping it back on resumes without a restart', async () => {
    shared.aiAgentsEnabled = false;
    expect(await processSweepTick(NOW)).toEqual({ scanned: 0, enqueued: 0 });

    shared.aiAgentsEnabled = true;
    queueSelect([baselineRow()]);
    queueUpdate([{ id: SCHEDULE_ID }]);

    expect(await processSweepTick(NOW)).toEqual({ scanned: 1, enqueued: 1 });
  });
});

describe('processSweepOccurrence', () => {
  function seedFanout(over: {
    baseline?: Record<string, unknown>;
    overridesByOrg?: Map<string, { id: string; enabled: boolean; sweepKinds: string[] }>;
    orgs?: Array<{ id: string }>;
  } = {}) {
    const baseline = baselineRow(over.baseline);
    queueSelect([baseline]); // baseline + agent re-read
    resolveEffectiveSchedulesForPartner.mockResolvedValue([
      { baseline, overridesByOrg: over.overridesByOrg ?? new Map() },
    ]);
    queueSelect(over.orgs ?? [{ id: ORG_A }, { id: ORG_B }]); // partner orgs (quick_support already excluded by the predicate)
    queueUpdate([], 'summary'); // last_run_summary write
    return baseline;
  }

  it('fans out one sweep run per org, device-less, on the sweep profile', async () => {
    seedFanout();

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(2);
    expect(createAndEnqueueAgentRun).toHaveBeenCalledWith({
      orgId: ORG_A,
      kind: 'triage',
      triggerKind: 'schedule',
      deviceId: null,
      profile: 'sweep',
      scheduleId: SCHEDULE_ID,
      triggerRef: {
        scheduleId: SCHEDULE_ID,
        occurrenceKey: OCCURRENCE_KEY,
        sweepKinds: ['disk_pressure', 'stale_agents'],
      },
      dedupeKey: `sweep-${SCHEDULE_ID}-${ORG_A}-${OCCURRENCE_KEY}`,
    });
    expect(summary).toMatchObject({
      occurrenceKey: OCCURRENCE_KEY,
      orgsTotal: 2,
      runsAdmitted: 2,
      runsSkipped: 0,
      skipReasons: {},
    });
    expect(Number.isNaN(Date.parse(summary.enqueuedAt))).toBe(false);
  });

  it('narrows the kinds to the org override intersection (tighten-only)', async () => {
    seedFanout({
      overridesByOrg: new Map([[ORG_A, { id: 'ovr-a', enabled: true, sweepKinds: ['stale_agents'] }]]),
    });

    await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    const forA = createAndEnqueueAgentRun.mock.calls.find((c) => (c[0] as { orgId: string }).orgId === ORG_A);
    expect((forA![0] as { triggerRef: { sweepKinds: string[] } }).triggerRef.sweepKinds).toEqual(['stale_agents']);
    const forB = createAndEnqueueAgentRun.mock.calls.find((c) => (c[0] as { orgId: string }).orgId === ORG_B);
    expect((forB![0] as { triggerRef: { sweepKinds: string[] } }).triggerRef.sweepKinds)
      .toEqual(['disk_pressure', 'stale_agents']);
  });

  it('skips an override-disabled org and tallies it as override_disabled', async () => {
    seedFanout({
      overridesByOrg: new Map([[ORG_B, { id: 'ovr-b', enabled: false, sweepKinds: ['disk_pressure'] }]]),
    });

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(1);
    expect((createAndEnqueueAgentRun.mock.calls[0]![0] as { orgId: string }).orgId).toBe(ORG_A);
    expect(summary).toMatchObject({
      orgsTotal: 2, runsAdmitted: 1, runsSkipped: 1, skipReasons: { override_disabled: 1 },
    });
  });

  it('skips an org whose override intersects the baseline to no kinds at all', async () => {
    seedFanout({
      overridesByOrg: new Map([[ORG_B, { id: 'ovr-b', enabled: true, sweepKinds: [] }]]),
    });

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(summary.skipReasons).toEqual({ override_disabled: 1 });
  });

  it('tallies the admission skip reasons createAndEnqueueAgentRun returns', async () => {
    seedFanout();
    createAndEnqueueAgentRun
      .mockResolvedValueOnce({ created: false, skipped: 'circuit_open' })
      .mockResolvedValueOnce({ created: false, skipped: 'duplicate' });

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(summary).toMatchObject({
      orgsTotal: 2,
      runsAdmitted: 0,
      runsSkipped: 2,
      skipReasons: { circuit_open: 1, duplicate: 1 },
    });
  });

  it('one org whose admission THROWS does not cost the other orgs their sweep', async () => {
    const ORG_C = '00000000-0000-4000-8000-00000000a0dd';
    seedFanout({ orgs: [{ id: ORG_A }, { id: ORG_B }, { id: ORG_C }] });
    createAndEnqueueAgentRun
      .mockRejectedValueOnce(new Error('pool exhausted'))
      .mockResolvedValueOnce({ created: true, run: { id: 'run-b' } })
      .mockResolvedValueOnce({ created: true, run: { id: 'run-c' } });

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({
      orgsTotal: 3,
      runsAdmitted: 2,
      runsSkipped: 1,
      skipReasons: { error: 1 },
    });
    // The summary is written even though the fan-out was only partly
    // successful — it is the only durable record the occurrence was attempted.
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(callOrder.current).toContain('summary');
  });

  it('a baseline disabled between the two reads reports schedule_disabled, not override_disabled', async () => {
    // The eligibility read gated `enabled = true`; the LATER resolver read sees
    // the disable. Folding that into the per-org merge would claim every org
    // opted out.
    const eligible = baselineRow();
    queueSelect([eligible]);
    resolveEffectiveSchedulesForPartner.mockResolvedValue([
      { baseline: { ...eligible, enabled: false }, overridesByOrg: new Map() },
    ]);
    queueSelect([{ id: ORG_A }, { id: ORG_B }]);
    queueUpdate([], 'summary');

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      orgsTotal: 2,
      runsAdmitted: 0,
      runsSkipped: 2,
      skipReasons: { schedule_disabled: 2 },
    });
  });

  it('writes only aggregate counters — never an org id or name', async () => {
    seedFanout({
      overridesByOrg: new Map([[ORG_B, { id: 'ovr-b', enabled: false, sweepKinds: [] }]]),
    });

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(ORG_A);
    expect(serialized).not.toContain(ORG_B);
    expect(serialized).not.toContain(ORG_QS);
    expect(Object.keys(summary).sort()).toEqual([
      'enqueuedAt', 'occurrenceKey', 'orgsTotal', 'runsAdmitted', 'runsSkipped', 'skipReasons',
    ]);
  });

  it('the org enumeration is pinned to the partner and excludes quick_support orgs', async () => {
    // Assert the COMPILED predicate, not a hand-rolled row fixture: a mocked
    // `where` returns whatever it is handed regardless of the condition, so
    // only the emitted SQL can prove the exclusion is really there
    // (`[[vacuous_drizzle_where_clause_assertions]]`).
    const captured: unknown[] = [];
    const baseline = baselineRow();
    queueSelect([baseline]);
    resolveEffectiveSchedulesForPartner.mockResolvedValue([{ baseline, overridesByOrg: new Map() }]);
    const orderBy = vi.fn();
    const terminal = Object.assign(Promise.resolve([{ id: ORG_A }]), { limit: vi.fn(), orderBy });
    orderBy.mockReturnValue(terminal);
    const where = vi.fn().mockImplementation((condition: unknown) => {
      captured.push(condition);
      return terminal;
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where, innerJoin: vi.fn().mockReturnValue({ where }) }),
    } as never);
    queueUpdate([], 'summary');

    await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    const compiled = new PgDialect().sqlToQuery(captured[0] as SQL);
    expect(compiled.sql).toMatch(/"partner_id"\s*=/);
    expect(compiled.sql).toMatch(/"type"\s*<>/);
    // Live tenants only: a soft-deleted or non-active/trial org is excluded
    // from the ENUMERATION, so it never even reaches `orgsTotal`.
    expect(compiled.sql).toMatch(/"deleted_at"\s+is\s+null/i);
    expect(compiled.sql).toMatch(/"status"\s+in\s*\(/i);
    expect(compiled.params).toEqual(
      expect.arrayContaining([PARTNER_ID, 'quick_support', 'active', 'trial']),
    );
    // And nothing else: `['active','trial']` is the same live-org definition
    // middleware/auth.ts uses, so a widened list here is a real divergence.
    expect(compiled.params.filter((p) => p === 'suspended' || p === 'offboarding')).toEqual([]);
  });

  // Item 4 (#4189). Both early returns used to leave `last_run_summary`
  // showing the PREVIOUS occurrence's numbers, so a schedule that stopped
  // firing looked like it was still fanning out — the exact state an operator
  // consults this column to detect. The loop's `finally` already wrote it for
  // every other path; these two returns bypassed it.
  it('writes an empty summary for THIS occurrence when the baseline is gone, disabled, or its agent is disabled', async () => {
    queueSelect([]); // the joined re-read matched nothing
    queueUpdate([], 'summary');

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      occurrenceKey: OCCURRENCE_KEY, orgsTotal: 0, runsAdmitted: 0, runsSkipped: 0, skipReasons: {},
    });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(callOrder.current).toContain('summary');
  });

  it('writes an empty summary when the baseline vanished from the partner resolver', async () => {
    queueSelect([baselineRow()]);
    resolveEffectiveSchedulesForPartner.mockResolvedValue([]); // no matching entry
    queueUpdate([], 'summary');

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(summary).toMatchObject({ occurrenceKey: OCCURRENCE_KEY, orgsTotal: 0 });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(callOrder.current).toContain('summary');
  });

  it('a failed summary write on an early return is logged, never thrown', async () => {
    queueSelect([]);
    vi.mocked(db.update).mockImplementationOnce(() => { throw new Error('pool exhausted'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY }),
    ).resolves.toMatchObject({ occurrenceKey: OCCURRENCE_KEY });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to persist last_run_summary'),
      expect.objectContaining({ scheduleId: SCHEDULE_ID }),
    );
  });

  // Item 3b (#4189). One occurrence fans out one LLM-spending run PER LIVE
  // ORG, so a very large partner is an unbounded burst against the run queue,
  // the model provider, and the billing meter. The cap is a hard admission
  // ceiling with a DETERMINISTIC order, so the same 500 orgs are swept every
  // occurrence rather than a different arbitrary slice each time.
  it('admits at most MAX_ORGS_PER_OCCURRENCE orgs and counts the remainder as org_cap', async () => {
    const orgs = Array.from({ length: MAX_ORGS_PER_OCCURRENCE + 2 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    seedFanout({ orgs });
    // `console.error` is already spied in beforeEach and vi.spyOn hands back
    // the SAME mock, so its calls accumulate across tests — clear it or this
    // assertion reads another test's log line.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    errorSpy.mockClear();

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(MAX_ORGS_PER_OCCURRENCE);
    expect(summary).toMatchObject({
      // orgsTotal is the TRUE population, so the three counters still add up:
      // 502 = 500 admitted + 2 capped.
      orgsTotal: MAX_ORGS_PER_OCCURRENCE + 2,
      runsAdmitted: MAX_ORGS_PER_OCCURRENCE,
      runsSkipped: 2,
      skipReasons: { org_cap: 2 },
    });
    // ONE log line for the whole overflow, not one per skipped org.
    const capLogs = errorSpy.mock.calls.filter(([msg]) => String(msg).includes('org cap'));
    expect(capLogs).toHaveLength(1);
    expect(capLogs[0]![1]).toMatchObject({
      partnerId: PARTNER_ID,
      admitted: MAX_ORGS_PER_OCCURRENCE,
      skipped: 2,
    });
    // The summary stays aggregate-only even under the cap.
    expect(JSON.stringify(summary)).not.toContain(orgs[0]!.id);
  });

  it('does not cap, or log, a partner at exactly the ceiling', async () => {
    const orgs = Array.from({ length: MAX_ORGS_PER_OCCURRENCE }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    seedFanout({ orgs });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    errorSpy.mockClear();

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(summary).toMatchObject({
      orgsTotal: MAX_ORGS_PER_OCCURRENCE,
      runsAdmitted: MAX_ORGS_PER_OCCURRENCE,
      skipReasons: {},
    });
    expect(errorSpy.mock.calls.filter(([msg]) => String(msg).includes('org cap'))).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // P2-3 — the narrative branch (one weekly report run per org)
  // -------------------------------------------------------------------------

  /** A narrative baseline sweeps NOTHING — `ai_agent_schedules_kind_kinds_chk`
   *  forbids any other shape — and fires on a weekly literal cron. */
  const narrativeBaselineFields = { kind: 'narrative', sweepKinds: [] as string[], cron: '0 7 * * 1' };

  it('fans out one narrative run per org, device-less, on the narrative profile', async () => {
    seedFanout({ baseline: narrativeBaselineFields });

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(2);
    expect(createAndEnqueueAgentRun).toHaveBeenCalledWith({
      orgId: ORG_A,
      kind: 'triage',
      triggerKind: 'schedule',
      deviceId: null,
      profile: 'narrative',
      scheduleId: SCHEDULE_ID,
      triggerRef: { scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY, kind: 'narrative' },
      dedupeKey: `narrative-${SCHEDULE_ID}-${ORG_A}-${OCCURRENCE_KEY}`,
    });
    expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_B,
        profile: 'narrative',
        dedupeKey: `narrative-${SCHEDULE_ID}-${ORG_B}-${OCCURRENCE_KEY}`,
      }),
    );
    // The dedupe key is namespaced by PROFILE, not just by schedule: a sweep
    // key here would collide with the sweep fan-out's own run for the same
    // (schedule, org, occurrence) and silently drop one of the two.
    for (const [call] of createAndEnqueueAgentRun.mock.calls) {
      expect((call as { dedupeKey: string }).dedupeKey.startsWith('sweep-')).toBe(false);
      expect((call as { triggerRef: Record<string, unknown> }).triggerRef).not.toHaveProperty('sweepKinds');
    }
    expect(summary).toMatchObject({
      occurrenceKey: OCCURRENCE_KEY,
      orgsTotal: 2,
      runsAdmitted: 2,
      runsSkipped: 0,
      skipReasons: {},
    });
    expect(summary.orgsTotal).toBe(summary.runsAdmitted + summary.runsSkipped);
  });

  it('skips the empty-kinds guard for a narrative schedule, but NOT for a sweep one', async () => {
    // Control first: with `sweepKinds: []` a SWEEP baseline intersects every
    // org down to nothing and admits no run at all. This is the branch the
    // narrative path has to step around — asserting only the narrative half
    // would pass even if the guard had simply been deleted.
    seedFanout({ baseline: { sweepKinds: [] } });
    const sweepSummary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(sweepSummary).toMatchObject({ runsAdmitted: 0, runsSkipped: 2, skipReasons: { override_disabled: 2 } });

    seedFanout({ baseline: narrativeBaselineFields });
    const narrativeSummary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });
    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(2);
    expect(narrativeSummary).toMatchObject({ runsAdmitted: 2, runsSkipped: 0, skipReasons: {} });
  });

  it('an org override that disables still skips a narrative occurrence (override_disabled)', async () => {
    seedFanout({
      baseline: narrativeBaselineFields,
      // An override of a narrative baseline carries `[]` too (the composite FK
      // pins its kind, and the CHECK pins its kinds), so `enabled` is the only
      // lever it has — and it must still work.
      overridesByOrg: new Map([[ORG_B, { id: 'ovr-b', enabled: false, sweepKinds: [] }]]),
    });

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(1);
    expect((createAndEnqueueAgentRun.mock.calls[0]![0] as { orgId: string }).orgId).toBe(ORG_A);
    expect(summary).toMatchObject({
      orgsTotal: 2, runsAdmitted: 1, runsSkipped: 1, skipReasons: { override_disabled: 1 },
    });
    expect(summary.orgsTotal).toBe(summary.runsAdmitted + summary.runsSkipped);
  });

  it('a narrative baseline disabled between the two reads still reports schedule_disabled', async () => {
    const eligible = baselineRow(narrativeBaselineFields);
    queueSelect([eligible]);
    resolveEffectiveSchedulesForPartner.mockResolvedValue([
      { baseline: { ...eligible, enabled: false }, overridesByOrg: new Map() },
    ]);
    queueSelect([{ id: ORG_A }, { id: ORG_B }]);
    queueUpdate([], 'summary');

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ orgsTotal: 2, runsSkipped: 2, skipReasons: { schedule_disabled: 2 } });
  });

  it('keeps the narrative summary aggregate-only', async () => {
    seedFanout({ baseline: narrativeBaselineFields });

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(ORG_A);
    expect(serialized).not.toContain(ORG_B);
  });

  it('orders the org enumeration deterministically, so the capped slice is stable', async () => {
    const captured = { orderBy: null as unknown };
    const baseline = baselineRow();
    queueSelect([baseline]);
    resolveEffectiveSchedulesForPartner.mockResolvedValue([{ baseline, overridesByOrg: new Map() }]);
    const orderBy = vi.fn();
    const terminal = Object.assign(Promise.resolve([{ id: ORG_A }]), { limit: vi.fn(), orderBy });
    orderBy.mockImplementation((column: unknown) => { captured.orderBy = column; return terminal; });
    const where = vi.fn().mockReturnValue(terminal);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where, innerJoin: vi.fn().mockReturnValue({ where }) }),
    } as never);
    queueUpdate([], 'summary');

    await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(orderBy).toHaveBeenCalled();
    // `asc(column)` is an SQL node, not the column — compile it, the same way
    // the predicate assertions above do.
    const compiledOrder = new PgDialect().sqlToQuery(captured.orderBy as SQL);
    expect(compiledOrder.sql).toMatch(/"id"\s+asc/i);
  });
});

describe('lifecycle', () => {
  it('registers the worker and reconciles the repeatable tick at boot', async () => {
    getRepeatableJobsMock.mockResolvedValue([
      { name: 'tick', key: 'stale-tick-key' },
      { name: 'other', key: 'leave-me' },
    ]);

    await initializeAiAgentSweepScheduler();

    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale-tick-key');
    expect(removeRepeatableByKeyMock).not.toHaveBeenCalledWith('leave-me');
    expect(addMock).toHaveBeenCalledWith(
      'tick',
      {},
      expect.objectContaining({
        jobId: 'ai-agent-sweep-tick',
        repeat: { every: SWEEP_TICK_INTERVAL_MS },
      }),
    );
    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'aiAgentSweepScheduler');
    expect(capturedWorkerProcessors.current.length).toBeGreaterThan(0);

    await shutdownAiAgentSweepScheduler();
    expect(workerCloseMock).toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalled();
  });

  it('the worker processor dispatches by job name', async () => {
    await initializeAiAgentSweepScheduler();
    const processor = capturedWorkerProcessors.current[0]!;
    addMock.mockClear();

    queueSelect([]); // tick: no baselines
    await processor({ name: 'tick', data: {} });
    expect(db.select).toHaveBeenCalled();

    await expect(processor({ name: 'nope', data: {} })).rejects.toThrow(/nope/);
  });
});
