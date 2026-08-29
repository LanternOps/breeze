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

vi.mock('../config/env', () => ({
  get AI_AGENTS_ENABLED() { return shared.aiAgentsEnabled; },
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
  const terminal = Object.assign(Promise.resolve(rows), {
    limit: vi.fn().mockResolvedValue(rows),
  });
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
        removeOnComplete: true,
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

  it('is a no-op when AI_AGENTS_ENABLED is false — nothing is read and nothing is added', async () => {
    shared.aiAgentsEnabled = false;

    const result = await processSweepTick(NOW);

    expect(result).toEqual({ scanned: 0, enqueued: 0 });
    expect(db.select).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
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
    const terminal = Object.assign(Promise.resolve([{ id: ORG_A }]), { limit: vi.fn() });
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
    expect(compiled.params).toEqual(expect.arrayContaining([PARTNER_ID, 'quick_support']));
  });

  it('returns an empty summary when the baseline is gone, disabled, or its agent is disabled', async () => {
    queueSelect([]); // the joined re-read matched nothing

    const summary = await processSweepOccurrence({ scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY });

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ orgsTotal: 0, runsAdmitted: 0, runsSkipped: 0, skipReasons: {} });
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
