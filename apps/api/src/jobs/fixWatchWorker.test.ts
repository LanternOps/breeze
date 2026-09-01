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
  lastWorkerProcessor: undefined as ((job: unknown) => Promise<void>) | undefined,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = shared.addMock;
    close = shared.closeQueueMock;
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
}));

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => ({
    add: shared.addMock,
    close: shared.closeQueueMock,
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
  FIX_HOLD_MINUTES: 60,
}));

import {
  FIX_WATCH_JOB_NAME,
  FIX_WATCH_QUEUE,
  getFixWatchPhase1JobId,
  getFixWatchPhase2JobId,
  initializeFixWatchWorker,
  processFixWatchJob,
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

    await scheduleFixWatch(RUN, OUTCOME);

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

    await scheduleFixWatch(RUN, OUTCOME);

    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it('NEVER throws — a scheduling failure must not turn a finished run into a failed one', async () => {
    shared.createFixWatchRowMock.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(scheduleFixWatch(RUN, OUTCOME)).resolves.toBeUndefined();
  });

  it('NEVER throws when the enqueue itself fails (row already committed)', async () => {
    shared.createFixWatchRowMock.mockResolvedValueOnce(WATCH_ID);
    shared.addMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(scheduleFixWatch(RUN, OUTCOME)).resolves.toBeUndefined();
    expect(shared.captureExceptionMock).toHaveBeenCalledTimes(1);
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
    await expect(processFixWatchJob(job({ data: { phase: 'phase3', watchId: WATCH_ID } }) as never)).rejects.toThrow();
    expect(shared.checkFixWatchPhase1Mock).not.toHaveBeenCalled();
    expect(shared.checkFixWatchPhase2Mock).not.toHaveBeenCalled();
  });
});

describe('worker lifecycle', () => {
  it('initialize is idempotent and shutdown closes both the worker and the queue', async () => {
    initializeFixWatchWorker();
    initializeFixWatchWorker();

    // Only an enqueue constructs the queue (lazily); build one to prove
    // shutdown closes it.
    shared.createFixWatchRowMock.mockResolvedValueOnce(WATCH_ID);
    await scheduleFixWatch(RUN, OUTCOME);

    await shutdownFixWatchWorker();

    expect(shared.workerCloseMock).toHaveBeenCalledTimes(1);
    expect(shared.closeQueueMock).toHaveBeenCalledTimes(1);
  });

  it('the constructed worker processes jobs via processFixWatchJob', async () => {
    initializeFixWatchWorker();

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
