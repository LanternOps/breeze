import { beforeEach, describe, expect, it, vi } from 'vitest';

const { workerCapture, queueAdd } = vi.hoisted(() => ({
  workerCapture: { processor: null as null | ((job: { data: unknown }) => Promise<unknown>), name: '' },
  queueAdd: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn(function (name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
    workerCapture.processor = processor;
    workerCapture.name = name;
    return { on: vi.fn(), close: vi.fn() };
  }),
  Queue: vi.fn(function () {
    return { add: queueAdd, close: vi.fn() };
  }),
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../db', () => ({ db: { execute: vi.fn() }, withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()) }));

import {
  BUSINESS_CALENDAR_RECOMPUTE_QUEUE,
  RECOMPUTE_CHUNK,
  enqueueBusinessCalendarRecompute,
  initializeBusinessCalendarRecomputeWorker,
  recomputePatch,
  runBusinessCalendarRecompute,
  type RecomputeDeps,
} from './businessCalendarRecomputeWorker';
import { attachWorkerObservability } from './workerObservability';

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `t-${String(from + i).padStart(4, '0')}`);

function fakeDeps(candidates: string[], lockedOnAttempt: (id: string, attempt: number) => boolean): RecomputeDeps & { lockCalls: string[][] } {
  const attempts = new Map<string, number>();
  const lockCalls: string[][] = [];
  return {
    lockCalls,
    listCandidates: vi.fn(async (_cal: string, afterId: string | null, limit: number) =>
      candidates.filter((id) => afterId === null || id > afterId).slice(0, limit)),
    recomputeLocked: vi.fn(async (_cal: string, batch: string[]) => {
      lockCalls.push(batch);
      const locked: string[] = [];
      for (const id of batch) {
        const n = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, n);
        if (lockedOnAttempt(id, n)) locked.push(id);
      }
      return { locked, updated: locked.length };
    }),
  };
}

describe('runBusinessCalendarRecompute (spec §4.5)', () => {
  it('walks the calendar tickets in chunks of 500', async () => {
    expect(RECOMPUTE_CHUNK).toBe(500);
    const deps = fakeDeps(ids(1200), () => true);
    const res = await runBusinessCalendarRecompute('cal-1', deps);
    expect(res).toEqual({ processed: 1200, updated: 1200 });
    expect(deps.lockCalls.map((b) => b.length)).toEqual([500, 500, 200]);
    expect(deps.listCandidates).toHaveBeenCalledWith('cal-1', null, 500);
  });

  it('rows skipped under SKIP LOCKED are retried in the next chunk', async () => {
    // t-0001 is locked by a concurrent writer on its first attempt only.
    const deps = fakeDeps(ids(3), (id, attempt) => id !== 't-0001' || attempt > 1);
    const res = await runBusinessCalendarRecompute('cal-1', deps);
    expect(res.processed).toBe(3);
    expect(deps.lockCalls[0]).toEqual(['t-0000', 't-0001', 't-0002']);
    expect(deps.lockCalls[1]).toEqual(['t-0001']);
  });

  it('a row that stays locked fails the job after bounded retries (BullMQ retries it)', async () => {
    const deps = fakeDeps(ids(2), (id) => id !== 't-0001');
    await expect(runBusinessCalendarRecompute('cal-1', deps)).rejects.toThrow(/still locked/);
  });
});

describe('recomputePatch', () => {
  const ny = {
    revision: { timezone: 'America/New_York', intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday: weekday as 1, startMinute: 540, endMinute: 1020 })) },
    holidays: [] as string[],
  };
  const row = {
    createdAt: new Date('2030-06-03T13:00:00Z'), // Mon 09:00 NY
    responseSlaMinutes: 60, resolutionSlaMinutes: 960,
    slaPausedAt: null, slaPausedBusinessMinutes: 0, firstResponseAt: null, resolvedAt: null, slaBreachReason: null,
    responseDueAt: new Date('2030-06-03T14:00:00Z'), responseWarnAt: new Date('2030-06-03T13:48:00Z'),
    resolutionDueAt: new Date('2030-06-04T21:00:00Z'), resolutionWarnAt: new Date('2030-06-04T17:48:00Z'),
  };

  it('a future holiday moves the unfrozen due later by that day of open minutes', () => {
    const patch = recomputePatch(row, { ...ny, holidays: ['2030-06-04'] });
    // Mon 480 + (Tue is a holiday) + Wed 480 → Wed 17:00 NY.
    expect(patch?.resolutionDueAt).toEqual(new Date('2030-06-05T21:00:00Z'));
  });

  it('writes nothing when no deadline changes', () => {
    expect(recomputePatch(row, ny)).toBeNull();
  });

  it('never touches a frozen arm', () => {
    const patch = recomputePatch({ ...row, firstResponseAt: new Date('2030-06-03T13:30:00Z') }, { ...ny, holidays: ['2030-06-04'] });
    expect(patch).not.toHaveProperty('responseDueAt');
    expect(patch).toHaveProperty('resolutionDueAt');
  });
});

describe('queue and worker wiring', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues a one-shot job on business-calendar-recompute', async () => {
    expect(BUSINESS_CALENDAR_RECOMPUTE_QUEUE).toBe('business-calendar-recompute');
    await enqueueBusinessCalendarRecompute({ calendarId: 'cal-1', reason: 'holiday_added' });
    expect(queueAdd).toHaveBeenCalledWith('recompute', { calendarId: 'cal-1', reason: 'holiday_added' }, expect.not.objectContaining({ repeat: expect.anything() }));
  });

  it('registers the consumer under its readiness name', async () => {
    await initializeBusinessCalendarRecomputeWorker();
    expect(workerCapture.name).toBe('business-calendar-recompute');
    expect(attachWorkerObservability).toHaveBeenCalledWith(expect.anything(), 'businessCalendarRecomputeWorker');
  });
});
