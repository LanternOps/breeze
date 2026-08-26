import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 3c — the `ai-agent` queue + worker shell.
 *
 * The run loop itself is NOT under test here (see
 * `services/aiAgents/runLoop.test.ts`); the processor is asserted only to
 * validate its payload and delegate to `executeAgentRun`.
 */

const shared = vi.hoisted(() => {
  const executeAgentRun = vi.fn(async (_runId: string) => undefined);
  // Recorded OUTSIDE the mock's call log: registration happens once at module
  // import, long before any beforeEach `vi.clearAllMocks()` runs.
  const registeredEnqueuers: unknown[] = [];
  return {
    getJobMock: vi.fn(),
    addMock: vi.fn(),
    closeQueueMock: vi.fn(),
    closeWorkerMock: vi.fn(),
    onMock: vi.fn(),
    workerCalls: [] as Array<{
      name: string;
      processor: (job: unknown) => Promise<unknown>;
      opts: Record<string, unknown>;
    }>,
    registeredEnqueuers,
    registerAgentRunEnqueuer: vi.fn((enqueuer: unknown) => {
      registeredEnqueuers.push(enqueuer);
    }),
    aiAgentsEnabled: true,
    attachWorkerObservability: vi.fn(),
    isRedisAvailable: vi.fn(() => true),
    executeAgentRun,
  };
});

vi.mock('bullmq', () => {
  class UnrecoverableError extends Error {}
  return {
    UnrecoverableError,
    Job: class {},
    Queue: class {
      getJob = shared.getJobMock;
      add = shared.addMock;
      close = shared.closeQueueMock;
    },
    Worker: class {
      on = shared.onMock;
      close = shared.closeWorkerMock;
      constructor(
        name: string,
        processor: (job: unknown) => Promise<unknown>,
        opts: Record<string, unknown>,
      ) {
        shared.workerCalls.push({ name, processor, opts });
      }
    },
  };
});

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({})),
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
  isRedisAvailable: shared.isRedisAvailable,
}));

// The runner registers its enqueuer with the admission gate at MODULE SCOPE so
// a process that never boots the worker (the manual-trigger route) can still
// enqueue. Mocked so this suite does not drag runService's whole module graph in.
vi.mock('../services/aiAgents/runService', () => ({
  registerAgentRunEnqueuer: shared.registerAgentRunEnqueuer,
}));

