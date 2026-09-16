import { describe, expect, it, vi } from 'vitest';
import { acquire, DEFAULT_FETCH_LIMIT } from './fetchLimiter';

describe('fetchLimiter', () => {
  it('defaults to six active requests and isolates keys', async () => {
    expect(DEFAULT_FETCH_LIMIT).toBe(6);
    const releases = await Promise.all(Array.from({ length: 6 }, () => acquire('default')));
    const started = vi.fn();
    const queued = acquire('default').then(release => { started(); return release; });
    const independent = await acquire('independent');
    expect(started).not.toHaveBeenCalled();
    releases.shift()!();
    const releaseQueued = await queued;
    expect(started).toHaveBeenCalledOnce();
    releases.forEach(release => release());
    releaseQueued();
    independent();
  });

  it('honours a custom limit and grants queued requests in FIFO order', async () => {
    const release = await acquire('fifo', 1);
    const order: number[] = [];
    const queued = [1, 2, 3].map(index => acquire('fifo', 1).then(nextRelease => {
      order.push(index);
      return nextRelease;
    }));
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    const secondRelease = await queued[0];
    expect(order).toEqual([1]);
    secondRelease();
    const thirdRelease = await queued[1];
    expect(order).toEqual([1, 2]);
    thirdRelease();
    (await queued[2])();
    expect(order).toEqual([1, 2, 3]);
  });

  it('dequeues aborted callers without releasing an active slot', async () => {
    const release = await acquire('abort', 1);
    const controller = new AbortController();
    const cancelled = acquire('abort', 1, controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const started = vi.fn();
    const next = acquire('abort', 1).then(nextRelease => { started(); return nextRelease; });
    controller.abort();
    await rejected;
    expect(started).not.toHaveBeenCalled();
    release();
    (await next)();
    expect(started).toHaveBeenCalledOnce();
  });

  it('rejects already aborted callers without acquiring a slot', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquire('already-aborted', 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    (await acquire('already-aborted', 1))();
  });

  it('keeps an acquired slot until explicit release, even after abort', async () => {
    const controller = new AbortController();
    const release = await acquire('active-abort', 1, controller.signal);
    const started = vi.fn();
    const queued = acquire('active-abort', 1).then(nextRelease => { started(); return nextRelease; });
    controller.abort();
    await Promise.resolve();
    expect(started).not.toHaveBeenCalled();
    release();
    (await queued)();
  });

  it('allows finally to release a slot when the protected operation throws', async () => {
    const operation = async () => {
      const release = await acquire('throws', 1);
      try {
        throw new Error('fetch failed');
      } finally {
        release();
      }
    };
    await expect(operation()).rejects.toThrow('fetch failed');
    (await acquire('throws', 1))();
  });

  it('releases each slot only once', async () => {
    const release = await acquire('idempotent', 1);
    const first = acquire('idempotent', 1);
    const started = vi.fn();
    const second = acquire('idempotent', 1).then(nextRelease => { started(); return nextRelease; });
    release();
    release();
    const nextRelease = await first;
    expect(started).not.toHaveBeenCalled();
    nextRelease();
    (await second)();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid limit %s', async limit => {
    await expect(acquire('invalid', limit)).rejects.toThrow(RangeError);
  });
});
