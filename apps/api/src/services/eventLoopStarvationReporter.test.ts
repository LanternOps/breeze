import { afterEach, describe, expect, it } from 'vitest';
import { createStarvationReporter, getStarvationCaptureThrottleMs } from './eventLoopStarvationReporter';
import type { EventLoopLagSample } from './eventLoopMonitor';

function sample(maxLagMs: number, atMs = 0): EventLoopLagSample {
  return { atMs, maxLagMs, meanLagMs: maxLagMs / 2 };
}

interface Harness {
  report: ReturnType<typeof createStarvationReporter>;
  warns: string[];
  captures: Array<{ message: string; tags: Record<string, string> }>;
  setNow: (ms: number) => void;
}

function makeReporter(opts: { thresholdMs?: number; throttleMs?: number } = {}): Harness {
  const warns: string[] = [];
  const captures: Array<{ message: string; tags: Record<string, string> }> = [];
  let now = 0;
  const report = createStarvationReporter({
    thresholdMs: () => opts.thresholdMs ?? 1_000,
    throttleMs: () => opts.throttleMs ?? 300_000,
    now: () => now,
    warn: (m) => warns.push(m),
    capture: (message, tags) => captures.push({ message, tags }),
  });
  return { report, warns, captures, setNow: (ms) => { now = ms; } };
}

describe('createStarvationReporter', () => {
  afterEach(() => {
    delete process.env.EVENT_LOOP_STARVATION_THROTTLE_MS;
  });

  it('ignores samples below the threshold', () => {
    const { report, warns, captures } = makeReporter({ thresholdMs: 1_000 });
    report(sample(0));
    report(sample(999));
    expect(warns).toEqual([]);
    expect(captures).toEqual([]);
  });

  it('warns at the threshold and names the CONNECT_TIMEOUT connection', () => {
    const { report, warns } = makeReporter({ thresholdMs: 1_000 });
    report(sample(1_000));

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('[event-loop]');
    expect(warns[0]).toContain('1000ms');
    // The link to CONNECT_TIMEOUT is the payload of this log line: it is what
    // lets whoever reads it connect a starvation warning to the DB errors
    // appearing alongside it.
    expect(warns[0]).toContain('CONNECT_TIMEOUT');
  });

  it('warns on EVERY breaching sample — logs stay complete', () => {
    const { report, warns } = makeReporter();
    for (let i = 0; i < 5; i += 1) report(sample(4_000, i));
    // A stall spans multiple sample intervals. Throttling the log too would
    // hide the stall's duration, which is the one thing the log conveys.
    expect(warns).toHaveLength(5);
  });

  it('throttles the Sentry capture across a burst', () => {
    const { report, warns, captures, setNow } = makeReporter({ throttleMs: 300_000 });

    setNow(0);
    report(sample(4_000));
    setNow(1_000);
    report(sample(4_000));
    setNow(2_000);
    report(sample(4_000));

    expect(warns).toHaveLength(3);
    // One stall must cost one event, not one per second. This repo has twice
    // had an unthrottled recurring warning exhaust the Sentry quota and drop
    // ALL error reporting org-wide (#1894, BREEZE-H).
    expect(captures).toHaveLength(1);
  });

  it('captures again once the throttle window elapses', () => {
    const { report, captures, setNow } = makeReporter({ throttleMs: 300_000 });
    setNow(0);
    report(sample(4_000));
    setNow(299_999);
    report(sample(4_000));
    expect(captures).toHaveLength(1);

    setNow(300_000);
    report(sample(4_000));
    expect(captures).toHaveLength(2);
  });

  it('throttleMs of 0 disables throttling', () => {
    const { report, captures, setNow } = makeReporter({ throttleMs: 0 });
    setNow(0);
    report(sample(4_000));
    report(sample(4_000));
    expect(captures).toHaveLength(2);
  });

  it('tags the capture with a bounded lag bucket, never raw milliseconds', () => {
    const { report, captures } = makeReporter();
    report(sample(7_500));
    expect(captures[0]!.tags).toEqual({ event_loop_lag_bucket: '5s-10s' });
  });

  it('reset() clears throttle state', () => {
    const { report, captures, setNow } = makeReporter({ throttleMs: 300_000 });
    setNow(0);
    report(sample(4_000));
    report.reset();
    report(sample(4_000));
    expect(captures).toHaveLength(2);
  });

  it('works with no capture sink configured (Sentry disabled)', () => {
    const warns: string[] = [];
    const report = createStarvationReporter({
      thresholdMs: () => 1_000,
      warn: (m) => warns.push(m),
    });
    // Self-hosted deployments run without SENTRY_DSN; the console warning is
    // the entire signal there and must not depend on a capture sink existing.
    expect(() => report(sample(9_000))).not.toThrow();
    expect(warns).toHaveLength(1);
  });
});

describe('getStarvationCaptureThrottleMs', () => {
  afterEach(() => {
    delete process.env.EVENT_LOOP_STARVATION_THROTTLE_MS;
  });

  it('defaults to five minutes', () => {
    expect(getStarvationCaptureThrottleMs()).toBe(300_000);
  });

  it('accepts 0 as "never throttle"', () => {
    process.env.EVENT_LOOP_STARVATION_THROTTLE_MS = '0';
    expect(getStarvationCaptureThrottleMs()).toBe(0);
  });

  it('falls back on a negative or unparseable value', () => {
    process.env.EVENT_LOOP_STARVATION_THROTTLE_MS = '-1';
    expect(getStarvationCaptureThrottleMs()).toBe(300_000);
    process.env.EVENT_LOOP_STARVATION_THROTTLE_MS = 'soon';
    expect(getStarvationCaptureThrottleMs()).toBe(300_000);
  });
});
