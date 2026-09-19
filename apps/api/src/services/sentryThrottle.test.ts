import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttledReporter } from './sentryThrottle';

describe('throttledReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the first occurrence immediately', () => {
    const report = vi.fn();
    throttledReporter(60_000, report)();

    expect(report).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('suppresses everything inside the window and reports the suppressed count on the next one through', () => {
    const report = vi.fn();
    const fire = throttledReporter(60_000, report);

    fire();
    report.mockClear();
    for (let i = 0; i < 500; i += 1) {
      vi.advanceTimersByTime(100);
      fire();
    }

    // 50s of a 60s window: a storm of 500 occurrences ships zero extra events.
    expect(report).not.toHaveBeenCalled();

    vi.advanceTimersByTime(11_000);
    fire();

    expect(report).toHaveBeenCalledExactlyOnceWith(500);
  });

  it('starts a fresh count after each report rather than accumulating forever', () => {
    const report = vi.fn();
    const fire = throttledReporter(1_000, report);

    fire();
    fire();
    vi.advanceTimersByTime(1_000);
    fire();
    vi.advanceTimersByTime(1_000);
    fire();

    expect(report.mock.calls.map(([n]) => n)).toEqual([0, 1, 0]);
  });

  it('gives each reporter its own independent window', () => {
    const a = vi.fn();
    const b = vi.fn();
    const fireA = throttledReporter(60_000, a);
    const fireB = throttledReporter(60_000, b);

    fireA();
    fireA();
    fireB();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
