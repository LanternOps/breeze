import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { captureException } from '../services/sentry';
import {
  __resetDeferredWritesForTests,
  deferUntilDatabaseWritable,
  isDeferredUntilWritable,
} from './deferUntilWritable';

function readOnlyError(): Error {
  return Object.assign(new Error('cannot execute INSERT in a read-only transaction'), { code: '25006' });
}

describe('deferUntilDatabaseWritable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    __resetDeferredWritesForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(captureException).mockClear();
  });

  it('retries quietly while the database is read-only and stops once the write succeeds', async () => {
    const task = vi.fn()
      .mockRejectedValueOnce(readOnlyError())
      .mockResolvedValueOnce(undefined);

    deferUntilDatabaseWritable('CisJobs catalog seed', task, { intervalMs: 1_000 });
    expect(isDeferredUntilWritable('CisJobs catalog seed')).toBe(true);
    expect(task).not.toHaveBeenCalled(); // the caller just failed; first retry waits a tick

    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(1);
    expect(isDeferredUntilWritable('CisJobs catalog seed')).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(isDeferredUntilWritable('CisJobs catalog seed')).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('stops and reports a failure that is not a read-only error', async () => {
    const boom = new Error('relation missing');
    const task = vi.fn().mockRejectedValue(boom);

    deferUntilDatabaseWritable('PatchScheduler settings repair', task, { intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(boom, undefined, { area: 'deferred_write_retry' });
    expect(isDeferredUntilWritable('PatchScheduler settings repair')).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting through a connection fault (failover, restart) instead of giving up', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const terminated = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    const task = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(terminated)
      .mockResolvedValueOnce(undefined);
    deferUntilDatabaseWritable('failover', task, { intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(task).toHaveBeenCalledTimes(3);
    expect(isDeferredUntilWritable('failover')).toBe(false);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('logs a reminder every 30 attempts while it waits', async () => {
    const task = vi.fn().mockRejectedValue(readOnlyError());
    deferUntilDatabaseWritable('long wait', task, { intervalMs: 1_000 });
    vi.mocked(console.warn).mockClear();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(console.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('still deferred after 30 attempts'));
  });

  it('keeps one retry per label', async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    deferUntilDatabaseWritable('same', first, { intervalMs: 1_000 });
    deferUntilDatabaseWritable('same', second, { intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('never overlaps two runs of a slow task', async () => {
    let release: () => void = () => {};
    const task = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    deferUntilDatabaseWritable('slow', task, { intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(isDeferredUntilWritable('slow')).toBe(false);
  });
});
