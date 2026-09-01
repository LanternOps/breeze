// apps/api/src/jobs/fixWatchWorker.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const RUN_ID = '00000000-0000-4000-8000-0000000000e1';
const AGENT_ID = '00000000-0000-4000-8000-0000000000e2';
const ORG_ID = '00000000-0000-4000-8000-0000000000e3';
const WATCH_ID = '00000000-0000-4000-8000-0000000000e4';

const shared = vi.hoisted(() => ({
  addMock: vi.fn<(name: string, data: unknown, opts: unknown) => Promise<{ id: string }>>(
    async () => ({ id: 'job-1' })),
  closeQueueMock: vi.fn(async () => undefined),
  workerOnMock: vi.fn(),
  workerCloseMock: vi.fn(async () => undefined),
  captureExceptionMock: vi.fn(),
  createFixWatchRowMock: vi.fn(),
  checkFixWatchPhase1Mock: vi.fn(),
  checkFixWatchPhase2Mock: vi.fn(),
  listPendingWatchesForRecoveryMock: vi.fn(),
  // The Redis side of the recovery sweep: `getJobState` is what actually
  // separates a stranded `pending` watch from a healthy one, and `getJob` +
  // `remove` is what makes a re-add over a TERMINAL job a real enqueue
  // instead of a BullMQ `handleDuplicatedJob` no-op.
  getJobStateMock: vi.fn<(jobId: string) => Promise<string>>(async () => 'unknown'),
  getJobMock: vi.fn<(jobId: string) => Promise<{ remove: () => Promise<void> } | undefined>>(
    async () => undefined),
  removeJobMock: vi.fn(async () => undefined),
  lastWorkerProcessor: undefined as ((job: unknown) => Promise<void>) | undefined,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = shared.addMock;
    close = shared.closeQueueMock;
    getJob = shared.getJobMock;
    getJobState = shared.getJobStateMock;
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<void>) {
      shared.lastWorkerProcessor = processor;
    }
    on = shared.workerOnMock;
    close = shared.workerCloseMock;
  },
  // Real shape (name + message), enough to test the special-cased throw the
  // module header describes — the real class's behavior when caught by a
  // BullMQ Worker is covered by BullMQ's own test suite, not this one's.
  DelayedError: class DelayedError extends Error {
    constructor() {
      super('bullmq:movedToDelayed');
      this.name = 'DelayedError';
    }
  },
  // Thrown by `parseQueueJobData`/`assertQueueJobName` on a malformed job.
  // Without it in the mock, every rejection test below passes on the vitest
  // "no export defined" error instead of on the module's own refusal.
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'UnrecoverableError';
    }
  },
}));

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => ({
    add: shared.addMock,
    close: shared.closeQueueMock,
    getJob: shared.getJobMock,
    getJobState: shared.getJobStateMock,
  })),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/sentry', () => ({ captureException: shared.captureExceptionMock }));

vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

vi.mock('../services/aiAgents/fixWatch', () => ({
  createFixWatchRow: (...args: unknown[]) => shared.createFixWatchRowMock(...args),
  checkFixWatchPhase1: (...args: unknown[]) => shared.checkFixWatchPhase1Mock(...args),
  checkFixWatchPhase2: (...args: unknown[]) => shared.checkFixWatchPhase2Mock(...args),
  listPendingWatchesForRecovery: (...args: unknown[]) => shared.listPendingWatchesForRecoveryMock(...args),
  STRANDED_WATCH_SWEEP_PAGE: 200,
  FIX_HOLD_MINUTES: 60,
}));

import {
  enqueueFixWatchPhase1,
  FIX_WATCH_JOB_NAME,
  FIX_WATCH_QUEUE,
  getFixWatchPhase1JobId,
  getFixWatchPhase2JobId,
  initializeFixWatchWorker,
  PENDING_RECOVERY_MS,
  processFixWatchJob,
  recoverStrandedFixWatches,
  scheduleFixWatch,
  shutdownFixWatchWorker,
} from './fixWatchWorker';

const RUN = { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, alertId: 'alert-1', modeAtStart: 'act' as const };
const OUTCOME = { executedActions: [{ verification: 'passed' as const }] };

