import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCancellableRequest } from './cancellableRequest';

describe('createCancellableRequest', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('cancel() aborts the signal and marks the request cancelled', () => {
    const request = createCancellableRequest(1_000);
    expect(request.signal.aborted).toBe(false);
    request.cancel();
    expect(request.signal.aborted).toBe(true);
    expect(request.cancelled).toBe(true);
  });

  // A caller-supplied signal replaces fetchWithAuth's own 30s ceiling, so the
  // request must still time out on its own — as a failure, not a cancellation.
  it('aborts with a TimeoutError when the ceiling elapses, without marking it cancelled', () => {
    const request = createCancellableRequest(1_000);
    vi.advanceTimersByTime(1_000);
    expect(request.signal.aborted).toBe(true);
    expect((request.signal.reason as DOMException).name).toBe('TimeoutError');
    expect(request.cancelled).toBe(false);
  });

  it('settle() stops the timeout from firing', () => {
    const request = createCancellableRequest(1_000);
    request.settle();
    vi.advanceTimersByTime(5_000);
    expect(request.signal.aborted).toBe(false);
  });
});
