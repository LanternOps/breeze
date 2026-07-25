import { EventEmitter } from 'node:events';
import type { Worker } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the sentry service so we can assert capture without an initialized SDK.
vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

// Mock @sentry/node's scope helpers to passthroughs that invoke the callback
// with a recording scope, so tag/context calls don't throw and the tags applied
// around job execution are observable.
const isolationTags: Array<Record<string, unknown>> = [];
vi.mock('@sentry/node', () => ({
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setTag: vi.fn(), setContext: vi.fn() }),
  withIsolationScope: (fn: (scope: unknown) => unknown) => {
    const tags: Record<string, unknown> = {};
    isolationTags.push(tags);
    return fn({
      setTag: (key: string, value: unknown) => {
        tags[key] = value;
      },
      setContext: vi.fn(),
    });
  },
}));

import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';

function makeFakeWorker(): Worker {
  // A bare EventEmitter satisfies the .on(...) surface we exercise.
  return new EventEmitter() as unknown as Worker;
}

describe('attachWorkerObservability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports failed jobs to Sentry with the job error', () => {
    const worker = makeFakeWorker();
    attachWorkerObservability(worker, 'testWorker');

    const err = new Error('boom');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    (worker as unknown as EventEmitter).emit('failed', { id: 'job-1', name: 'doThing' }, err);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(err);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('reports worker-level errors to Sentry', () => {
    const worker = makeFakeWorker();
    attachWorkerObservability(worker, 'testWorker');

    const err = new Error('worker exploded');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    (worker as unknown as EventEmitter).emit('error', err);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(err);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('tolerates a failed event with an undefined job', () => {
    const worker = makeFakeWorker();
    attachWorkerObservability(worker, 'testWorker');

    const err = new Error('no job');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      (worker as unknown as EventEmitter).emit('failed', undefined, err)
    ).not.toThrow();
    expect(captureException).toHaveBeenCalledWith(err);
    consoleSpy.mockRestore();
  });
});

describe('attachWorkerObservability — job execution tagging (BREEZE-9 attribution)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isolationTags.length = 0;
  });

  /**
   * A worker with the BullMQ-shaped `processFn` instance property. `Worker`
   * declares processFn as `Processor`, so the fake is assigned through a
   * loosened shape rather than intersecting with Worker (which would demand the
   * full Processor signature for no added safety here).
   */
  type FakeWorker = Worker & { processFn: (...args: unknown[]) => Promise<unknown> };

  function makeWorkerWithProcessFn(processFn: (...args: unknown[]) => Promise<unknown>): FakeWorker {
    const worker = new EventEmitter() as unknown as FakeWorker;
    (worker as unknown as { processFn: (...args: unknown[]) => Promise<unknown> }).processFn = processFn;
    return worker;
  }

  it('tags worker, jobName and jobId for the duration of the job', async () => {
    // Tags must be visible to code running INSIDE the processor — that is the
    // whole point: the held-context warning is captured mid-job, and previously
    // arrived with an empty `worker` tag (12k unattributable BREEZE-9 events).
    let tagsDuringJob: Record<string, unknown> | undefined;
    const worker = makeWorkerWithProcessFn(async () => {
      tagsDuringJob = { ...isolationTags[isolationTags.length - 1] };
      return 'result';
    });

    attachWorkerObservability(worker, 'metricRollupMaintenance');

    const result = await worker.processFn({ id: 'job-9', name: 'metric-rollup-maintenance' });

    expect(result).toBe('result');
    expect(tagsDuringJob).toEqual({
      worker: 'metricRollupMaintenance',
      jobName: 'metric-rollup-maintenance',
      jobId: 'job-9',
    });
  });

  it('passes the job arguments and `this` through to the original processor', async () => {
    const seen: unknown[] = [];
    const worker = makeWorkerWithProcessFn(async function (this: unknown, ...args: unknown[]) {
      seen.push(...args);
      // `this` must still be the worker: BullMQ's processFn uses instance state.
      expect(this).toBe(worker);
      return 'ok';
    });

    attachWorkerObservability(worker, 'testWorker');
    await worker.processFn({ id: 'j1', name: 'n1' }, 'token-1');

    expect(seen).toEqual([{ id: 'j1', name: 'n1' }, 'token-1']);
  });

  it('propagates a processor rejection unchanged', async () => {
    const boom = new Error('processor failed');
    const worker = makeWorkerWithProcessFn(async () => {
      throw boom;
    });

    attachWorkerObservability(worker, 'testWorker');

    await expect(worker.processFn({ id: 'j1', name: 'n1' })).rejects.toBe(boom);
  });

  it('omits jobName/jobId when the job carries neither, without throwing', async () => {
    const worker = makeWorkerWithProcessFn(async () => 'ok');
    attachWorkerObservability(worker, 'testWorker');

    await worker.processFn(undefined);

    expect(isolationTags[isolationTags.length - 1]).toEqual({ worker: 'testWorker' });
  });

  it('degrades to a warning (never a throw) if BullMQ stops exposing processFn', () => {
    // Guards the monkey-patch: an upgrade that renames the internal must leave
    // workers running, just without attribution.
    const worker = new EventEmitter() as unknown as Worker;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => attachWorkerObservability(worker, 'testWorker')).not.toThrow();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('processFn');

    // The failed-job reporting must still be wired up.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (worker as unknown as EventEmitter).emit('failed', { id: 'j1', name: 'n' }, new Error('x'));
    expect(captureException).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
