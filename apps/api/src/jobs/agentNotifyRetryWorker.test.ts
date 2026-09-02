import { beforeEach, describe, expect, it, vi } from 'vitest';

const RUN_ID = '00000000-0000-4000-8000-0000000000f1';

const shared = vi.hoisted(() => ({
  addMock: vi.fn<(name: string, data: unknown, opts: unknown) => Promise<{ id: string }>>(
    async () => ({ id: 'job-1' })),
  closeQueueMock: vi.fn(async () => undefined),
  workerOnMock: vi.fn(),
  workerCloseMock: vi.fn(async () => undefined),
  captureExceptionMock: vi.fn(),
  deliverRunFinishedNotificationsMock: vi.fn(async () => undefined),
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
}));

vi.mock('../services/bullmqQueue', () => ({
  // The real createInstrumentedQueue wraps a real bullmq Queue with the #1105
  // tripwire — covered by bullmqQueue's own tests, not this suite's concern.
  // A lightweight fake exposing just what this worker calls is enough here.
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

vi.mock('../services/aiAgents/runFinishedNotify', () => ({
  deliverRunFinishedNotifications: shared.deliverRunFinishedNotificationsMock,
}));

import {
  AGENT_NOTIFY_RETRY_JOB_NAME,
  AGENT_NOTIFY_RETRY_QUEUE,
  enqueueAgentNotifyRetry,
  getAgentNotifyRetryJobId,
  initializeAgentNotifyRetryWorker,
  processAgentNotifyRetryJob,
  shutdownAgentNotifyRetryWorker,
} from './agentNotifyRetryWorker';

beforeEach(() => {
  vi.clearAllMocks();
  shared.deliverRunFinishedNotificationsMock.mockResolvedValue(undefined);
});

describe('getAgentNotifyRetryJobId', () => {
  it('is hyphen-only (repo rule #1101) and one job per run', () => {
    const id = getAgentNotifyRetryJobId(RUN_ID);
    expect(id).toBe(`agent-notify-${RUN_ID}`);
    expect(id).not.toContain(':');
  });
});

describe('enqueueAgentNotifyRetry', () => {
  it('adds a job with 5 attempts, exponential backoff starting 30s, and the stable jobId', async () => {
    await enqueueAgentNotifyRetry(RUN_ID);

    expect(shared.addMock).toHaveBeenCalledTimes(1);
    const [jobName, data, opts] = shared.addMock.mock.calls[0]!;
    expect(jobName).toBe(AGENT_NOTIFY_RETRY_JOB_NAME);
    expect(data).toEqual({ runId: RUN_ID });
    expect(opts).toMatchObject({
      jobId: `agent-notify-${RUN_ID}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    });
  });

  it('NEVER throws — a second failure on top of an already-failed notify must not surface', async () => {
    shared.addMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(enqueueAgentNotifyRetry(RUN_ID)).resolves.toBeUndefined();

    expect(shared.captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});

describe('processAgentNotifyRetryJob', () => {
  function job(overrides: Record<string, unknown> = {}) {
    return { id: 'job-1', name: AGENT_NOTIFY_RETRY_JOB_NAME, data: { runId: RUN_ID }, ...overrides };
  }

  it('calls deliverRunFinishedNotifications with the run id from the job payload', async () => {
    await processAgentNotifyRetryJob(job() as never);

    expect(shared.deliverRunFinishedNotificationsMock).toHaveBeenCalledWith(RUN_ID);
  });

  it('lets a repeat failure PROPAGATE so BullMQ applies its own attempts/backoff', async () => {
    shared.deliverRunFinishedNotificationsMock.mockRejectedValueOnce(new Error('still down'));

    await expect(processAgentNotifyRetryJob(job() as never)).rejects.toThrow('still down');
  });

  it('rejects a job with the wrong name rather than silently no-oping', async () => {
    await expect(processAgentNotifyRetryJob(job({ name: 'wrong-name' }) as never)).rejects.toThrow();
    expect(shared.deliverRunFinishedNotificationsMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload (missing runId) without calling the notify body', async () => {
    await expect(processAgentNotifyRetryJob(job({ data: {} }) as never)).rejects.toThrow();
    expect(shared.deliverRunFinishedNotificationsMock).not.toHaveBeenCalled();
  });
});

describe('worker lifecycle', () => {
  it('initialize is idempotent and shutdown closes both the worker and the queue', async () => {
    initializeAgentNotifyRetryWorker();
    initializeAgentNotifyRetryWorker();

    // Only enqueueAgentNotifyRetry constructs the queue (lazily); the worker's
    // own construction doesn't touch it, so build one to prove shutdown closes it.
    await enqueueAgentNotifyRetry(RUN_ID);

    await shutdownAgentNotifyRetryWorker();

    expect(shared.workerCloseMock).toHaveBeenCalledTimes(1);
    expect(shared.closeQueueMock).toHaveBeenCalledTimes(1);
  });

  it('the constructed worker processes jobs via processAgentNotifyRetryJob', async () => {
    initializeAgentNotifyRetryWorker();

    expect(shared.lastWorkerProcessor).toBeDefined();
    await shared.lastWorkerProcessor!(job());
    expect(shared.deliverRunFinishedNotificationsMock).toHaveBeenCalledWith(RUN_ID);

    await shutdownAgentNotifyRetryWorker();
  });

  function job(overrides: Record<string, unknown> = {}) {
    return { id: 'job-2', name: AGENT_NOTIFY_RETRY_JOB_NAME, data: { runId: RUN_ID }, ...overrides };
  }
});

describe('queue identity', () => {
  it('has a stable queue name', () => {
    expect(AGENT_NOTIFY_RETRY_QUEUE).toBe('agent-notify-retry');
  });
});