beforeEach(() => {
  vi.clearAllMocks();
  shared.createFixWatchRowMock.mockReset();
  shared.checkFixWatchPhase1Mock.mockReset();
  shared.checkFixWatchPhase2Mock.mockReset();
  shared.listPendingWatchesForRecoveryMock.mockReset();
  shared.listPendingWatchesForRecoveryMock.mockResolvedValue([]);
  shared.getJobStateMock.mockReset();
  // No job at all — the lost-enqueue case, so a bare sweep test repairs.
  shared.getJobStateMock.mockResolvedValue('unknown');
  shared.getJobMock.mockReset();
  shared.getJobMock.mockResolvedValue(undefined);
  shared.removeJobMock.mockReset();
  shared.addMock.mockResolvedValue({ id: 'job-1' });
});

describe('jobId helpers — hyphen-only (#1101), one job per (watch, phase)', () => {
  it('phase 1', () => {
    const id = getFixWatchPhase1JobId(WATCH_ID);
    expect(id).toBe(`fix-watch-p1-${WATCH_ID}`);
    expect(id).not.toContain(':');
  });

  it('phase 2', () => {
    const id = getFixWatchPhase2JobId(WATCH_ID);
    expect(id).toBe(`fix-watch-p2-${WATCH_ID}`);
    expect(id).not.toContain(':');
  });
});