// The loop lives in a service module so it is testable without BullMQ/Redis;
// this suite only cares that the processor reaches it.
vi.mock('../services/aiAgents/runLoop', () => ({
  executeAgentRun: shared.executeAgentRun,
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: shared.attachWorkerObservability,
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// The platform kill switch. A const evaluated at import time in the real
// module, so it is mocked here rather than stubbed through the environment.
vi.mock('../config/env', () => ({
  get AI_AGENTS_ENABLED() { return shared.aiAgentsEnabled; },
}));

import { parseQueueJobData } from '../services/bullmqValidation';
import { aiAgentQueueJobDataSchema } from './queueSchemas';
import {
  AI_AGENT_QUEUE,
  AI_AGENT_RUN_JOB_NAME,
  enqueueAgentRunJob,
  executeAgentRun,
  getAiAgentRunJobId,
  initializeAiAgentRunner,
  shutdownAiAgentRunner,
} from './aiAgentRunner';
import { registerAgentRunEnqueuer } from '../services/aiAgents/runService';

function fakeJob(data: unknown, name = AI_AGENT_RUN_JOB_NAME) {
  return { id: 'job-1', name, data };
}

describe('ai-agent queue job schema', () => {
  it('round-trips an execute-agent-run payload through parseQueueJobData', () => {
    const parsed = parseQueueJobData(
      AI_AGENT_QUEUE,
      fakeJob({ type: 'execute-agent-run', runId: 'run-1' }),
      aiAgentQueueJobDataSchema,
    );
    expect(parsed).toEqual({ type: 'execute-agent-run', runId: 'run-1' });
  });

  it('dead-letters an unknown job type', () => {
    expect(() => parseQueueJobData(
      AI_AGENT_QUEUE,
      fakeJob({ type: 'execute-something-else', runId: 'run-1' }),
      aiAgentQueueJobDataSchema,
    )).toThrow();
  });

  it('dead-letters an empty runId', () => {
    expect(() => parseQueueJobData(
      AI_AGENT_QUEUE,
      fakeJob({ type: 'execute-agent-run', runId: '' }),
      aiAgentQueueJobDataSchema,
    )).toThrow();
  });

  it('dead-letters unknown extra keys (strict payload)', () => {
    expect(() => parseQueueJobData(
      AI_AGENT_QUEUE,
      fakeJob({ type: 'execute-agent-run', runId: 'run-1', orgId: 'org-1' }),
      aiAgentQueueJobDataSchema,
    )).toThrow();
  });
});

describe('enqueueAgentRunJob', () => {
  beforeEach(async () => {
    shared.workerCalls.length = 0;
    vi.clearAllMocks();
    shared.isRedisAvailable.mockReturnValue(true);
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownAiAgentRunner();
  });

  it('adds a durable, stable-jobId job with no retries', async () => {
    const result = await enqueueAgentRunJob('run-1');

    expect(result).toEqual({ enqueued: true, jobId: 'queue-job-1' });
    expect(shared.addMock).toHaveBeenCalledWith(
      'execute-agent-run',
      { type: 'execute-agent-run', runId: 'run-1' },
      expect.objectContaining({
        jobId: 'ai-agent-run-run-1',
        attempts: 1,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      }),
    );
    // #1101: BullMQ rejects a custom jobId whose ':'-split length !== 3.
    expect(getAiAgentRunJobId('run-1')).not.toContain(':');
  });

  it('never sets a backoff/retry policy — a crashed run must not silently re-run tools', async () => {
    await enqueueAgentRunJob('run-1');
    const opts = shared.addMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.attempts).toBe(1);
    expect(opts.backoff).toBeUndefined();
  });

  it('reuses an already-queued job for the same run id instead of double-enqueueing', async () => {
    shared.getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('delayed'),
      remove: vi.fn(),
    });

    const result = await enqueueAgentRunJob('run-1');

    expect(result).toEqual({ enqueued: true, jobId: 'existing-job' });
    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it('removes a terminal leftover job before re-adding', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    shared.getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('completed'),
      remove,
    });

    const result = await enqueueAgentRunJob('run-1');

    expect(remove).toHaveBeenCalled();
    expect(shared.addMock).toHaveBeenCalledTimes(1);
    expect(result.enqueued).toBe(true);
  });

  it('refuses to enqueue when Redis is down, without touching the queue', async () => {
    shared.isRedisAvailable.mockReturnValue(false);

    const result = await enqueueAgentRunJob('run-1');

    expect(result).toEqual({ enqueued: false });
    expect(shared.getJobMock).not.toHaveBeenCalled();
    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it('has NO inline fallback: an enqueue failure never defers the run in-process', async () => {
    // The automation worker answers a dead queue by scheduling
    // `setImmediate(executeRunInline)`. An agent run must NOT: a headless run
    // with no durability guarantee is worse than a skipped one, so the only
    // outcome is `{enqueued:false}` and a `failed` run row the human re-triggers.
    const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');
    shared.addMock.mockRejectedValue(new Error('redis exploded'));

    const result = await enqueueAgentRunJob('run-1');

    expect(result).toEqual({ enqueued: false });
    expect(setImmediateSpy).not.toHaveBeenCalled();
    setImmediateSpy.mockRestore();
  });

  it('refuses a malformed runId without touching the queue', async () => {
    const result = await enqueueAgentRunJob('');

    expect(result).toEqual({ enqueued: false });
    expect(shared.addMock).not.toHaveBeenCalled();
  });
});

describe('ai-agent runner bootstrap', () => {
  beforeEach(async () => {
    shared.workerCalls.length = 0;
    vi.clearAllMocks();
    shared.isRedisAvailable.mockReturnValue(true);
    shared.aiAgentsEnabled = true;
    await shutdownAiAgentRunner();
    shared.workerCalls.length = 0;
    shared.closeWorkerMock.mockClear();
    shared.closeQueueMock.mockClear();
  });

  it('registers its enqueuer with the admission gate at module scope', () => {
    // Must NOT be deferred to initializeAiAgentRunner(): the manual-trigger
    // route has to be able to enqueue in a process that never boots the worker.
    expect(registerAgentRunEnqueuer).toBe(shared.registerAgentRunEnqueuer);
    expect(shared.registeredEnqueuers).toContain(enqueueAgentRunJob);
  });

  it('does NOT construct the worker when the platform kill switch is off (#3977)', () => {
    shared.aiAgentsEnabled = false;

    initializeAiAgentRunner();

    // A BullMQ Worker opens a BLOCKING Redis connection and holds it for the
    // life of the process. Booting one for a feature that can never run costs
    // a permanent connection per process, per region, for nothing.
    expect(shared.workerCalls).toHaveLength(0);
  });

  it('still registers the enqueuer when the kill switch is off', () => {
    shared.aiAgentsEnabled = false;

    initializeAiAgentRunner();

    // The enqueuer is module-scope, not part of worker boot: gating the worker
    // must not also disarm the manual-trigger route's ability to enqueue.
    expect(shared.registeredEnqueuers).toContain(enqueueAgentRunJob);
  });

  it('constructs the worker with the agent-run concurrency and lock settings', () => {
    initializeAiAgentRunner();

    expect(shared.workerCalls).toHaveLength(1);
    const call = shared.workerCalls[0]!;
    expect(call.name).toBe('ai-agent');
    expect(call.opts).toMatchObject({
      concurrency: 2,
      lockDuration: 720_000,
      stalledInterval: 60_000,
      maxStalledCount: 1,
    });
    expect(shared.attachWorkerObservability).toHaveBeenCalled();
  });

  it('processor validates the payload and delegates to executeAgentRun', async () => {
    initializeAiAgentRunner();
    const { processor } = shared.workerCalls[0]!;

    await processor(fakeJob({ type: 'execute-agent-run', runId: 'run-9' }));
    expect(shared.executeAgentRun).toHaveBeenCalledWith('run-9');

    // Wrong BullMQ job name is dead-lettered before the payload is even read.
    await expect(
      processor(fakeJob({ type: 'execute-agent-run', runId: 'run-9' }, 'something-else')),
    ).rejects.toThrow();

    await expect(
      processor(fakeJob({ type: 'execute-agent-run' })),
    ).rejects.toThrow();

    // Neither malformed delivery reached the loop.
    expect(shared.executeAgentRun).toHaveBeenCalledTimes(1);
  });

  it('closes worker and queue on shutdown', async () => {
    initializeAiAgentRunner();
    await enqueueAgentRunJob('run-1');

    await shutdownAiAgentRunner();

    expect(shared.closeWorkerMock).toHaveBeenCalled();
    expect(shared.closeQueueMock).toHaveBeenCalled();
  });

  it('re-exports the run loop so the processor and the module contract stay one function', async () => {
    // The loop is defined in services/aiAgents/runLoop.ts; this file re-exports
    // it so callers (and the plan's contract) still see `executeAgentRun` here.
    await executeAgentRun('run-1');
    expect(shared.executeAgentRun).toHaveBeenCalledWith('run-1');
  });
});
