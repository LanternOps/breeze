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
    registerAgentRunEnqueuer: vi.fn(),
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

// Transitively required by ./aiAgentEnqueuer (imported by aiAgentRunner.ts for
// the re-exported enqueue helpers): this suite does not drag runService's
// whole module graph in for that.
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
  initializeAiAgentRunner,
  shutdownAiAgentRunner,
} from './aiAgentRunner';

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

// `enqueueAgentRunJob`'s own behavior (dedup, CAS-free reuse/removal, no
// inline fallback) is covered in `aiAgentEnqueuer.test.ts` — the module it now
// lives in (wave 3.5d-b, #4086). It is re-exported here and exercised below
// only insofar as the consumer shell touches it (shutdown closing the queue).

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

  it('does NOT construct the worker when the platform kill switch is off (#3977)', () => {
    shared.aiAgentsEnabled = false;

    initializeAiAgentRunner();

    // A BullMQ Worker opens a BLOCKING Redis connection and holds it for the
    // life of the process. Booting one for a feature that can never run costs
    // a permanent connection per process, per region, for nothing.
    expect(shared.workerCalls).toHaveLength(0);
  });

  // Enqueuer registration (module-scope in the pre-3.5d-b design; explicit via
  // `registerAiAgentEnqueuer()` now) is covered in `aiAgentEnqueuer.test.ts` —
  // gating the worker must not disarm the manual-trigger route either way, but
  // that property no longer lives in this file.

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
