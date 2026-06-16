import { EventEmitter } from 'node:events';
import type { Worker } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the sentry service so we can assert capture without an initialized SDK.
vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

// Mock @sentry/node's withScope to a passthrough that invokes the callback
// with a no-op scope, so the `failed` handler's tag/context calls don't throw.
vi.mock('@sentry/node', () => ({
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setTag: vi.fn(), setContext: vi.fn() }),
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