describe('scheduleFixWatch', () => {
  it('creates the watch row and enqueues phase 1 with a 5-minute delay and the stable jobId', async () => {
    shared.createFixWatchRowMock.mockResolvedValueOnce(WATCH_ID);

    await expect(scheduleFixWatch(RUN, OUTCOME)).resolves.toBe(WATCH_ID);

    expect(shared.createFixWatchRowMock).toHaveBeenCalledWith(RUN, OUTCOME);
    expect(shared.addMock).toHaveBeenCalledTimes(1);
    const [jobName, data, opts] = shared.addMock.mock.calls[0]!;
    expect(jobName).toBe(FIX_WATCH_JOB_NAME);
    expect(data).toEqual({ phase: 'phase1', watchId: WATCH_ID });
    expect(opts).toMatchObject({
      jobId: `fix-watch-p1-${WATCH_ID}`,
      delay: 5 * 60_000,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    });
  });

  it('does nothing when the run was ineligible / the row already existed (createFixWatchRow returns null)', async () => {
    shared.createFixWatchRowMock.mockResolvedValueOnce(null);

    await expect(scheduleFixWatch(RUN, OUTCOME)).resolves.toBeNull();

    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it('NEVER throws — a scheduling failure must not turn a finished run into a failed one', async () => {
    shared.createFixWatchRowMock.mockRejectedValueOnce(new Error('db unavailable'));

    // Null, because no watch row was ever committed: `finishRun` reads that
    // as "nothing will ever verify this run" and grades the run's executions
    // itself (Task 6). A row that DID commit must not report null — see the
    // next case.
    await expect(scheduleFixWatch(RUN, OUTCOME)).resolves.toBeNull();
  });

  it('returns the watch id even when the ENQUEUE fails — the row is committed, so the recovery sweep still verifies it', async () => {
    shared.createFixWatchRowMock.mockResolvedValueOnce(WATCH_ID);
    shared.addMock.mockRejectedValueOnce(new Error('redis down'));

    // The load-bearing distinction: null means "no watch row exists". A
    // committed row whose enqueue was lost is recovered by
    // `recoverStrandedFixWatches`, so reporting null here would make
    // `finishRun` write a premature `verified` evidence row for an operation
    // a live watch may still grade `recurred` — and the ledger is immutable.
    await expect(scheduleFixWatch(RUN, OUTCOME)).resolves.toBe(WATCH_ID);
    expect(shared.captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueFixWatchPhase1 — the post-commit enqueue intentReleaseWorker uses', () => {
  it('adds the phase-1 job under the same stable jobId scheduleFixWatch uses', async () => {
    await enqueueFixWatchPhase1(WATCH_ID);

    expect(shared.addMock).toHaveBeenCalledTimes(1);
    const [jobName, data, opts] = shared.addMock.mock.calls[0]!;
    expect(jobName).toBe(FIX_WATCH_JOB_NAME);
    expect(data).toEqual({ phase: 'phase1', watchId: WATCH_ID });
    expect(opts).toMatchObject({ jobId: getFixWatchPhase1JobId(WATCH_ID), delay: 5 * 60_000 });
  });

  it('THROWS on failure — the caller decides (the release worker swallows, the sweep retries)', async () => {
    shared.addMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(enqueueFixWatchPhase1(WATCH_ID)).rejects.toThrow('redis down');
  });
});

describe('recoverStrandedFixWatches — the durable-enqueue safety net', () => {
  const OLDER = new Date('2026-09-01T00:00:00.000Z');
  function candidate(id: string) {
    return { id, createdAt: OLDER };
  }
  function page(size: number, prefix = 'w') {
    return Array.from({ length: size }, (_, i) => candidate(`${prefix}-${i}`));
  }

  it('re-enqueues phase 1 for a watch with NO job at all — the lost-enqueue case', async () => {
    shared.listPendingWatchesForRecoveryMock.mockResolvedValueOnce([candidate(WATCH_ID), candidate('watch-2')]);

    await expect(recoverStrandedFixWatches()).resolves.toBe(2);

    expect(shared.listPendingWatchesForRecoveryMock).toHaveBeenCalledWith(PENDING_RECOVERY_MS, null);
    expect(shared.addMock).toHaveBeenCalledTimes(2);
    expect(shared.addMock.mock.calls.map((c) => (c[2] as { jobId: string }).jobId)).toEqual([
      getFixWatchPhase1JobId(WATCH_ID),
      getFixWatchPhase1JobId('watch-2'),
    ]);
    expect(shared.addMock.mock.calls.every((c) => (c[1] as { phase: string }).phase === 'phase1')).toBe(true);
  });

  it.each(['delayed', 'waiting', 'waiting-children', 'prioritized', 'active'])(
    'SKIPS a healthy pending watch whose phase-1 job is %s — it is not stranded, and the count is a repair count',
    async (jobState) => {
      // The load-bearing case: a healthy watch stays `pending` for up to
      // RECOVERY_TIMEOUT_HOURS while phase 1 self-re-delays every 5 minutes,
      // so the DB page is mostly healthy rows. Counting (or re-adding for)
      // them would make the sweep a permanent no-op storm whose reported
      // count means nothing.
      shared.listPendingWatchesForRecoveryMock.mockResolvedValueOnce([candidate(WATCH_ID)]);
      shared.getJobStateMock.mockResolvedValueOnce(jobState);

      await expect(recoverStrandedFixWatches()).resolves.toBe(0);

      expect(shared.getJobStateMock).toHaveBeenCalledWith(getFixWatchPhase1JobId(WATCH_ID));
      expect(shared.addMock).not.toHaveBeenCalled();
      expect(shared.getJobMock).not.toHaveBeenCalled();
    },
  );

  it.each(['failed', 'completed'])(
    'REMOVES a terminal (%s) phase-1 job before re-adding — an add over an existing jobId is a BullMQ no-op',
    async (jobState) => {
      // bullmq 5.81.2 `commands/addStandardJob-9.lua`: an existing jobId key
      // returns via `handleDuplicatedJob` without queueing. `removeOnFail:
      // {count: 500}` keeps that key around, so a watch whose phase-1 job
      // exhausted its attempts would otherwise be "recovered" forever and
      // never actually re-run.
      shared.listPendingWatchesForRecoveryMock.mockResolvedValueOnce([candidate(WATCH_ID)]);
      shared.getJobStateMock.mockResolvedValueOnce(jobState);
      shared.getJobMock.mockResolvedValueOnce({ remove: shared.removeJobMock });

      await expect(recoverStrandedFixWatches()).resolves.toBe(1);

      expect(shared.getJobMock).toHaveBeenCalledWith(getFixWatchPhase1JobId(WATCH_ID));
      expect(shared.removeJobMock).toHaveBeenCalledTimes(1);
      expect(shared.addMock).toHaveBeenCalledTimes(1);
      const removeOrder = shared.removeJobMock.mock.invocationCallOrder[0]!;
      expect(removeOrder).toBeLessThan(shared.addMock.mock.invocationCallOrder[0]!);
    },
  );

  it('counts only the ids that actually produced a new job', async () => {
    shared.listPendingWatchesForRecoveryMock.mockResolvedValueOnce([
      candidate('healthy'), candidate('stranded'), candidate('healthy-2'),
    ]);
    shared.getJobStateMock
      .mockResolvedValueOnce('delayed')
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce('active');

    await expect(recoverStrandedFixWatches()).resolves.toBe(1);

    expect(shared.addMock).toHaveBeenCalledTimes(1);
    expect((shared.addMock.mock.calls[0]![1] as { watchId: string }).watchId).toBe('stranded');
  });

  it('is a no-op when nothing is pending', async () => {
    shared.listPendingWatchesForRecoveryMock.mockResolvedValueOnce([]);

    await expect(recoverStrandedFixWatches()).resolves.toBe(0);
    expect(shared.addMock).not.toHaveBeenCalled();
    expect(shared.getJobStateMock).not.toHaveBeenCalled();
  });

  it('pages past a FULL page instead of re-probing the same oldest slice every tick', async () => {
    // The regression this replaces: one capped, oldest-first slice. A fleet
    // with more concurrently `pending` watches than the page size would hand
    // the sweep the same healthy rows forever, and a newer stranded watch
    // would wait until they aged out (up to RECOVERY_TIMEOUT_HOURS).
    const first = page(200, 'a');
    shared.listPendingWatchesForRecoveryMock
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([candidate('stranded-far-in')]);
    // 200 healthy on page one, one genuinely stranded watch on page two.
    shared.getJobStateMock.mockImplementation(async (jobId: string) =>
      jobId.includes('stranded') ? 'unknown' : 'delayed');

    await expect(recoverStrandedFixWatches()).resolves.toBe(1);

    expect(shared.listPendingWatchesForRecoveryMock).toHaveBeenCalledTimes(2);
    expect(shared.listPendingWatchesForRecoveryMock.mock.calls[0]).toEqual([PENDING_RECOVERY_MS, null]);
    // The second read continues from the LAST row of the first page.
    expect(shared.listPendingWatchesForRecoveryMock.mock.calls[1]).toEqual([
      PENDING_RECOVERY_MS, first[first.length - 1],
    ]);
    expect(shared.addMock).toHaveBeenCalledTimes(1);
  });

  it('defers the rest to the next tick when it hits its page budget, resuming from the cursor', async () => {
    shared.getJobStateMock.mockResolvedValue('delayed');
    shared.listPendingWatchesForRecoveryMock.mockImplementation(async () => page(200, 'a'));

    await expect(recoverStrandedFixWatches()).resolves.toBe(0);
    const firstTickReads = shared.listPendingWatchesForRecoveryMock.mock.calls.length;
    expect(firstTickReads).toBe(25);

    // The next tick must NOT start over at the oldest row — that is exactly
    // the starvation this cursor exists to prevent.
    await recoverStrandedFixWatches();
    const resumed = shared.listPendingWatchesForRecoveryMock.mock.calls[firstTickReads]![1];
    expect(resumed).toEqual(page(200, 'a')[199]);

    await shutdownFixWatchWorker();
  });

  it('shutdown clears the cursor so a fresh process starts from the oldest again', async () => {
    shared.getJobStateMock.mockResolvedValue('delayed');
    shared.listPendingWatchesForRecoveryMock.mockImplementation(async () => page(200, 'a'));
    await recoverStrandedFixWatches();

    await shutdownFixWatchWorker();

    shared.listPendingWatchesForRecoveryMock.mockReset();
    shared.listPendingWatchesForRecoveryMock.mockResolvedValue([]);
    await recoverStrandedFixWatches();
    expect(shared.listPendingWatchesForRecoveryMock.mock.calls[0]).toEqual([PENDING_RECOVERY_MS, null]);
  });

  it('two minutes — far below the coarse-schedule threshold, so it needs no scheduleRegistry slot', () => {
    expect(PENDING_RECOVERY_MS).toBe(2 * 60 * 1000);
  });
});

describe('processFixWatchJob — phase 1 dispatch', () => {
  function job(phase: 'phase1' | 'phase2', overrides: Record<string, unknown> = {}) {
    return {
      id: 'job-1',
      name: FIX_WATCH_JOB_NAME,
      data: { phase, watchId: WATCH_ID },
      moveToDelayed: vi.fn<(timestamp: number, token: string) => Promise<void>>(async () => undefined),
      ...overrides,
    };
  }

  it('recovered -> enqueues phase 2 with a FIX_HOLD_MINUTES delay and the stable jobId', async () => {
    shared.checkFixWatchPhase1Mock.mockResolvedValueOnce({ action: 'recovered' });

    await processFixWatchJob(job('phase1') as never);

    expect(shared.addMock).toHaveBeenCalledTimes(1);
    const [jobName, data, opts] = shared.addMock.mock.calls[0]!;
    expect(jobName).toBe(FIX_WATCH_JOB_NAME);
    expect(data).toEqual({ phase: 'phase2', watchId: WATCH_ID });
    expect(opts).toMatchObject({
      jobId: `fix-watch-p2-${WATCH_ID}`,
      delay: 60 * 60_000,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    });
  });

  it('recovered -> a phase-2 enqueue failure PROPAGATES (unlike scheduleFixWatch) so BullMQ retries this job', async () => {
    shared.checkFixWatchPhase1Mock.mockResolvedValueOnce({ action: 'recovered' });
    shared.addMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(processFixWatchJob(job('phase1') as never)).rejects.toThrow('redis down');
  });

  it('still_pending -> re-delays THIS job under its own lock token, never a second add() under the same jobId', async () => {
    shared.checkFixWatchPhase1Mock.mockResolvedValueOnce({ action: 'still_pending' });
    const theJob = job('phase1');
    const before = Date.now();

    // Throws DelayedError by design — BullMQ's Worker special-cases it (see
    // the module header) so it must never be swallowed here.
    await expect(processFixWatchJob(theJob as never, 'lock-token-1'))
      .rejects.toMatchObject({ name: 'DelayedError' });

    expect(theJob.moveToDelayed).toHaveBeenCalledTimes(1);
    const [timestamp, token] = theJob.moveToDelayed.mock.calls[0]!;
    expect(token).toBe('lock-token-1');
    expect(timestamp).toBeGreaterThanOrEqual(before + 5 * 60_000);
    // NEVER a second add() under the identical stable jobId — that would
    // silently no-op against the still-active job and strand the watch.
    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it('still_pending with no lock token (only reachable via a direct test-harness call) logs and does nothing further', async () => {
    shared.checkFixWatchPhase1Mock.mockResolvedValueOnce({ action: 'still_pending' });
    const theJob = job('phase1');

    await expect(processFixWatchJob(theJob as never)).resolves.toBeUndefined();

    expect(theJob.moveToDelayed).not.toHaveBeenCalled();
    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'timed_out', 'not_found'] as const)(
    '%s is terminal — no further enqueue',
    async (action) => {
      shared.checkFixWatchPhase1Mock.mockResolvedValueOnce({ action });

      await processFixWatchJob(job('phase1') as never);

      expect(shared.addMock).not.toHaveBeenCalled();
    },
  );
});

describe('processFixWatchJob — phase 2 dispatch', () => {
  function job(overrides: Record<string, unknown> = {}) {
    return { id: 'job-2', name: FIX_WATCH_JOB_NAME, data: { phase: 'phase2', watchId: WATCH_ID }, ...overrides };
  }

  it.each(['recurred', 'held_qualified', 'not_found'] as const)(
    'phase 2 is ALWAYS terminal (%s) — never enqueues anything further',
    async (action) => {
      shared.checkFixWatchPhase2Mock.mockResolvedValueOnce({ action });

      await processFixWatchJob(job() as never);

      expect(shared.checkFixWatchPhase2Mock).toHaveBeenCalledWith(WATCH_ID);
      expect(shared.addMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a job with the wrong name rather than silently no-oping', async () => {
    await expect(processFixWatchJob(job({ name: 'wrong-name' }) as never)).rejects.toThrow();
    expect(shared.checkFixWatchPhase2Mock).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload (bad phase) without calling either check function', async () => {
    await expect(processFixWatchJob(job({ data: { phase: 'phase3', watchId: WATCH_ID } }) as never))
      .rejects.toThrow(/Malformed fix-watch job payload/);
    expect(shared.checkFixWatchPhase1Mock).not.toHaveBeenCalled();
    expect(shared.checkFixWatchPhase2Mock).not.toHaveBeenCalled();
  });
});

describe('processFixWatchJob — recover dispatch', () => {
  it("the 'recover' variant rides the SAME queue and job name and runs the sweep", async () => {
    shared.listPendingWatchesForRecoveryMock.mockResolvedValueOnce([
      { id: WATCH_ID, createdAt: new Date('2026-09-01T00:00:00.000Z') },
    ]);

    await processFixWatchJob({ id: 'job-r', name: FIX_WATCH_JOB_NAME, data: { phase: 'recover' } } as never);

    expect(shared.listPendingWatchesForRecoveryMock).toHaveBeenCalledTimes(1);
    expect(shared.checkFixWatchPhase1Mock).not.toHaveBeenCalled();
    expect(shared.checkFixWatchPhase2Mock).not.toHaveBeenCalled();
    expect(shared.addMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a recover payload carrying a watchId — the union is strict, so a stale producer fails loudly', async () => {
    await expect(processFixWatchJob({
      id: 'job-r', name: FIX_WATCH_JOB_NAME, data: { phase: 'recover', watchId: WATCH_ID },
    } as never)).rejects.toThrow(/Malformed fix-watch job payload/);
    expect(shared.listPendingWatchesForRecoveryMock).not.toHaveBeenCalled();
  });

  it('rejects a phase-1 payload with no watchId', async () => {
    await expect(processFixWatchJob({
      id: 'job-1', name: FIX_WATCH_JOB_NAME, data: { phase: 'phase1' },
    } as never)).rejects.toThrow(/Malformed fix-watch job payload/);
    expect(shared.checkFixWatchPhase1Mock).not.toHaveBeenCalled();
  });
});

describe('worker lifecycle', () => {
  it('initialize is idempotent and shutdown closes both the worker and the queue', async () => {
    await initializeFixWatchWorker();
    await initializeFixWatchWorker();

    await shutdownFixWatchWorker();

    expect(shared.workerCloseMock).toHaveBeenCalledTimes(1);
    expect(shared.closeQueueMock).toHaveBeenCalledTimes(1);
  });

  it('registers the recovery sweep as a repeatable on the EXISTING queue and job name', async () => {
    await initializeFixWatchWorker();

    const recoverAdds = shared.addMock.mock.calls.filter(
      (c) => (c[1] as { phase?: string }).phase === 'recover',
    );
    expect(recoverAdds).toHaveLength(1);
    const [jobName, data, opts] = recoverAdds[0]!;
    expect(jobName).toBe(FIX_WATCH_JOB_NAME);
    expect(data).toEqual({ phase: 'recover' });
    expect(opts).toMatchObject({ jobId: 'fix-watch-recover', repeat: { every: PENDING_RECOVERY_MS } });

    await shutdownFixWatchWorker();
  });

  it('a failed repeatable registration never stops the worker from starting', async () => {
    shared.addMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(initializeFixWatchWorker()).resolves.toBeUndefined();

    expect(shared.captureExceptionMock).toHaveBeenCalled();
    expect(shared.lastWorkerProcessor).toBeDefined();

    await shutdownFixWatchWorker();
  });

  it('the constructed worker processes jobs via processFixWatchJob', async () => {
    await initializeFixWatchWorker();

    expect(shared.lastWorkerProcessor).toBeDefined();
    shared.checkFixWatchPhase2Mock.mockResolvedValueOnce({ action: 'held_qualified' });
    await shared.lastWorkerProcessor!({ id: 'job-3', name: FIX_WATCH_JOB_NAME, data: { phase: 'phase2', watchId: WATCH_ID } });
    expect(shared.checkFixWatchPhase2Mock).toHaveBeenCalledWith(WATCH_ID);

    await shutdownFixWatchWorker();
  });
});

describe('queue identity', () => {
  it('has a stable queue name', () => {
    expect(FIX_WATCH_QUEUE).toBe('fix-watch');
  });
});
