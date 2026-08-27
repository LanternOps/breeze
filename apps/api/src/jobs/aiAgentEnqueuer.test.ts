import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 3.5d-b (#4086) — the producer-side enqueuer, split out of
 * `aiAgentRunner.ts` so it is importable without the BullMQ consumer graph.
 * These `enqueueAgentRunJob` cases are the same coverage that lived in
 * `aiAgentRunner.test.ts` before the split (ported verbatim); the
 * `registerAiAgentEnqueuer` cases are new.
 */

const shared = vi.hoisted(() => {
  const registeredEnqueuers: unknown[] = [];
  return {
    getJobMock: vi.fn(),
    addMock: vi.fn(),
    closeQueueMock: vi.fn(),
    registeredEnqueuers,
    registerAgentRunEnqueuer: vi.fn((enqueuer: unknown) => {
      registeredEnqueuers.push(enqueuer);
    }),
    isRedisAvailable: vi.fn(() => true),
  };
});

vi.mock('bullmq', () => {
  return {
    Queue: class {
      getJob = shared.getJobMock;
      add = shared.addMock;
      close = shared.closeQueueMock;
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

// This suite does not care about runService's real admission-gate logic, only
// that registration reaches it.
vi.mock('../services/aiAgents/runService', () => ({
  registerAgentRunEnqueuer: shared.registerAgentRunEnqueuer,
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import {
  AI_AGENT_QUEUE,
  enqueueAgentRunJob,
  getAiAgentRunJobId,
  registerAiAgentEnqueuer,
} from './aiAgentEnqueuer';
import { registerAgentRunEnqueuer } from '../services/aiAgents/runService';

describe('enqueueAgentRunJob', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    shared.isRedisAvailable.mockReturnValue(true);
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
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

  it('uses the ai-agent queue name', () => {
    expect(AI_AGENT_QUEUE).toBe('ai-agent');
  });
});

describe('registerAiAgentEnqueuer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.registeredEnqueuers.length = 0;
  });

  it('registers enqueueAgentRunJob with the admission gate', () => {
    registerAiAgentEnqueuer();

    expect(registerAgentRunEnqueuer).toBe(shared.registerAgentRunEnqueuer);
    expect(shared.registeredEnqueuers).toEqual([enqueueAgentRunJob]);
  });

  it('is idempotent — a second call just re-registers the same function reference', () => {
    registerAiAgentEnqueuer();
    registerAiAgentEnqueuer();

    expect(shared.registerAgentRunEnqueuer).toHaveBeenCalledTimes(2);
    expect(shared.registeredEnqueuers).toEqual([enqueueAgentRunJob, enqueueAgentRunJob]);
  });
});
